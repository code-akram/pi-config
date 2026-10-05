import { randomUUID } from "node:crypto";
import {
  AUTH_PREFIX, DEFAULT_TTL_SECONDS, MAX_FRAME_BYTES, MAX_INBOX, PING, PONG, PROTOCOL,
  byteLength, isRecord, parseClientFrame, parsePeers, parseServerFrame, validName,
  type AckState, type ClientFrame, type Delivery, type Envelope, type Peer, type ReplyPolicy,
} from "./shared/protocol.ts";

export type ConnectionState = "off" | "connecting" | "connected" | "reconnecting";
export interface ClientOptions {
  url: string;
  token: string;
  peer: Peer;
  onState: (state: ConnectionState) => void;
  onMessage: (message: Envelope) => Promise<void> | void;
  onError?: (message: string) => void;
  isLive?: () => boolean; // Local-only liveness check; never wakes the DO.
  reconnectDelayMs?: number; // Tests can shorten delays; production uses jittered backoff.
}
export interface SendOptions {
  to: string;
  text: string;
  delivery?: Delivery;
  reply?: ReplyPolicy;
  ttlSeconds?: number;
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  inReplyTo?: string;
}
export interface SendResult { id: string; to: string; state: string; expiresAt: number; response?: Envelope }
interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; dispose: () => void }
interface Waiter { resolve: (message: Envelope) => void; reject: (error: Error) => void; dispose: () => void }
interface Outgoing { id: string; to: string; reply: ReplyPolicy; state: string; expiresAt: number }

export class RelayClient {
  private options: ClientOptions;
  private socket?: WebSocket;
  private running = false;
  private generation = 0;
  private attempts = 0;
  private state: ConnectionState = "off";
  private retryTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private awaitingPongAt = 0;
  private startWait?: { resolve: () => void; reject: (error: Error) => void };
  private requests = new Map<string, PendingRequest>();
  private waiters = new Map<string, Waiter>();
  private seen = new Map<string, { expiresAt: number; state: AckState }>();
  private delivering = new Set<string>();
  private incoming = new Map<string, Envelope>();
  private outgoing = new Map<string, Outgoing>();

  constructor(options: ClientOptions) {
    parseClientFrame(JSON.stringify({ type: "hello", peer: options.peer }));
    this.options = options;
  }
  get connected(): boolean { return this.state === "connected"; }
  get peer(): Peer { return this.options.peer; }

