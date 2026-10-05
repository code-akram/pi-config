import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { AUTH_PREFIX, MAX_FRAME_BYTES, PING, PONG, PROTOCOL, byteLength, type ClientFrame } from "../shared/protocol.ts";
import { TEST_TOKEN, deferred, fixture, until } from "./helpers.ts";

function sendFrame(to: string, patch: Partial<Extract<ClientFrame, { type: "send" }>> = {}): Extract<ClientFrame, { type: "send" }> {
  return { type: "send", id: randomUUID(), requestId: randomUUID(), to, text: "task", delivery: "queue", reply: "none", ttlSeconds: 600, ...patch };
}

test("relay authenticates upgrades and exposes no private data over HTTP", async () => {
  const f = await fixture();
  try {
    const health = await fetch(new URL("/health", f.origin));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "pi-remote-control", protocol: PROTOCOL });
    assert.equal((await fetch(new URL("/connect", f.origin))).status, 426);
    const missing = await f.mf.dispatchFetch("http://localhost/connect", { headers: { Upgrade: "websocket" } });
    assert.equal(missing.status, 401);
    const wrong = await f.mf.dispatchFetch("http://localhost/connect", { headers: {
      Upgrade: "websocket", "Sec-WebSocket-Protocol": `${PROTOCOL}, ${AUTH_PREFIX}${"b".repeat(64)}`,
    } });
    assert.equal(wrong.status, 401);
    const browser = await f.mf.dispatchFetch("http://localhost/connect", { headers: {
      Upgrade: "websocket", Origin: "https://evil.example", "Sec-WebSocket-Protocol": `${PROTOCOL}, ${AUTH_PREFIX}${TEST_TOKEN}`,
    } });
    assert.equal(browser.status, 403);
  } finally { await f.dispose(); }
});

test("native Node WebSockets discover sessions and reject ambiguous names", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner");
    const b = await f.client("worker");
    const c = await f.client("worker");
    const peers = await a.client.list();
    assert.equal(peers.length, 3);
    await assert.rejects(a.client.send({ to: "worker", text: "task" }), /Ambiguous/);
    await assert.rejects(a.client.send({ to: a.client.peer.id, text: "task" }), /yourself/);
    await c.client.rename("reviewer");
    assert.equal((await a.client.list()).find((p) => p.id === c.client.peer.id)?.name, "reviewer");
    await a.client.send({ to: b.client.peer.id, text: "targeted" });
    await until(() => b.messages.length === 1);
    assert.equal(c.messages.length, 0);
  } finally { await f.dispose(); }
});

test("steer and queue survive the wire without hard-aborting any session", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    await a.client.send({ to: "worker", text: "first", delivery: "steer", reply: "none" });
    await a.client.send({ to: "worker", text: "second", delivery: "queue", reply: "optional" });
    await until(() => b.messages.length === 2);
    assert.deepEqual(b.messages.map((m) => [m.text, m.delivery, m.reply]), [["first", "steer", "none"], ["second", "queue", "optional"]]);
    assert.equal(b.messages[0].from.id, a.client.peer.id);
  } finally { await f.dispose(); }
});

test("explicit correlated reply resolves wait and does not inject an extra sender turn", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    const sending = a.client.send({ to: "worker", text: "compute", reply: "required", wait: true });
    await until(() => b.messages.length === 1);
    const original = b.messages[0];
    await b.client.replyTo(original.id, "answer");
    const result = await sending;
    assert.equal(result.response?.text, "answer");
    assert.equal(result.response?.inReplyTo, original.id);
    assert.equal(result.response?.reply, "none");
    assert.equal(a.messages.length, 0);
    await assert.rejects(b.client.replyTo(original.id, "again"), /No unresolved/);
  } finally { await f.dispose(); }
});

test("nonblocking replies re-enter the sender with correlation and no reply loop", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    const result = await a.client.send({ to: "worker", text: "compute", reply: "required" });
    await until(() => b.messages.length === 1);
    await b.client.replyTo(result.id, "done");
    await until(() => a.messages.length === 1);
    assert.equal(a.messages[0].inReplyTo, result.id);
    assert.equal(a.messages[0].reply, "none");
    assert.equal(a.messages[0].delivery, "queue");
    assert.equal(a.client.pending().outgoing[0].state, "replied");
  } finally { await f.dispose(); }
});

