import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs({ options: {
  config: { type: "string", default: path.join(root, ".servers.conf") },
  branch: { type: "string", default: "main" },
  "code-path": { type: "string", default: "/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/code" },
  "runtime-root": { type: "string", default: "/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime" },
  "data-root": { type: "string", default: "/mnt/fin_bench/eval_data" },
  "admin-user": { type: "string", default: "cmy" },
  "admin-password-env": { type: "string", default: "WORKBENCH_ADMIN_PASSWORD" },
} });

async function exists(file) { return access(file).then(() => true, () => false); }
function ini(file) {
  const values = new Map(); let section = "";
  return readFile(file, "utf8").then(text => {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) { section = header[1]; continue; }
      const entry = /^([^=]+)=(.*)$/.exec(line);
      if (entry) values.set(`${section}.${entry[1].trim()}`, entry[2].trim());
    }
    return values;
  });
}
const values = await ini(path.resolve(args.values.config));
function required(key) {
  const value = values.get(`eval_data_server.${key}`);
  if (!value) throw new Error(`Missing eval_data_server.${key} in ${args.values.config}`);
  return value;
}
if (required("auth") !== "key") throw new Error("eval_data_server must use auth=key");
const key = path.resolve(path.dirname(path.resolve(args.values.config)), required("key").replace(/^~(?=\/)/, process.env.HOME || "~"));
if (!await exists(key)) throw new Error("SSH private key not found: " + key);
const password = process.env[args.values["admin-password-env"]];
if (!password) throw new Error(`Missing ${args.values["admin-password-env"]} for first runtime initialization`);
const origin = (await new Promise((resolve, reject) => {
  const child = spawn("git", ["remote", "get-url", "origin"], { cwd: root });
  let out = ""; child.stdout.on("data", chunk => out += chunk); child.on("error", reject);
  child.on("exit", code => code === 0 ? resolve(out.trim()) : reject(new Error("Cannot read git origin")));
}));
const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", required("port"), "-i", key,
  `${required("user")}@${required("host")}`];
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
const remote = `set -euo pipefail
CODE=${shellQuote(args.values["code-path"])}
RUNTIME=${shellQuote(args.values["runtime-root"])}
DATA=${shellQuote(args.values["data-root"])}
ORIGIN=${shellQuote(origin)}
BRANCH=${shellQuote(args.values.branch)}
mkdir -p "$(dirname "$CODE")" "$RUNTIME"
if [ ! -d "$CODE/.git" ]; then
  if [ -n "$(find "$CODE" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]; then
    echo "code path exists and is not a Git checkout: $CODE" >&2; exit 1
  fi
  rmdir "$CODE" 2>/dev/null || true
  git clone --branch "$BRANCH" "$ORIGIN" "$CODE"
else
  test "$(git -C "$CODE" remote get-url origin)" = "$ORIGIN"
  test -z "$(git -C "$CODE" status --porcelain)"
  git -C "$CODE" fetch origin "$BRANCH"
  git -C "$CODE" switch "$BRANCH"
  git -C "$CODE" merge --ff-only "origin/$BRANCH"
fi
cd "$CODE"
if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | sh
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v mise >/dev/null 2>&1 || { echo "mise installation failed" >&2; exit 1; }
mise trust >/dev/null
mise install
export WORKBENCH_ADMIN_PASSWORD
mise exec -- node scripts/workbench-init.mjs --runtime-root "$RUNTIME" --data-root "$DATA" --admin-user ${shellQuote(args.values["admin-user"])}
printf '部署准备完成。\\n下一步：ssh 登录后执行 cd %s && tmux new -s workbench && bash workbench.sh\\n' "$CODE"
`;
await new Promise((resolve, reject) => {
  const child = spawn(ssh[0], [...ssh.slice(1), "bash -s"], { cwd: root, stdio: ["pipe", "inherit", "inherit"] });
  child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Remote deploy exited ${code}`)));
  child.stdin.end(`export WORKBENCH_ADMIN_PASSWORD=${shellQuote(password)}\n${remote}`);
});
