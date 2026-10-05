# Remote control

A custom, opt-in Pi-to-Pi message bus. Every enabled Pi session makes an outbound authenticated WebSocket connection to **your own Cloudflare Worker + SQLite-backed Durable Object**. No machine owns a daemon, hub, tunnel, or listening port. No third-party extension code is used. The extension has no runtime dependencies beyond Pi and Node's built-in APIs.

## Usage

Run `/remote-control` with no arguments to toggle the current session. Connected sessions show vibrant-green **rc** in the footer; connecting/reconnecting is yellow. The existing `arch-rice` footer puts RC on a separate row. Turning it off removes the indicator and tool and closes the socket.

If you restrict tools with `--tools` / `--no-tools`, ensure `remote_control` is allowed; the toggle reports an error instead of silently connecting without a usable tool.

Activation is intentionally **not restored automatically**. `/new`, resume, fork, `/reload`, and exit tear down the connection. Toggle the new runtime explicitly. A runtime gets a fresh UUID; reconnecting within that runtime keeps it. Display names come from the Pi session name, or `session-<id-prefix>`. Names can collide; exact UUIDs cannot.

When connected, the model receives the `remote_control` tool:

```ts
remote_control({ action: "list" })

// Native steering at a safe model boundary, NOT an immediate abort.
remote_control({ action: "send", to: "worker", message: "Investigate the failing test.",
  delivery: "steer", reply: "required" })

// Queue behind the current run; no response requested.
remote_control({ action: "send", to: "reviewer", message: "The patch is ready.",
  delivery: "queue", reply: "none" })

// Explicitly answer an inbound message. The ID is provided in the incoming text.
remote_control({ action: "reply", inReplyTo: "<message-uuid>", message: "The bug is in validation." })

// Optional blocking request: answer returns as this tool's result rather than
// injecting another turn. Avoid mutually blocking requests between peers.
remote_control({ action: "send", to: "worker", message: "What did you find?",
  reply: "required", wait: true, timeoutMs: 60000 })

remote_control({ action: "pending" })
```

Defaults: `delivery: "queue"`, `reply: "none"`, `wait: false`, `ttlSeconds: 600`. TTL is 30–900 seconds. Wait timeout is 1–180 seconds (default 60). `reply: "optional"` is also supported. Required means an explicit reply is requested; it cannot guarantee another agent will answer.

Incoming messages use attributable custom messages, not forged human/system messages. `steer` maps to native `steer`; `queue` maps to native `followUp`. Messages received during compaction are held until success/failure and rejected if they expire. A correlated response has `reply: "none"`, preventing automatic reply chains. There is no arbitrary remote bash/RPC execution endpoint or broadcast action.

## Cloudflare deployment — user assistance required

Workers Free supports this SQLite-backed DO configuration. You need your Cloudflare account, an available Workers subdomain, and permission to deploy Workers and Durable Objects. No D1/KV/R2 provisioning or paid plan is required for a small personal bus. Free quota exhaustion causes operations to fail; the client reconnects but cannot bypass quotas.

From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npx wrangler login
```

Choose an unused Worker name in `worker/wrangler.toml` if `pi-remote-control` conflicts with something in your account. Deploy:

```sh
npm run deploy
```

The Worker safely refuses connections until the secret is set. Generate one random owner token and store it in a password manager. For example, run this **locally**, not inside a model conversation:

```sh
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Then set the Cloudflare secret using the interactive prompt:

```sh
npx wrangler secret put RC_TOKEN --config worker/wrangler.toml
```

Paste that same token into a **private, untracked** `~/.pi/agent/remote-control.json` on each machine:

```json
{
  "url": "https://pi-remote-control.YOUR-SUBDOMAIN.workers.dev",
  "token": "YOUR_RANDOM_OWNER_TOKEN"
}
```

```sh
chmod 600 ~/.pi/agent/remote-control.json
```

`PI_CODING_AGENT_DIR` changes the config directory. Alternatively set **both** `PI_RC_URL` and `PI_RC_TOKEN` in the environment; partial overrides are rejected. An optional `name` config field overrides the session's display name. Do not commit the token or put it in a URL, shell command argument, transcript, or screenshot.

Copy this extension directory to `~/.pi/agent/extensions/remote-control/` on other machines (omit `node_modules`, `.build`, `.wrangler`, and tests if desired). No npm install is needed to run the extension inside Pi. It targets Pi 1.0.3 and Node 22.19+. Run `/reload`, then `/remote-control` in each desired session. Ask one agent to list remote sessions and send a test message.

**This installation's initial deployment is complete.** The Worker and SQLite Durable Object were deployed using a temporary setup API token in HTTPS request headers only: it was not placed in environment variables, `.env` files, or Wrangler's credential store. The separate relay owner secret is stored in Cloudflare and the private Pi config. Untracked `~/.pi/agent/remote-control-deployment.json` contains non-secret deployment metadata for future maintenance. You can revoke the temporary setup token without interrupting the relay.