  start(): Promise<void> {
    if (this.running) return Promise.reject(new Error("Already enabled"));
    this.running = true;
    return new Promise((resolve, reject) => {
      this.startWait = { resolve, reject };
      this.connect();
    });
  }
  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    try { socket?.close(1000, "Remote control disabled"); } catch { /* May still be dialing. */ }
    this.startWait?.reject(new Error("Remote control disabled"));
    this.startWait = undefined;
    this.rejectRequests("Remote control disabled");
    for (const waiter of this.waiters.values()) { waiter.dispose(); waiter.reject(new Error("Remote control disabled")); }
    this.waiters.clear();
    this.incoming.clear();
    this.outgoing.clear();
    this.seen.clear();
    this.delivering.clear();
    this.setState("off");
  }
  private setState(state: ConnectionState): void { this.state = state; this.options.onState(state); }
  private clearTimers(): void {
    clearTimeout(this.retryTimer); clearTimeout(this.connectTimer); clearInterval(this.heartbeat);
    this.retryTimer = this.connectTimer = this.heartbeat = undefined;
  }
  private connect(): void {
    if (!this.running) return;
    const generation = ++this.generation;
    this.setState(this.attempts ? "reconnecting" : "connecting");
    if (!this.running || this.generation !== generation) return;
    let socket: WebSocket;
    try { socket = new WebSocket(this.options.url, [PROTOCOL, AUTH_PREFIX + this.options.token]); }
    catch { this.lost(generation); return; }
    this.socket = socket;
    const live = () => this.running && this.generation === generation && this.socket === socket;
    this.connectTimer = setTimeout(() => {
      if (!live()) return;
      try { socket.close(); } catch { /* Dialing. */ }
      this.lost(generation);
    }, 10_000);
    this.connectTimer.unref();
    socket.addEventListener("open", () => {
      if (!live()) return;
      socket.send(JSON.stringify({ type: "hello", peer: this.options.peer } satisfies ClientFrame));
    });
    socket.addEventListener("message", (event) => {
      if (!live()) return;
      if (event.data === PONG) { this.awaitingPongAt = 0; return; }
      try {
        if (typeof event.data !== "string") throw new Error("Text frames required");
        const frame = parseServerFrame(event.data);
        if (frame.type === "welcome") {
          if (this.connected || frame.peer.id !== this.peer.id) throw new Error("Invalid welcome");
          clearTimeout(this.connectTimer);
          this.options.peer = frame.peer;
          this.attempts = 0;
          this.setState("connected");
          if (!live()) return;
          this.startWait?.resolve(); this.startWait = undefined;
          this.startHeartbeat(generation);
        } else if (!this.connected) {
          throw new Error("Server did not complete registration");
        } else if (frame.type === "result") {
          const pending = this.requests.get(frame.requestId);
          if (pending) {
            this.requests.delete(frame.requestId); pending.dispose();
            if (frame.ok) pending.resolve(frame.data); else pending.reject(new Error(frame.error));
          }
        } else if (frame.type === "message") {
          // A held delivery must not block processing request results or replies.
          void this.receive(frame.message).catch(() => this.options.onError?.("Could not hand a remote message to Pi"));
        } else if (frame.type === "receipt") {
          const outgoing = this.outgoing.get(frame.id);
          if (outgoing && outgoing.state !== "replied") outgoing.state = frame.state;
          if (frame.state === "rejected" || frame.state === "expired") {
            const waiter = this.waiters.get(frame.id);
            if (waiter) {
              this.waiters.delete(frame.id); waiter.dispose();
              waiter.reject(new Error(`Remote message ${frame.state}`));
            }
          }
        } else if (frame.type === "error") this.options.onError?.(frame.error);
      } catch {
        this.options.onError?.("Invalid relay response; connection closed");
        try { socket.close(1008, "Invalid relay response"); } catch { /* Already closing. */ }
        this.lost(generation);
      }
    });
    socket.addEventListener("close", (event) => {
      if (!live()) return;
      if (event.code === 4009) {
        this.options.onError?.("This connection was replaced; toggle remote control off and on");
        this.stop();
      } else this.lost(generation);
    });
    socket.addEventListener("error", () => { if (live()) this.lost(generation); });
  }
  private lost(generation: number): void {
    if (!this.running || generation !== this.generation) return;
    this.generation++;
    this.clearTimers();
    const socket = this.socket;
    this.socket = undefined;
    try { socket?.close(); } catch { /* Dialing or disconnected. */ }
    this.rejectRequests("Relay disconnected; accepted work may still run. Do not blindly retry.");
    this.startWait?.reject(new Error("Relay connection failed; reconnecting in the background"));
    this.startWait = undefined;
    const reconnectGeneration = this.generation;
    this.setState("reconnecting");
    if (!this.running || this.generation !== reconnectGeneration) return;
    const delay = this.options.reconnectDelayMs ?? Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts, 5)) * (0.8 + Math.random() * 0.4);
    this.attempts++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref();
  }
  private startHeartbeat(generation: number): void {
    this.awaitingPongAt = 0;
    this.heartbeat = setInterval(() => {
      if (generation !== this.generation || !this.connected) return;
      if (this.options.isLive?.() === false) { this.stop(); return; }
      if (this.awaitingPongAt && Date.now() - this.awaitingPongAt > 90_000) { this.lost(generation); return; }
      if (!this.awaitingPongAt) {
        this.awaitingPongAt = Date.now();
        try { this.socket?.send(PING); } catch { this.lost(generation); }
      }
      this.prune();
    }, 45_000);
    this.heartbeat.unref();
  }
  private rejectRequests(message: string): void {
    for (const pending of this.requests.values()) { pending.dispose(); pending.reject(new Error(message)); }
    this.requests.clear();
  }
  private wire(frame: ClientFrame): void {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new Error("Remote control is not connected");
    const encoded = JSON.stringify(frame);
    if (byteLength(encoded) > MAX_FRAME_BYTES) throw new Error("Encoded message exceeds the frame size limit");
    parseClientFrame(encoded); // Invalid tool arguments must not tear down a healthy connection.
    this.socket.send(encoded);
  }
  private request(frame: Extract<ClientFrame, { requestId: string }>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("Operation aborted before sending"));
    if (this.requests.size >= 64) return Promise.reject(new Error("Too many pending relay requests"));
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        const pending = this.requests.get(frame.requestId);
        if (!pending) return;
        this.requests.delete(frame.requestId); pending.dispose(); reject(new Error(message));
      };
      const timer = setTimeout(() => fail("Relay response timed out; delivery may have occurred"), 10_000);
      timer.unref();
      const abort = () => fail("Wait aborted; delivery may have occurred");
      signal?.addEventListener("abort", abort, { once: true });
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.requests.set(frame.requestId, { resolve, reject, dispose });
      try { this.wire(frame); } catch (error) { fail(error instanceof Error ? error.message : "Send failed"); }
    });
  }

  async list(signal?: AbortSignal): Promise<Peer[]> {
    return parsePeers(await this.request({ type: "list", requestId: randomUUID() }, signal));
  }
  async rename(name: string): Promise<void> {
    if (!validName(name)) throw new Error("Invalid session name");
    this.options.peer = { ...this.peer, name: name.trim() };
    if (this.connected) await this.request({ type: "rename", requestId: randomUUID(), name });
  }
  pending(): { incoming: Envelope[]; outgoing: Outgoing[] } {
    this.prune();
    return { incoming: [...this.incoming.values()], outgoing: [...this.outgoing.values()] };
  }
  async replyTo(inReplyTo: string, text: string, signal?: AbortSignal): Promise<SendResult> {
    this.prune();
    const original = this.incoming.get(inReplyTo);
    if (!original) throw new Error("No unresolved inbound message with that ID; use pending to inspect messages");
    const result = await this.send({ to: original.from.id, text, delivery: "queue", reply: "none", inReplyTo, signal,
      ttlSeconds: DEFAULT_TTL_SECONDS });
    this.incoming.delete(inReplyTo);
    return result;
  }
  async send(options: SendOptions): Promise<SendResult> {
    this.prune();
    if (this.outgoing.size >= 256) throw new Error("Too many retained outgoing messages; wait for expiry");
    const messageId = randomUUID();
    const policy = options.reply ?? "none";
    if (options.wait && policy !== "required") throw new Error("wait requires reply: required");
    const timeout = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 180_000) throw new Error("timeoutMs must be between 1000 and 180000");
    let response: Promise<Envelope> | undefined;
    if (options.wait) {
      response = new Promise((resolve, reject) => {
        const fail = (message: string) => {
          const waiter = this.waiters.get(messageId);
          if (!waiter) return;
          this.waiters.delete(messageId); waiter.dispose(); reject(new Error(message));
        };
        const timer = setTimeout(() => fail("Reply timed out; timeout does not cancel remote work"), timeout);
        timer.unref();
        const abort = () => fail("Reply wait aborted; remote work is not cancelled");
        options.signal?.addEventListener("abort", abort, { once: true });
        this.waiters.set(messageId, { resolve, reject,
          dispose: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); } });
      });
      // A wait can reject before the relay acknowledges the send.
      void response.catch(() => {});
    }
    try {
      const data = await this.request({ type: "send", requestId: randomUUID(), id: messageId,
        to: options.to, text: options.text, delivery: options.delivery ?? "queue", reply: policy,
        ttlSeconds: options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
        ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}) }, options.signal);
      if (!isRecord(data) || data.id !== messageId || typeof data.to !== "string" || typeof data.expiresAt !== "number" || typeof data.state !== "string") {
        throw new Error("Invalid send acknowledgement");
      }
      const result: SendResult = { id: messageId, to: data.to, state: data.state, expiresAt: data.expiresAt };
      this.outgoing.set(messageId, { ...result, reply: policy });
      if (response) {
        result.response = await response;
        result.state = "replied";
        const outgoing = this.outgoing.get(messageId);
        if (outgoing) outgoing.state = "replied";
      }
      return result;
    } catch (error) {
      const waiter = this.waiters.get(messageId);
      if (waiter) { this.waiters.delete(messageId); waiter.dispose(); waiter.reject(new Error("Send or wait failed")); }
      throw error;
    }
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, message] of this.seen) if (message.expiresAt <= now) this.seen.delete(id);
    for (const [id, message] of this.incoming) if (message.expiresAt <= now) this.incoming.delete(id);
    for (const [id, message] of this.outgoing) if (message.expiresAt <= now) this.outgoing.delete(id);
  }
  private acknowledge(message: Envelope, state: AckState): void {
    // A failed ACK is transport loss, not a failed injection. The seen ledger
    // suppresses reinjection and ACKs the replay after reconnect instead.
    if (this.connected) {
      try { this.wire({ type: "ack", id: message.id, state }); } catch { /* Replay will re-ACK. */ }
    }
  }
  private async receive(message: Envelope): Promise<void> {
    if (message.to !== this.peer.id || message.expiresAt <= Date.now()) return;
    this.prune();
    const previous = this.seen.get(message.id);
    if (previous) { this.acknowledge(message, previous.state); return; }
    if (this.delivering.has(message.id)) return;
    if (this.delivering.size >= MAX_INBOX || (message.reply !== "none" && this.incoming.size >= MAX_INBOX) || this.seen.size >= 1_000) {
      this.acknowledge(message, "rejected");
      this.options.onError?.("Remote-control inbox is full; message rejected");
      return;
    }
    this.delivering.add(message.id);
    let state: AckState = "handed-to-pi";
    try {
      const waiter = message.inReplyTo ? this.waiters.get(message.inReplyTo) : undefined;
      if (waiter && message.inReplyTo) {
        this.waiters.delete(message.inReplyTo); waiter.dispose(); waiter.resolve(message);
        state = "reply-received";
      } else {
        if (message.reply !== "none") this.incoming.set(message.id, message);
        await this.options.onMessage(message);
      }
      if (!this.running) return;
      this.seen.set(message.id, { expiresAt: message.expiresAt, state });
      if (message.inReplyTo) {
        const original = this.outgoing.get(message.inReplyTo);
        if (original) original.state = "replied";
      }
      this.acknowledge(message, state);
    } catch (error) {
      this.incoming.delete(message.id);
      if (this.running) {
        this.seen.set(message.id, { expiresAt: message.expiresAt, state: "rejected" });
        this.acknowledge(message, "rejected");
      }
      throw error;
    } finally { this.delivering.delete(message.id); }
  }
}
