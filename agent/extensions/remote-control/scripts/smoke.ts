// Live relay check using only the private relay credential, never a Cloudflare
// deployment token. Synthetic peers only: no Pi/LLM runs and no shell execution.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RelayClient } from "../client.ts";
import { loadConfig } from "../config.ts";

const config = await loadConfig();
const origin = new URL(config.url);
origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
origin.pathname = "/health";
const health = await fetch(origin, { signal: AbortSignal.timeout(15_000) });
assert.equal(health.status, 200, `Health check returned HTTP ${health.status}`);
assert.equal((await health.json()).protocol, "pi-rc-v1");
let a: RelayClient | undefined;
let b: RelayClient | undefined;
let steered = false;
let unexpectedReplies = 0;
try {
  a = new RelayClient({ url: config.url, token: config.token,
    peer: { id: randomUUID(), name: "rc-smoke-a" }, onState: () => {},
    onMessage: (message) => { if (message.from.id === b?.peer.id) unexpectedReplies++; } });
  b = new RelayClient({ url: config.url, token: config.token,
    peer: { id: randomUUID(), name: "rc-smoke-b" }, onState: () => {},
    onMessage: async (message) => {
      if (message.from.id !== a?.peer.id) return;
      if (message.text === "rc smoke steer" && message.delivery === "steer" && message.reply === "none") steered = true;
      if (message.text === "rc smoke request" && message.reply === "required") await b!.replyTo(message.id, "rc smoke response");
    } });
  await a.start(); await b.start();
  assert.ok((await a.list()).some((peer) => peer.id === b!.peer.id), "Peer discovery failed");
  await a.send({ to: b.peer.id, text: "rc smoke steer", delivery: "steer", reply: "none", ttlSeconds: 30 });
  const result = await a.send({ to: b.peer.id, text: "rc smoke request", delivery: "queue", reply: "required",
    wait: true, timeoutMs: 15_000, ttlSeconds: 30 });
  assert.equal(result.response?.text, "rc smoke response");
  assert.equal(result.response?.inReplyTo, result.id);
  assert.equal(result.state, "replied");
  assert.equal(steered, true, "Steering delivery failed");
  assert.equal(unexpectedReplies, 0, "Waiting reply was delivered twice");
  console.log("LIVE PASS: HTTPS health, authenticated WSS, discovery, steer/queue, correlated reply.");
} finally { a?.stop(); b?.stop(); }