Use `/reload`, then `/remote-control` to connect this Pi session. Run `npm run smoke` from this extension directory for a live check with synthetic peers and no LLM requests; it only needs the private relay config, not a Cloudflare API token. Other machines need the same extension and private relay configuration.

For a new installation or future deployments, authenticate with a fresh scoped API token or a working OAuth login. Device OAuth may be blocked by Cloudflare's challenge layer. A custom **user** API token for this project uses Account → Workers Scripts → Edit, Account → Account Settings → Read, User → User Details → Read, and User → Memberships → Read, restricted to the intended account with no zone permissions. Do not grant DNS, routes, KV, D1, R2, or billing access. API credentials are for deployment only, never Pi runtime.

## Local development

For a local Worker, create `worker/.dev.vars` (gitignored) with a **test-only** token:

```text
RC_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

```sh
npm run dev -- --ip 127.0.0.1
```

Configure a test Pi process with `PI_RC_URL=ws://127.0.0.1:8787/connect` and the matching test token. Plain HTTP/WS is rejected for non-loopback destinations. Keep the local server on loopback; do not use the dummy token for deployment.

`npm test` bundles the real Worker, then runs Node tests against Cloudflare's local workerd/Miniflare runtime: authentication, real native WebSockets, correlated replies, hibernation/eviction, reconnect replay, deduplication, storage cleanup, and extension lifecycle. A real in-memory Pi SDK session with a deterministic local stream also verifies native steer-before-follow-up ordering and disposed-context cleanup. Tests use fake credentials and temporary local resources only; no LLM requests or live Cloudflare resources. Test-only storage/control hooks are **not** included in the deployed Worker.

## Delivery and retention contract

- `accepted`: the relay stored the message. Not proof of recipient execution.
- `handed-to-pi`: the extension passed it to Pi's native queue. Not proof the model consumed it, completed work, or kept it after the human cleared the queue. Pi's public injection API is fire-and-forget.
- `reply-received`: a waiting sender received the correlated answer as a tool result.
- `rejected` / `expired`: terminal delivery failure, visible in the sender's `pending` ledger when connected.
- Timeout, abort, disconnect, and turning off stop local waiting. They **do not cancel already admitted remote work**. Outgoing authored operations are never automatically retried.
- Ordinary sends require an online, enabled recipient. Already accepted deliveries and correlated replies can survive a brief disconnect of the same runtime. There is no mailbox for saved/closed sessions.
- Pending bodies are erased on recipient ACK; bounded metadata tombstones remain until TTL for deduplication and authorized reply correlation. SQL alarms remove expired entries. When there are no connections and no retained entries, the database is cleared after an idle grace period. Alarms may run late or retry; TTL is a logical routing expiry, not a guarantee of physical deletion at an exact instant.
- Client deduplication lives for the enabled runtime. IDs do not transfer to another runtime, so stale buffered messages cannot be injected into `/new` or a reloaded/resumed session. This is **not an exactly-once execution guarantee**.
- **Pi's local conversation history still records received messages.** Ephemeral relay storage does not erase native session history.

## Security and bounds

One deployment is one private owner bus. Share its token only across machines/sessions you trust to control each other; every token holder has equal access. Separate owners should deploy separate Workers. The model can send task requests, and the receiving agent can use its local tools with the user's permissions. Treat the token like SSH credentials and keep explicit opt-in off for sensitive sessions.

Authentication uses a WebSocket subprotocol header over TLS, not URL parameters. Browser-origin requests are rejected. Keep Cloudflare/Wrangler request-header logging disabled; the header carries a credential. Code never logs tokens/bodies or uploads complete session history, working directories, or machine hostnames. Display names and message bodies are relayed. Rendering strips terminal and bidi controls. Incoming text is marked as untrusted peer input; this does not eliminate prompt-injection risk.

Transport encryption is TLS, **not end-to-end encryption**: your Worker/Cloudflare can process plaintext. Token rotation rejects new connections; existing connections must also be closed/restarted if immediate revocation is needed.

Limits: 64 attached sockets, 120 non-heartbeat frames/minute/connection, 1,000 retained message records, 128 pending bodies/recipient, 16 KiB text, 24 KiB encoded frames, maximum 15-minute TTL. Excess traffic/messages are rejected rather than growing storage unboundedly. Heartbeats use DO auto-response and do not wake hibernating compute. Routing is rebuilt from socket attachments after hibernation, not from volatile global Maps.

First-party references:
- [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Cloudflare hibernating WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Cloudflare Free allowances](https://developers.cloudflare.com/durable-objects/platform/pricing/)