test("reply before original ACK keeps the replied state", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner");
    let b: Awaited<ReturnType<typeof f.client>>;
    b = await f.client("worker", async (message) => { await b.client.replyTo(message.id, "fast answer"); });
    const result = await a.client.send({ to: "worker", text: "question", reply: "required", wait: true });
    assert.equal(result.state, "replied");
    const sql = await f.sql();
    await until(async () => (await sql.exec("SELECT payload FROM messages WHERE id = ?", result.id))[0].payload === null);
    assert.equal(a.client.pending().outgoing[0].state, "replied");
  } finally { await f.dispose(); }
});

test("abort stops waiting, not remote work; a late reply is still delivered", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    const controller = new AbortController();
    const sending = a.client.send({ to: "worker", text: "question", reply: "required", wait: true, signal: controller.signal });
    await until(() => b.messages.length === 1);
    controller.abort();
    await assert.rejects(sending, /aborted/);
    assert.equal(b.client.pending().incoming.length, 1);
    await b.client.replyTo(b.messages[0].id, "answer after abort");
    await until(() => a.messages.length === 1);
    assert.equal(a.messages[0].text, "answer after abort");
  } finally { await f.dispose(); }
});

test("normal offline sends fail; reply policy none cannot be replied to", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    await assert.rejects(a.client.send({ to: randomUUID(), text: "offline" }), /offline/);
    const result = await a.client.send({ to: "worker", text: "notification", reply: "none" });
    await until(() => b.messages.length === 1);
    await assert.rejects(b.client.replyTo(result.id, "ack"), /No unresolved/);
    assert.equal(b.client.pending().incoming.length, 0);
  } finally { await f.dispose(); }
});

test("ACK erases payload while a short-lived tombstone preserves correlation", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    const result = await a.client.send({ to: "worker", text: "private-body", reply: "required" });
    const sql = await f.sql();
    await until(async () => {
      const rows = await sql.exec("SELECT payload, state FROM messages WHERE id = ?", result.id);
      return rows[0]?.payload === null && rows[0]?.state === "handed-to-pi";
    });
    const rows = await sql.exec("SELECT * FROM messages WHERE id = ?", result.id);
    assert.equal(JSON.stringify(rows).includes("private-body"), false);
    assert.equal(JSON.stringify(rows).includes(TEST_TOKEN), false);
    assert.equal(rows[0].recipient, b.client.peer.id);
  } finally { await f.dispose(); }
});

test("forged ACK/reply and duplicate-ID mutations cannot steal a message", async () => {
  const f = await fixture();
  try {
    const a = await f.raw("planner"); const b = await f.raw("worker"); const c = await f.raw("intruder");
    const frame = sendFrame(b.peer.id, { reply: "required" });
    assert.equal((await a.result(frame)).ok, true);
    await until(() => b.frames.some((v) => v.type === "message" && v.message.id === frame.id));
    c.send({ type: "ack", id: frame.id, state: "handed-to-pi" });
    const forged = await c.result(sendFrame(a.peer.id, { inReplyTo: frame.id }));
    assert.equal(forged.ok, false);
    const sql = await f.sql();
    assert.notEqual((await sql.exec("SELECT payload FROM messages WHERE id = ?", frame.id))[0].payload, null);
    const duplicate = await a.result({ ...frame, requestId: randomUUID() });
    assert.equal(duplicate.ok, true);
    assert.equal(b.frames.filter((v) => v.type === "message" && v.message.id === frame.id).length, 1);
    const altered = await a.result({ ...frame, requestId: randomUUID(), text: "mutated" });
    assert.equal(altered.ok, false);
    const wrongTarget = await b.result(sendFrame(c.peer.id, { inReplyTo: frame.id }));
    assert.equal(wrongTarget.ok, false);
    assert.equal((await b.result(sendFrame(a.peer.id, { inReplyTo: frame.id, text: "legitimate" }))).ok, true);
    assert.equal((await b.result(sendFrame(a.peer.id, { inReplyTo: frame.id, text: "second" }))).ok, false);
  } finally { await f.dispose(); }
});

test("relay rejects a boundary-size payload that would overflow the delivery envelope", async () => {
  const f = await fixture();
  try {
    const a = await f.raw("planner"); const b = await f.raw("worker");
    const frame = sendFrame(b.peer.id, { text: "" });
    const overhead = byteLength(JSON.stringify(frame));
    frame.text = "\n".repeat(Math.floor((MAX_FRAME_BYTES - overhead - 1) / 2)) + "x";
    assert.ok(byteLength(JSON.stringify(frame)) <= MAX_FRAME_BYTES);
    const result = await a.result(frame);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Encoded delivery/);
    assert.equal(a.socket.readyState, WebSocket.OPEN);
  } finally { await f.dispose(); }
});

