import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";

const { values } = parseArgs({ options: {
  config: { type: "string", default: ".servers.conf" }, branch: { type: "string", default: "codex/eris-server-readonly" },
  "code-path": { type: "string", default: "/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/eris-code" },
  "runtime-root": { type: "string", default: "/mnt/aigc_team/user_workspace/chenmingyang/eval_harness/runtime" },
  start: { type: "boolean", default: false },
} });
const configFile = path.resolve(values.config), entries = new Map(); let section = "";
for (const raw of (await readFile(configFile, "utf8")).split(/\r?\n/)) {
  const line = raw.trim(), header = /^\[([^\]]+)\]$/.exec(line), pair = /^([^=]+)=(.*)$/.exec(line);
  if (header) section = header[1]; else if (pair && section === "eval_agent_server") entries.set(pair[1].trim(), pair[2].trim());
}
const required = key => { if (!entries.get(key)) throw new Error(`Missing eval_agent_server.${key}`); return entries.get(key); };
if (required("auth") !== "key") throw new Error("eval_agent_server must use auth=key");
const key = path.resolve(path.dirname(configFile), required("key").replace(/^~(?=\/)/, process.env.HOME));
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const script = `set -euo pipefail
CODE=${quote(values["code-path"])}
RUNTIME=${quote(values["runtime-root"])}
BRANCH=${quote(values.branch)}
ORIGIN=http://interactive-n01laf763gwn:8080/chenmingyang2/agent_eval_harness.git
export GIT_TERMINAL_PROMPT=0
export NO_PROXY="\${NO_PROXY:-},interactive-n01laf763gwn,interactive-s4lvy0mmvu32,localhost,127.0.0.1"
export no_proxy="$NO_PROXY"
if tmux has-session -t '=eris' 2>/dev/null; then echo 'Stop the eris tmux service before deploying' >&2; exit 1; fi
credential="store --file=$RUNTIME/secrets/git-credentials"
if [ ! -d "$CODE/.git" ]; then
  git -c credential.helper="$credential" -c http.proxy= clone --branch "$BRANCH" "$ORIGIN" "$CODE"
else
  test "$(git -C "$CODE" remote get-url origin)" = "$ORIGIN"
  test -z "$(git -C "$CODE" status --porcelain)"
  git -C "$CODE" -c credential.helper="$credential" -c http.proxy= fetch origin "$BRANCH"
  git -C "$CODE" switch "$BRANCH"
  git -C "$CODE" merge --ff-only "origin/$BRANCH"
fi
cd "$CODE"
export PATH="$HOME/.local/bin:$PATH"
mise trust
mise install
mise exec -- npm run bootstrap
mise exec -- npm run build
# ERIS_PASSWORD_INPUT
mise exec -- node scripts/eris-init.mjs --runtime-root "$RUNTIME" --source-ini "$RUNTIME/config/post-training.ini"
unset ERIS_ADMIN_PASSWORD
${values.start ? `if tmux has-session -t '=eris' 2>/dev/null; then echo 'eris tmux already exists; stop it explicitly before restarting' >&2; exit 1; fi
tmux new-session -d -s eris -c "$CODE" "bash agent/run.sh --config '$RUNTIME/config/eris.json'"
ready=0
for ((attempt=0; attempt<60; attempt++)); do
  tmux has-session -t '=eris' 2>/dev/null || { echo 'Eris exited before readiness' >&2; exit 1; }
  if mise exec -- python3 -c 'import urllib.request; r=urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:5004/health",timeout=1); assert r.status==200' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
test "$ready" = 1 || { echo 'Eris health check timed out' >&2; exit 1; }` : ""}
printf 'Eris prepared at %s\\n' "$CODE"
`;
const password = process.env.ERIS_ADMIN_PASSWORD; delete process.env.ERIS_ADMIN_PASSWORD;
await new Promise((resolve, reject) => {
  const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-p", required("port"), "-i", key, `${required("user")}@${required("host")}`, "bash -s"], { stdio: ["pipe", "inherit", "inherit"] });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Eris deployment exited ${code}`)));
  child.stdin.end(script.replace("# ERIS_PASSWORD_INPUT", password ? `export ERIS_ADMIN_PASSWORD=${quote(password)}` : ""));
});
