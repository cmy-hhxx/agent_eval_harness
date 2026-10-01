#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "请先安装 mise.toml 指定的 Node.js 与 npm。" >&2
  exit 1
fi
debug=false
for arg in "$@"; do
  if [[ "$arg" == --debug ]]; then debug=true; fi
done
port=$(node --input-type=module --eval '
import { parseArgs } from "node:util";
const { values } = parseArgs({ args: process.argv.slice(1), options: {
  port: { type: "string", default: "4180" }, user: { type: "string", default: "local" },
  "no-open": { type: "boolean", default: false }, debug: { type: "boolean", default: false },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
process.stdout.write(String(port));
' -- "$@")
if [[ "$port" != 0 ]] && ! command -v lsof >/dev/null; then
  echo '请先安装 lsof，以检查 Eris 端口占用。' >&2
  exit 1
fi

listeners() {
  local output status
  if output=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>&1); then
    printf '%s' "$output"
  else
    status=$?
    if [[ "$status" == 1 && -z "$output" ]]; then return 0; fi
    printf '无法检查 Eris 端口 %s：%s\n' "$port" "$output" >&2
    return "$status"
  fi
}

cleanup_port() {
  if [[ "$port" == 0 ]]; then return 0; fi
  local pids pid attempt alive remaining
  pids=$(listeners)
  if [[ -z "$pids" ]]; then return 0; fi
  for pid in $pids; do
    if [[ ! "$pid" =~ ^[1-9][0-9]*$ || "$pid" == "$$" || "$pid" == "$PPID" ]]; then
      printf '拒绝清理 Eris 端口 %s 的进程：%s\n' "$port" "$pid" >&2
      return 1
    fi
  done
  printf '正在释放 Eris 端口 %s…\n' "$port"
  for pid in $pids; do
    if ! kill -TERM "$pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
      printf '无法终止占用 Eris 端口 %s 的进程 %s。\n' "$port" "$pid" >&2
      return 1
    fi
  done
  for ((attempt = 0; attempt < 50; attempt++)); do
    alive=false
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then alive=true; fi
    done
    if ! $alive; then break; fi
    sleep 0.1
  done
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      if $debug; then printf '正在强制终止旧进程 %s…\n' "$pid"; fi
      if ! kill -KILL "$pid" 2>/dev/null && kill -0 "$pid" 2>/dev/null; then
        printf '无法清理占用 Eris 端口 %s 的进程 %s。\n' "$port" "$pid" >&2
        return 1
      fi
    fi
  done
  for ((attempt = 0; attempt < 20; attempt++)); do
    remaining=$(listeners)
    if [[ -z "$remaining" ]]; then return 0; fi
    sleep 0.1
  done
  printf 'Eris 端口 %s 仍被占用，停止启动。\n' "$port" >&2
  return 1
}

prepare() {
  local label="$1" output status
  shift
  printf '%s\n' "$label"
  if $debug; then
    "$@"
  elif output=$("$@" 2>&1); then
    return 0
  else
    status=$?
    printf '%s\n%s\n' 'Eris 准备失败：' "$output" >&2
    return "$status"
  fi
}

cleanup_port
if ! npm ls --depth=0 --silent >/dev/null 2>&1 || [[ ! -f .runtime/pi.json || ! -f .runtime/prime.json || ! -f vendor/pi/packages/coding-agent/dist/index.js || ! -f vendor/prime-agent/packages/coding-agent/dist/index.js ]]; then
  prepare '正在安装 Eris 依赖…' node scripts/bootstrap.mjs
  prepare '正在构建 Eris 和运行时…' node scripts/build.mjs
else
  prepare '正在准备 Eris…' node scripts/build-app.mjs
fi
cleanup_port
exec node --env-file-if-exists=.env dist/apps/host/src/agent.js "$@"
