import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = path.join(path.dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");
const result = spawnSync(process.execPath, [cli, "deploy", "--dry-run", "--config", path.join(root, "worker", "wrangler.toml"),
  "--outdir", path.join(root, ".build")], {
  cwd: root, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
