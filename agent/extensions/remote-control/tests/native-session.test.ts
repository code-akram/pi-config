import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import remoteControl from "../index.ts";
import { TEST_TOKEN, deferred, fixture, until } from "./helpers.ts";

test("real Pi session consumes steer before followUp using only a fake local stream", async () => {
  const f = await fixture();
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-rc-native-"));
  const previousUrl = process.env.PI_RC_URL; const previousToken = process.env.PI_RC_TOKEN;
  process.env.PI_RC_URL = f.url; process.env.PI_RC_TOKEN = TEST_TOKEN;
  const gate = deferred();
  let session: AgentSession | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(dir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
    await modelRuntime.setRuntimeApiKey("openai", "test-only-not-a-real-api-key");
    const model = getModel("openai", "gpt-4.1");
    assert.ok(model);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [remoteControl], systemPrompt: "Local deterministic test only." });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model,
      resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(dir), noTools: "builtin", thinkingLevel: "off" }));
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    let calls = 0;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const call = ++calls;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: `local-answer-${call}` }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      void (async () => {
        if (call === 1) await gate.promise;
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      })();
      return stream;
    };
    await session.prompt("/remote-control");
    assert.equal(session.getActiveToolNames().includes("remote_control"), true);
    const sender = await f.client("planner");
    const target = (await sender.client.list()).find((p) => p.id !== sender.client.peer.id)!;
    const prompting = session.prompt("hold the first turn");
    await until(() => calls === 1 && session!.isStreaming);
    const queued = await sender.client.send({ to: target.id, text: "queue-marker", delivery: "queue" });
    const steered = await sender.client.send({ to: target.id, text: "steer-marker", delivery: "steer" });
    const sql = await f.sql();
    await until(async () => (await sql.exec("SELECT payload FROM messages WHERE id IN (?, ?)", queued.id, steered.id))
      .every((row) => row.payload === null));
    assert.equal(calls, 1); // ACK isn't execution: both messages are in native queues.
    gate.resolve();
    await prompting;
    await session.waitForIdle();
    assert.equal(calls, 3);
    const received = session.messages.filter((m) => m.role === "custom" && m.customType === "remote-control");
    assert.equal(received.length, 2);
    assert.ok(JSON.stringify(received[0]).includes("steer-marker"));
    assert.ok(JSON.stringify(received[1]).includes("queue-marker"));
    assert.deepEqual(errors, []);
    await session.prompt("/remote-control");
    assert.equal(session.getActiveToolNames().includes("remote_control"), false);
    // SDK disposal invalidates contexts without an asynchronous shutdown event.
    // A late transport callback must self-clean rather than throw/reconnect.
    await session.prompt("/remote-control");
    session.dispose(); session = undefined;
    await f.evict("close");
    await until(() => sender.states.includes("reconnecting") && sender.client.connected);
    await until(async () => (await sender.client.list()).length === 1);
  } finally {
    gate.resolve();
    if (session) {
      // Toggle is the extension's normal cleanup path even if an assertion failed.
      if (session.getActiveToolNames().includes("remote_control")) await session.prompt("/remote-control").catch(() => {});
      session.dispose();
    }
    if (previousUrl === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = previousUrl;
    if (previousToken === undefined) delete process.env.PI_RC_TOKEN; else process.env.PI_RC_TOKEN = previousToken;
    await f.dispose(); await rm(dir, { recursive: true, force: true });
  }
});
