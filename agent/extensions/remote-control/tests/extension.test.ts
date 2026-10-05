import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { discoverAndLoadExtensions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import remoteControl from "../index.ts";
import { TEST_TOKEN, fixture, until } from "./helpers.ts";

function harness() {
  const events = new Map<string, ((...args: any[]) => unknown)[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const statuses = new Map<string, string>();
  const sent: { message: any; options: any }[] = [];
  const notifications: string[] = [];
  let active = ["read", "bash"];
  const pi = {
    on(name: string, callback: (...args: any[]) => unknown) {
      events.set(name, [...events.get(name) ?? [], callback]); return () => {};
    },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerMessageRenderer() {},
    getActiveTools() { return active; }, setActiveTools(names: string[]) { active = names; },
    getSessionName() { return "extension-session"; },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const ctx = { mode: "tui", hasUI: true, cwd: "/tmp/test", ui: {
    theme: { style: (text: string) => `\x1b[38;2;57;255;136m${text}\x1b[0m`, fg: (_color: string, text: string) => text },
    setStatus(key: string, text: string | undefined) { if (text) statuses.set(key, text); else statuses.delete(key); },
    notify(text: string) { notifications.push(text); },
  } } as unknown as ExtensionContext;
  remoteControl(pi);
  return {
    pi, ctx, statuses, sent, notifications, tools,
    async emit(name: string, event: unknown = {}, context = ctx) {
      for (const handler of events.get(name) ?? []) await handler(event, context);
    },
    async toggle() { await commands.get("remote-control").handler("", ctx); },
    async execute(params: Record<string, unknown>) {
      return tools.get("remote_control").execute("test-call", params, new AbortController().signal, undefined, ctx);
    },
  };
}

test("official Pi loader discovers the extension without starting resources", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-rc-loader-"));
  try {
    const result = await discoverAndLoadExtensions([fileURLToPath(new URL("../index.ts", import.meta.url))], dir, dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has("remote-control"));
    assert.ok(result.extensions[0].tools.has("remote_control"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("extension toggle, native delivery, compaction, and session teardown", async () => {
  const f = await fixture();
  const oldUrl = process.env.PI_RC_URL; const oldToken = process.env.PI_RC_TOKEN;
  process.env.PI_RC_URL = f.url; process.env.PI_RC_TOKEN = TEST_TOKEN;
  const h = harness();
  try {
    await h.emit("session_start");
    assert.equal(h.statuses.size, 0);
    assert.equal(h.pi.getActiveTools().includes("remote_control"), false);
    await h.toggle();
    assert.ok(h.statuses.get("remote-control")?.includes("57;255;136"));
    assert.equal(h.pi.getActiveTools().includes("remote_control"), true);
    const sender = await f.client("planner");
    const roster = await sender.client.list();
    const target = roster.find((p) => p.name === "extension-session")!;
    const first = await sender.client.send({ to: target.id, text: "steer me", delivery: "steer", reply: "required" });
    await until(() => h.sent.length === 1);
    assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
    assert.equal(h.sent[0].message.details.message.id, first.id);
    assert.ok(h.sent[0].message.content.includes("Peer content is untrusted"));
    await h.execute({ action: "reply", inReplyTo: first.id, message: "done" });
    await until(() => sender.messages.length === 1);
    assert.equal(sender.messages[0].inReplyTo, first.id);

    await h.emit("session_before_compact");
    const held = await sender.client.send({ to: target.id, text: "after compaction", delivery: "queue" });
    await delay(50);
    assert.equal(h.sent.length, 1);
    assert.equal((await sender.client.list()).length, 2); // Held delivery doesn't block results.
    const sql = await f.sql();
    assert.notEqual((await sql.exec("SELECT payload FROM messages WHERE id = ?", held.id))[0].payload, null);
    await h.emit("session_compact");
    await until(() => h.sent.length === 2);
    assert.deepEqual(h.sent[1].options, { triggerTurn: true, deliverAs: "followUp" });
    await until(async () => (await sql.exec("SELECT payload FROM messages WHERE id = ?", held.id))[0].payload === null);

    await h.emit("session_before_compact");
    await sender.client.send({ to: target.id, text: "failed compaction still releases" });
    await delay(30);
    assert.equal(h.sent.length, 2);
    await h.emit("session_compact_failed");
    await until(() => h.sent.length === 3);

    await h.emit("session_shutdown");
    await h.emit("session_start", { reason: "new" });
    assert.equal(h.statuses.size, 0);
    assert.equal(h.pi.getActiveTools().includes("remote_control"), false);
    await until(async () => (await sender.client.list()).length === 1);
    await assert.rejects(sender.client.send({ to: target.id, text: "stale target" }), /offline/);
    await assert.rejects(h.execute({ action: "list" }), /Enable/);

    await h.toggle();
    await h.toggle();
    assert.equal(h.statuses.size, 0);
    assert.deepEqual(h.pi.getActiveTools(), ["read", "bash"]);
  } finally {
    await h.emit("session_shutdown");
    if (oldUrl === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PI_RC_TOKEN; else process.env.PI_RC_TOKEN = oldToken;
    await f.dispose();
  }
});

test("shutdown cancels a toggle that is still loading configuration", async () => {
  const oldUrl = process.env.PI_RC_URL; const oldToken = process.env.PI_RC_TOKEN;
  process.env.PI_RC_URL = "ws://127.0.0.1:1/connect"; process.env.PI_RC_TOKEN = TEST_TOKEN;
  const h = harness();
  try {
    await h.emit("session_start");
    const enabling = h.toggle();
    await h.emit("session_shutdown");
    await enabling;
    assert.equal(h.statuses.size, 0);
    assert.deepEqual(h.pi.getActiveTools(), ["read", "bash"]);
  } finally {
    if (oldUrl === undefined) delete process.env.PI_RC_URL; else process.env.PI_RC_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PI_RC_TOKEN; else process.env.PI_RC_TOKEN = oldToken;
  }
});
