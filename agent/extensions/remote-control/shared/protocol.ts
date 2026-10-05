// Shared wire contract. No Pi, Node, or Cloudflare runtime dependencies.
export const PROTOCOL = "pi-rc-v1";
export const AUTH_PREFIX = "pi-rc-auth.";
export const PING = "__pi_rc_ping__";
export const PONG = "__pi_rc_pong__";
export const MAX_TEXT_BYTES = 16_384;
export const MAX_FRAME_BYTES = 24_576;
export const MAX_TTL_SECONDS = 900;
export const DEFAULT_TTL_SECONDS = 600;
export const MAX_PEERS = 64;
export const MAX_MESSAGES = 1_000;
export const MAX_INBOX = 128;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

export type Delivery = "steer" | "queue";
export type ReplyPolicy = "required" | "optional" | "none";
export type AckState = "handed-to-pi" | "reply-received" | "rejected";
export interface Peer { id: string; name: string }
export interface Envelope {
  id: string;
  from: Peer;
  to: string;
  text: string;
  delivery: Delivery;
  reply: ReplyPolicy;
  inReplyTo?: string;
  createdAt: number;
  expiresAt: number;
}
export type ClientFrame =
  | { type: "hello"; peer: Peer }
  | { type: "list"; requestId: string }
  | { type: "rename"; requestId: string; name: string }
  | { type: "send"; requestId: string; id: string; to: string; text: string; delivery: Delivery; reply: ReplyPolicy; ttlSeconds: number; inReplyTo?: string }
  | { type: "ack"; id: string; state: AckState };
export type ServerFrame =
  | { type: "welcome"; peer: Peer; connectionId: string }
  | { type: "result"; requestId: string; ok: true; data: unknown }
  | { type: "result"; requestId: string; ok: false; error: string }
  | { type: "message"; message: Envelope }
  | { type: "receipt"; id: string; state: AckState | "expired" }
  | { type: "error"; error: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function byteLength(text: string): number { return new TextEncoder().encode(text).byteLength; }
export function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && byteLength(value) <= 120 &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
}
function id(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function peer(value: unknown): value is Peer {
  return isRecord(value) && id(value.id) && validName(value.name);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && byteLength(value) <= MAX_TEXT_BYTES;
}
function delivery(value: unknown): value is Delivery { return value === "steer" || value === "queue"; }
function reply(value: unknown): value is ReplyPolicy { return value === "required" || value === "optional" || value === "none"; }
function ack(value: unknown): value is AckState {
  return value === "handed-to-pi" || value === "reply-received" || value === "rejected";
}
export function parseClientFrame(raw: string): ClientFrame {
  if (byteLength(raw) > MAX_FRAME_BYTES) throw new Error("Frame too large");
  const v: unknown = JSON.parse(raw);
  if (!isRecord(v)) throw new Error("Expected an object");
  if (v.type === "hello" && peer(v.peer)) return v as unknown as ClientFrame;
  if (v.type === "ack" && id(v.id) && ack(v.state)) return v as unknown as ClientFrame;
  if (id(v.requestId)) {
    if (v.type === "list") return v as unknown as ClientFrame;
    if (v.type === "rename" && validName(v.name)) return v as unknown as ClientFrame;
    if (v.type === "send" && id(v.id) && typeof v.to === "string" && validName(v.to) && text(v.text) &&
        delivery(v.delivery) && reply(v.reply) && Number.isInteger(v.ttlSeconds) &&
        (v.ttlSeconds as number) >= 30 && (v.ttlSeconds as number) <= MAX_TTL_SECONDS &&
        (v.inReplyTo === undefined || (id(v.inReplyTo) && v.reply === "none"))) {
      return v as unknown as ClientFrame;
    }
  }
  throw new Error("Invalid protocol frame");
}
export function validEnvelope(v: unknown): v is Envelope {
  return isRecord(v) && id(v.id) && peer(v.from) && id(v.to) && text(v.text) && delivery(v.delivery) && reply(v.reply) &&
    (v.inReplyTo === undefined || (id(v.inReplyTo) && v.reply === "none")) &&
    typeof v.createdAt === "number" && Number.isSafeInteger(v.createdAt) &&
    typeof v.expiresAt === "number" && Number.isSafeInteger(v.expiresAt) && v.expiresAt > v.createdAt &&
    v.expiresAt - v.createdAt <= MAX_TTL_SECONDS * 1000;
}
export function parseServerFrame(raw: string): ServerFrame {
  if (byteLength(raw) > MAX_FRAME_BYTES) throw new Error("Frame too large");
  const v: unknown = JSON.parse(raw);
  if (!isRecord(v)) throw new Error("Expected an object");
  if (v.type === "welcome" && peer(v.peer) && id(v.connectionId)) return v as unknown as ServerFrame;
  if (v.type === "result" && id(v.requestId) &&
      ((v.ok === true && "data" in v) || (v.ok === false && typeof v.error === "string"))) return v as unknown as ServerFrame;
  if (v.type === "message" && validEnvelope(v.message)) return v as unknown as ServerFrame;
  if (v.type === "receipt" && id(v.id) && (ack(v.state) || v.state === "expired")) return v as unknown as ServerFrame;
  if (v.type === "error" && typeof v.error === "string") return v as unknown as ServerFrame;
  throw new Error("Invalid server frame");
}
export function parsePeers(value: unknown): Peer[] {
  if (!Array.isArray(value) || value.length > MAX_PEERS || !value.every(peer)) throw new Error("Invalid peer roster");
  return value;
}
export function safeDisplay(value: string): string {
  // Literal text renderers must never execute remote terminal control sequences.
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
