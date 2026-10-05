import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { loadConfig, validateConfig } from "../config.ts";
import { MAX_TEXT_BYTES, parseClientFrame, parseServerFrame, safeDisplay, validName } from "../shared/protocol.ts";

const token = "a".repeat(64); // Test-only dummy credential.
const send = () => ({ type: "send", requestId: randomUUID(), id: randomUUID(), to: "worker", text: "hello",
  delivery: "queue", reply: "none", ttlSeconds: 600 });

test("validates client frames and defaults are represented explicitly", () => {
  const frame = send();
  assert.deepEqual(parseClientFrame(JSON.stringify(frame)), frame);
  for (const patch of [ { delivery: "abort" }, { reply: "broadcast" }, { ttlSeconds: 0 }, { ttlSeconds: 901 },
    { to: "" }, { text: "" }, { text: "💚".repeat(MAX_TEXT_BYTES / 2) }, { id: "not-an-id" },
    { inReplyTo: randomUUID(), reply: "required" } ]) {
    assert.throws(() => parseClientFrame(JSON.stringify({ ...frame, ...patch })));
  }
  assert.throws(() => parseClientFrame("null"));
  assert.throws(() => parseClientFrame("{"));
});

test("validates server envelope lifetimes and IDs", () => {
  const now = Date.now();
  const message = { id: randomUUID(), from: { id: randomUUID(), name: "planner" }, to: randomUUID(),
    text: "task", delivery: "steer", reply: "optional", createdAt: now, expiresAt: now + 10_000 };
  assert.equal(parseServerFrame(JSON.stringify({ type: "message", message })).type, "message");
  assert.throws(() => parseServerFrame(JSON.stringify({ type: "message", message: { ...message, expiresAt: now - 1 } })));
  assert.throws(() => parseServerFrame(JSON.stringify({ type: "message", message: { ...message, expiresAt: now + 901_000 } })));
});

test("names and literal rendering cannot contain terminal/bidi controls", () => {
  assert.equal(validName("planner"), true);
  assert.equal(validName("\x1b[31mplanner"), false);
  assert.equal(validName("x\u202ey"), false);
  assert.equal(safeDisplay("\x1b[31mhello\x1b[0m\x1b]52;c;evil\x07\u202e\nworld"), "hello\nworld");
});

test("config enforces TLS, token format and credential-free URLs", () => {
  assert.equal(validateConfig({ url: "https://relay.example", token }).url, "wss://relay.example/connect");
  assert.equal(validateConfig({ url: "http://127.0.0.1:8787", token }).url, "ws://127.0.0.1:8787/connect");
  for (const url of ["http://relay.example", "wss://user:pass@relay.example", "wss://relay.example?token=x", "wss://relay.example/#secret", "wss://relay.example/other", "file:///tmp/x"]) {
    assert.throws(() => validateConfig({ url, token }));
  }
  assert.throws(() => validateConfig({ url: "https://relay.example", token: "short" }));
});

test("config rejects partial env overrides and parses no secret into errors", async () => {
  await assert.rejects(loadConfig({ PI_RC_URL: "https://relay.example" }), /Set both/);
  await assert.rejects(loadConfig({ PI_RC_TOKEN: token }), /Set both/);
  assert.equal((await loadConfig({ PI_RC_URL: "https://relay.example", PI_RC_TOKEN: token })).token, token);
});

test("private config requires restrictive permissions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-rc-config-"));
  try {
    const file = path.join(dir, "config.json");
    await writeFile(file, JSON.stringify({ url: "https://relay.example", token }), { mode: 0o600 });
    assert.equal((await loadConfig({}, file)).url, "wss://relay.example/connect");
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      await assert.rejects(loadConfig({}, file), /chmod 600/);
    }
    await chmod(file, 0o600);
    await writeFile(file, `{\"token\":\"${token}\",`);
    await assert.rejects(loadConfig({}, file), (error: Error) => !error.message.includes(token));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
