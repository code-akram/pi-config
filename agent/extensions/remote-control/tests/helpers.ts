import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { RelayClient, type ClientOptions, type ConnectionState } from "../client.ts";
import { AUTH_PREFIX, PONG, PROTOCOL, parseServerFrame, type ClientFrame, type Envelope, type Peer, type ServerFrame } from "../shared/protocol.ts";

export const TEST_TOKEN = "a".repeat(64);
export async function until(predicate: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await delay(10);
  }
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function fixture() {
  const mf = new Miniflare({ ...convertV4MiniflareOptions({
    name: "pi-rc-test", host: "127.0.0.1", port: 0,
    modules: [
      { type: "ESModule", path: fileURLToPath(new URL("./fixture-worker.mjs", import.meta.url)) },
      { type: "ESModule", path: fileURLToPath(new URL("../.build/index.js", import.meta.url)) },
    ],
    compatibilityDate: "2026-10-05", bindings: { RC_TOKEN: TEST_TOKEN },
    durableObjects: { RC_RELAY: { className: "TestRelay", useSQLite: true } },
  }), telemetry: { enabled: false }, unsafeInspectDurableObjects: true,
  });
  let origin: URL;
  try { origin = await mf.ready; } catch (error) { await mf.dispose(); throw error; }
  const url = new URL("/connect", origin); url.protocol = "ws:";
  const clients: RelayClient[] = [];
  const raws: RawPeer[] = [];
  return {
    mf, origin, url: url.toString(),
    async client(name: string, onMessage?: ClientOptions["onMessage"]) {
      const messages: Envelope[] = [];
      const errors: string[] = [];
      const states: ConnectionState[] = [];
      const client = new RelayClient({ url: url.toString(), token: TEST_TOKEN, peer: { id: randomUUID(), name },
        reconnectDelayMs: 30, onState: (state) => states.push(state), onError: (message) => errors.push(message),
        onMessage: async (message) => { messages.push(message); await onMessage?.(message); } });
      clients.push(client);
      await client.start();
      return { client, messages, errors, states };
    },
    async raw(name: string, peerId: string = randomUUID()) {
      const raw = new RawPeer(url.toString(), { id: peerId, name });
      raws.push(raw); await raw.ready;
      return raw;
    },
    async sql() { return mf.unsafeGetDurableObjectStorage("pi-rc-test", "TestRelay", { name: "private-owner" }); },
    async alarm() {
      const ns = await mf.getDurableObjectNamespace("RC_RELAY");
      const stub = ns.get(ns.idFromName("private-owner"));
      const response = await stub.fetch("http://internal/__test/alarm");
      if (response.status !== 200) throw new Error("Alarm test control failed");
    },
    async evict(webSockets: "hibernate" | "close" = "hibernate") {
      await mf.unsafeEvictDurableObject("pi-rc-test", "TestRelay", { name: "private-owner", webSockets });
    },
    async dispose() {
      for (const client of clients) client.stop();
      for (const raw of raws) raw.close();
      await mf.dispose();
    },
  };
}
export class RawPeer {
  socket: WebSocket;
  peer: Peer;
  frames: ServerFrame[] = [];
  ready: Promise<void>;
  constructor(url: string, peer: Peer) {
    this.peer = peer;
    this.socket = new WebSocket(url, [PROTOCOL, AUTH_PREFIX + TEST_TOKEN]);
    this.socket.addEventListener("open", () => this.send({ type: "hello", peer }));
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("message", (event) => {
        if (event.data === PONG) return;
        const frame = parseServerFrame(event.data as string);
        this.frames.push(frame);
        if (frame.type === "welcome") resolve();
      });
      this.socket.addEventListener("error", () => reject(new Error("Raw socket failed")));
    });
  }
  send(frame: ClientFrame) { this.socket.send(JSON.stringify(frame)); }
  async result(frame: Extract<ClientFrame, { requestId: string }>) {
    this.send(frame);
    await until(() => this.frames.some((f) => f.type === "result" && f.requestId === frame.requestId));
    return this.frames.find((f) => f.type === "result" && f.requestId === frame.requestId) as Extract<ServerFrame, { type: "result" }>;
  }
  close() { try { this.socket.close(); } catch { /* Cleanup. */ } }
}
