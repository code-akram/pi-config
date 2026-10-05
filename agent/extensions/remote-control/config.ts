import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TOKEN, isRecord, validName } from "./shared/protocol.ts";

export interface Config { url: string; token: string; name?: string }
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "remote-control.json");
}
export function validateConfig(value: unknown): Config {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.token !== "string") {
    throw new Error("Remote-control config needs url and token");
  }
  if (!TOKEN.test(value.token)) throw new Error("Use a random 32–256 character base64url/hex token");
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error("Invalid relay URL"); }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && local)) {
    throw new Error("Relay URL must use HTTPS/WSS (plain WS is allowed only on loopback for tests)");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/", "/connect"].includes(url.pathname)) {
    throw new Error("Use the relay origin or /connect URL without credentials, query, or fragment");
  }
  url.pathname = "/connect";
  if (value.name !== undefined && !validName(value.name)) throw new Error("Invalid configured display name");
  return { url: url.toString(), token: value.token, ...(typeof value.name === "string" ? { name: value.name.trim() } : {}) };
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, file = configPath(env)): Promise<Config> {
  if (env.PI_RC_URL !== undefined || env.PI_RC_TOKEN !== undefined) {
    // Never mix a token from one source with a URL from another.
    if (!env.PI_RC_URL || !env.PI_RC_TOKEN) throw new Error("Set both PI_RC_URL and PI_RC_TOKEN");
    return validateConfig({ url: env.PI_RC_URL, token: env.PI_RC_TOKEN });
  }
  let info;
  try { info = await stat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Configure ${file} with your Worker URL and token first; see remote-control/README.md`);
    }
    throw new Error("Cannot inspect the remote-control configuration file");
  }
  if (!info.isFile() || info.size > 4_096) throw new Error("Remote-control config must be a small regular file");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
    throw new Error(`Keep your token private: own ${file} and chmod 600 it`);
  }
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); } catch { throw new Error("Cannot read/parse remote-control config JSON"); }
  return validateConfig(value);
}
