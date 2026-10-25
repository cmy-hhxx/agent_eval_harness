import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs({ options: {
  config: { type: "string", default: path.join(root, ".servers.conf") },
  "on-server": { type: "boolean", default: false },
  repository: { type: "string", default: "http://interactive-n01laf763gwn:8080/chenmingyang2/agent_eval_harness.git" },
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
async function deploymentCommand() {
  if (args.values["on-server"]) return ["bash", "-s"];
  const values = await ini(path.resolve(args.values.config));
  function required(key) {
    const value = values.get(`eval_agent_server.${key}`);
    if (!value) throw new Error(`Missing eval_agent_server.${key} in ${args.values.config}`);
    return value;
  }
  if (required("auth") !== "key") throw new Error("eval_agent_server must use auth=key");
  const key = path.resolve(path.dirname(path.resolve(args.values.config)), required("key").replace(/^~(?=\/)/, process.env.HOME || "~"));
  if (!await exists(key)) throw new Error("SSH private key not found: " + key);
  return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", required("port"), "-i", key,
    `${required("user")}@${required("host")}`, "bash -s"];
}
const password = process.env[args.values["admin-password-env"]];
const origin = args.values.repository;
const repositoryUrl = new URL(origin);
if (repositoryUrl.username || repositoryUrl.password) throw new Error("Store Git credentials outside the repository URL");
const command = await deploymentCommand();
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
const remote = `set -euo pipefail
CODE=${shellQuote(args.values["code-path"])}
RUNTIME=${shellQuote(args.values["runtime-root"])}
DATA=${shellQuote(args.values["data-root"])}
ORIGIN=${shellQuote(origin)}
BRANCH=${shellQuote(args.values.branch)}
GIT_HOST=${shellQuote(repositoryUrl.hostname)}
export GIT_TERMINAL_PROMPT=0
export NO_PROXY="\${NO_PROXY:-},\${no_proxy:-},$GIT_HOST"
export no_proxy="$NO_PROXY"
mkdir -p "$(dirname "$CODE")" "$RUNTIME"
if [ ! -d "$CODE/.git" ]; then
  if [ -n "$(find "$CODE" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]; then
    echo "code path exists and is not a Git checkout: $CODE" >&2; exit 1
  fi
  rmdir "$CODE" 2>/dev/null || true
  git clone --branch "$BRANCH" "$ORIGIN" "$CODE"
else
  test "$(git -C "$CODE" remote get-url origin)" = "$ORIGIN" || { echo "Unexpected Git origin; configure the server repository URL first" >&2; exit 1; }
  test -z "$(git -C "$CODE" status --porcelain)" || { echo "Commit or discard server code changes before deploying" >&2; exit 1; }
  git -C "$CODE" fetch origin "$BRANCH"
  git -C "$CODE" switch "$BRANCH"
  git -C "$CODE" merge --ff-only "origin/$BRANCH"
fi
git -C "$CODE" config "http.$ORIGIN.proxy" ""
cd "$CODE"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v mise >/dev/null 2>&1; then
  curl -fsSL https://mise.run | sh
fi
command -v mise >/dev/null 2>&1 || { echo "mise installation failed" >&2; exit 1; }
mise trust >/dev/null
mise install
export WORKBENCH_ADMIN_PASSWORD
mise exec -- node scripts/workbench-init.mjs --runtime-root "$RUNTIME" --data-root "$DATA" --admin-user ${shellQuote(args.values["admin-user"])}
printf '部署准备完成，服务尚未启动。\\n在服务器执行：cd %s && bash workbench.sh start\\n需要保持断线后运行时，先自行进入 tmux。\\n' "$CODE"
`;
await new Promise((resolve, reject) => {
  const child = spawn(command[0], command.slice(1), { cwd: root, stdio: ["pipe", "inherit", "inherit"] });
  child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Deployment exited ${code}`)));
  child.stdin.end(`${password ? `export WORKBENCH_ADMIN_PASSWORD=${shellQuote(password)}\n` : ""}${remote}`);
});
