import { DurableObject } from "cloudflare:workers";
import {
  AUTH_PREFIX, MAX_FRAME_BYTES, MAX_MESSAGES, MAX_PEERS, PING, PONG, PROTOCOL, TOKEN,
  byteLength, parseClientFrame, type ClientFrame, type Envelope, type Peer, type ServerFrame,
} from "../../shared/protocol.ts";

interface Env { RC_RELAY: DurableObjectNamespace; RC_TOKEN: string }
interface Attachment {
  connectionId: string;
  peer: Peer | null;
  active: boolean;
  connectedAt: number;
  rateStart: number;
  rateCount: number;
}
type MessageRow = {
  id: string;
  sender: string;
  recipient: string;
  payload: string | null;
  signature: string;
  state: string;
  expires: number;
  reply_policy: string;
  reply_id: string | null;
};
const REGISTRATION_TIMEOUT = 15_000;
const EMPTY_GRACE = 60_000;
const RATE_PER_MINUTE = 120;

// Authentication is checked before the Durable Object is contacted. The token is
// an HTTPS handshake header, never a URL, SQLite column, log, or model message.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ service: "pi-remote-control", protocol: PROTOCOL });
    }
    if (url.pathname !== "/connect" || request.method !== "GET") return new Response("Not found", { status: 404 });
    if (!TOKEN.test(env.RC_TOKEN ?? "")) return new Response("Relay secret is not configured", { status: 503 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
    if (request.headers.has("Origin")) return new Response("Browser clients are not supported", { status: 403 });
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
    const offered = protocols.filter((p) => p.startsWith(AUTH_PREFIX));
    if (!protocols.includes(PROTOCOL) || offered.length !== 1 || !constantTimeEqual(offered[0].slice(AUTH_PREFIX.length), env.RC_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }
    // One deployment = one private owner bus. Different owners deploy separately.
    const stub = env.RC_RELAY.get(env.RC_RELAY.idFromName("private-owner"));
    // Do not forward the credential to the DO.
    const headers = new Headers({ Upgrade: "websocket", "Sec-WebSocket-Protocol": PROTOCOL });
    return stub.fetch(new Request("https://relay.internal/connect", { headers }));
  },
} satisfies ExportedHandler<Env>;

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}