test("hibernation preserves connected roster and routing via socket attachments", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    await f.evict("hibernate");
    assert.equal(a.client.connected, true); assert.equal(b.client.connected, true);
    assert.equal((await a.client.list()).length, 2);
    await a.client.send({ to: b.client.peer.id, text: "after wake" });
    await until(() => b.messages.length === 1);
    assert.equal(b.messages[0].text, "after wake");
  } finally { await f.dispose(); }
});

test("transport restart replays unacked delivery without reinjecting a held message", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    const a = await f.client("planner"); const b = await f.client("worker", () => gate.promise);
    const result = await a.client.send({ to: "worker", text: "held" });
    await until(() => b.messages.length === 1);
    await f.evict("close");
    await until(() => a.states.includes("reconnecting") && b.states.includes("reconnecting"));
    await until(() => a.client.connected && b.client.connected);
    assert.equal((await a.client.list()).length, 2);
    gate.resolve();
    const sql = await f.sql();
    await until(async () => (await sql.exec("SELECT payload FROM messages WHERE id = ?", result.id))[0]?.payload === null);
    assert.equal(b.messages.length, 1);
  } finally { gate.resolve(); await f.dispose(); }
});

test("reply can wait briefly for original sender to reconnect", async () => {
  const f = await fixture();
  try {
    const a = await f.raw("planner"); const b = await f.client("worker");
    const frame = sendFrame(b.client.peer.id, { reply: "required" });
    assert.equal((await a.result(frame)).ok, true);
    await until(() => b.messages.length === 1);
    a.close();
    await until(async () => (await b.client.list()).length === 1);
    const reply = await b.client.replyTo(frame.id, "late response");
    const reconnected = await f.raw("planner", a.peer.id);
    await until(() => reconnected.frames.some((v) => v.type === "message" && v.message.id === reply.id));
  } finally { await f.dispose(); }
});

test("expiry alarm removes ledger and empty bus storage, then schema recreates", async () => {
  const f = await fixture();
  try {
    const a = await f.raw("planner"); const b = await f.raw("worker");
    const frame = sendFrame(b.peer.id);
    assert.equal((await a.result(frame)).ok, true);
    const sql = await f.sql();
    await sql.exec("UPDATE messages SET expires = ? WHERE id = ?", Date.now() - 1, frame.id);
    await f.alarm();
    assert.equal((await sql.exec("SELECT COUNT(*) AS n FROM messages"))[0].n, 0);
    await until(() => a.frames.some((v) => v.type === "receipt" && v.id === frame.id && v.state === "expired"));
    a.close(); b.close();
    await delay(100);
    await f.alarm();
    assert.equal((await sql.exec("SELECT name FROM sqlite_master WHERE name = 'messages'")).length, 0);
    const c = await f.client("new-session");
    assert.equal((await c.client.list()).length, 1);
  } finally { await f.dispose(); }
});

test("heartbeat auto-response works across hibernation", async () => {
  const f = await fixture();
  try {
    const a = await f.raw("planner");
    await f.evict("hibernate");
    const pong = deferred();
    const handler = (event: MessageEvent) => { if (event.data === PONG) pong.resolve(); };
    a.socket.addEventListener("message", handler);
    a.socket.send(PING);
    await until(async () => Promise.race([pong.promise.then(() => true), delay(5).then(() => false)]));
    a.socket.removeEventListener("message", handler);
  } finally { await f.dispose(); }
});

test("bad local arguments do not poison a healthy connection and stop suppresses reconnect", async () => {
  const f = await fixture();
  try {
    const a = await f.client("planner"); const b = await f.client("worker");
    await assert.rejects(a.client.send({ to: "worker", text: "", ttlSeconds: 600 }), /Invalid/);
    assert.equal(a.client.connected, true);
    b.client.stop();
    await until(async () => (await a.client.list()).length === 1);
    await f.evict("close");
    await until(() => a.states.includes("reconnecting"));
    await until(() => a.client.connected);
    await delay(100);
    assert.equal(b.client.connected, false);
    assert.equal((await a.client.list()).length, 1);
  } finally { await f.dispose(); }
});