export class RcRelay extends DurableObject<Env> {
  private schemaReady = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL,
      payload TEXT, signature TEXT NOT NULL, state TEXT NOT NULL,
      expires INTEGER NOT NULL, reply_policy TEXT NOT NULL, reply_id TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient, expires);
    CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires);`);
    this.schemaReady = true;
  }

  private attachment(ws: WebSocket): Attachment { return ws.deserializeAttachment() as Attachment; }
  private connections(): WebSocket[] {
    // Reconstruct from attachments on every event: no volatile routing Maps.
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && this.attachment(ws)?.active);
  }
  private peers(): Peer[] { return this.connections().flatMap((ws) => this.attachment(ws).peer ?? []); }
  private socket(peerId: string): WebSocket | undefined {
    return this.connections().find((ws) => this.attachment(ws).peer?.id === peerId);
  }
  private emit(ws: WebSocket | undefined, frame: ServerFrame): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch { /* Persisted payload will replay on reconnect. */ }
  }
  private row(id: string): MessageRow | undefined {
    return this.ctx.storage.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ? AND expires > ?", id, Date.now()).toArray()[0];
  }

  async fetch(_request: Request): Promise<Response> {
    this.ensureSchema();
    if (this.connections().length >= MAX_PEERS) return new Response("Bus connection limit reached", { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    server.serializeAttachment({ connectionId: crypto.randomUUID(), peer: null, active: true,
      connectedAt: now, rateStart: now, rateCount: 0 } satisfies Attachment);
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": PROTOCOL } });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.ensureSchema();
    const attachment = this.attachment(ws);
    if (!attachment?.active) return;
    const now = Date.now();
    if (now - attachment.rateStart >= 60_000) { attachment.rateStart = now; attachment.rateCount = 0; }
    attachment.rateCount++;
    ws.serializeAttachment(attachment);
    if (attachment.rateCount > RATE_PER_MINUTE) { this.retire(ws, 1008, "Rate limit exceeded"); return; }
    let frame: ClientFrame;
    try {
      if (typeof raw !== "string") throw new Error("Text frames required");
      frame = parseClientFrame(raw);
    } catch {
      this.retire(ws, 1008, "Invalid protocol frame");
      await this.scheduleAlarm();
      return;
    }
    try {
      if (frame.type === "hello") {
        if (attachment.peer) throw new Error("Already registered");
        const previous = this.socket(frame.peer.id);
        if (previous && previous !== ws) this.retire(previous, 4009, "Replaced by reconnect");
        attachment.peer = { id: frame.peer.id, name: frame.peer.name.trim() };
        ws.serializeAttachment(attachment);
        this.emit(ws, { type: "welcome", peer: attachment.peer, connectionId: attachment.connectionId });
        const rows = this.ctx.storage.sql.exec<{ payload: string }>(
          "SELECT payload FROM messages WHERE recipient = ? AND payload IS NOT NULL AND expires > ? ORDER BY rowid",
          attachment.peer.id, now,
        ).toArray();
        for (const row of rows) this.emit(ws, { type: "message", message: JSON.parse(row.payload) as Envelope });
      } else {
        if (!attachment.peer) throw new Error("Register first");
        if (frame.type === "list") {
          this.emit(ws, { type: "result", requestId: frame.requestId, ok: true, data: this.peers() });
        } else if (frame.type === "rename") {
          attachment.peer.name = frame.name.trim();
          ws.serializeAttachment(attachment);
          this.emit(ws, { type: "result", requestId: frame.requestId, ok: true, data: attachment.peer });
        } else if (frame.type === "send") {
          await this.sendMessage(ws, attachment, frame);
        } else {
          const row = this.row(frame.id);
          if (row?.recipient === attachment.peer.id && row.payload !== null) {
            // Erase the body as soon as the recipient hands it to Pi. A bounded,
            // short-lived metadata tombstone remains for dedup/reply correlation.
            this.ctx.storage.sql.exec("UPDATE messages SET payload = NULL, state = ? WHERE id = ?", frame.state, frame.id);
            this.emit(this.socket(row.sender), { type: "receipt", id: frame.id, state: frame.state });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Operation failed";
      if ("requestId" in frame) this.emit(ws, { type: "result", requestId: frame.requestId, ok: false, error: message });
      else this.emit(ws, { type: "error", error: message });
    }
    await this.scheduleAlarm();
  }

  private async sendMessage(ws: WebSocket, attachment: Attachment, frame: Extract<ClientFrame, { type: "send" }>): Promise<void> {
    const sender = attachment.peer!;
    const { requestId: _requestId, ...authored } = frame;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(authored)));
    const signature = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
    // The digest yields; verify this connection wasn't superseded while waiting.
    if (!this.attachment(ws).active || this.socket(sender.id) !== ws) throw new Error("Stale connection");
    const duplicate = this.row(frame.id);
    if (duplicate) {
      if (duplicate.sender !== sender.id || duplicate.signature !== signature) throw new Error("Message ID collision");
      this.emit(ws, { type: "result", requestId: frame.requestId, ok: true,
        data: { id: duplicate.id, to: duplicate.recipient, expiresAt: duplicate.expires, state: duplicate.state, duplicate: true } });
      return;
    }
    let recipient: string;
    let parent: MessageRow | undefined;
    if (frame.inReplyTo) {
      parent = this.row(frame.inReplyTo);
      if (!parent || parent.recipient !== sender.id || parent.reply_policy === "none" || parent.reply_id) {
        throw new Error("Reply is expired, unauthorized, already answered, or not requested");
      }
      if (frame.to !== parent.sender) throw new Error("Reply target does not match the original sender");
      recipient = parent.sender; // Briefly offline reply targets may reconnect within the parent TTL.
    } else {
      const roster = this.peers();
      const exact = roster.find((p) => p.id === frame.to);
      const named = roster.filter((p) => p.name === frame.to);
      if (!exact && named.length > 1) throw new Error("Ambiguous session name; use the session ID");
      const target = exact ?? named[0];
      if (!target) throw new Error("Recipient is offline or not subscribed");
      recipient = target.id;
    }
    if (recipient === sender.id) throw new Error("Cannot message yourself");
    const now = Date.now();
    // Expired tombstones may have remained until an alarm was scheduled.
    this.prune(now);
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
    if (count >= MAX_MESSAGES) throw new Error("Bus ledger is full; wait for message expiry");
    const pending = this.ctx.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND payload IS NOT NULL", recipient,
    ).one().n;
    if (pending >= 128) throw new Error("Recipient inbox is full");
    const expiresAt = Math.min(now + frame.ttlSeconds * 1000, parent?.expires ?? Infinity);
    const message: Envelope = { id: frame.id, from: sender, to: recipient, text: frame.text,
      delivery: frame.delivery, reply: frame.reply, createdAt: now, expiresAt,
      ...(frame.inReplyTo ? { inReplyTo: frame.inReplyTo } : {}) };
    if (byteLength(JSON.stringify({ type: "message", message })) > MAX_FRAME_BYTES) {
      throw new Error("Encoded delivery exceeds the frame size limit");
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT INTO messages
        (id, sender, recipient, payload, signature, state, expires, reply_policy)
        VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      message.id, sender.id, recipient, JSON.stringify(message), signature, expiresAt, frame.reply);
      if (parent) this.ctx.storage.sql.exec("UPDATE messages SET reply_id = ? WHERE id = ?", message.id, parent.id);
    });
    this.emit(ws, { type: "result", requestId: frame.requestId, ok: true,
      data: { id: message.id, to: recipient, state: "accepted", expiresAt } });
    this.emit(this.socket(recipient), { type: "message", message });
  }

  private retire(ws: WebSocket, code: number, reason: string): void {
    const attachment = this.attachment(ws);
    if (attachment) ws.serializeAttachment({ ...attachment, active: false });
    try { ws.close(code, reason); } catch { /* Already disconnected. */ }
  }
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.retire(ws, 1000, "Disconnected");
    await this.scheduleAlarm();
  }
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.retire(ws, 1011, "Transport error");
    await this.scheduleAlarm();
  }
  private prune(now: number): void {
    const expired = this.ctx.storage.sql.exec<{ id: string; sender: string; payload: string | null }>(
      "SELECT id, sender, payload FROM messages WHERE expires <= ?", now,
    ).toArray();
    for (const row of expired) {
      if (row.payload) this.emit(this.socket(row.sender), { type: "receipt", id: row.id, state: "expired" });
    }
    if (expired.length) this.ctx.storage.sql.exec("DELETE FROM messages WHERE expires <= ?", now);
  }
  private async scheduleAlarm(): Promise<void> {
    this.ensureSchema();
    const expiry = this.ctx.storage.sql.exec<{ expiry: number | null }>("SELECT MIN(expires) AS expiry FROM messages").one().expiry;
    const sockets = this.connections();
    const registrations = sockets.filter((ws) => !this.attachment(ws).peer)
      .map((ws) => this.attachment(ws).connectedAt + REGISTRATION_TIMEOUT);
    const next = Math.min(expiry ?? Infinity, ...registrations, sockets.length ? Infinity : Date.now() + EMPTY_GRACE);
    const current = await this.ctx.storage.getAlarm();
    if (Number.isFinite(next)) {
      if (current === null || next < current) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    } else if (current !== null) await this.ctx.storage.deleteAlarm();
  }
  async alarm(): Promise<void> {
    this.ensureSchema();
    const now = Date.now();
    for (const ws of this.connections()) {
      const attachment = this.attachment(ws);
      if (!attachment.peer && attachment.connectedAt + REGISTRATION_TIMEOUT <= now) this.retire(ws, 1008, "Registration timeout");
    }
    this.prune(now);
    const remaining = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
    if (remaining === 0 && this.connections().length === 0) {
      await this.ctx.storage.deleteAll();
      this.schemaReady = false;
      return;
    }
    await this.scheduleAlarm();
  }
}
