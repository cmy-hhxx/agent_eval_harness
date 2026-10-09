#!/usr/bin/env bash
set -euo pipefail
cd -P "$(dirname "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "请先安装 mise.toml 指定的 Node.js 与 npm。" >&2
  exit 1
fi
debug=false
args=()
for arg in "$@"; do
  if [[ "$arg" == --debug ]]; then debug=true; else args+=("$arg"); fi
done

port=4173
for ((index=0; index<${#args[@]}; index++)); do
  case "${args[index]}" in
    --port)
      if ((index + 1 >= ${#args[@]})); then
        echo '--port 必须指定 1–65535 的端口。' >&2
        exit 1
      fi
      port="${args[index + 1]}"
      index=$((index + 1))
      ;;
    --port=*) port="${args[index]#--port=}" ;;
  esac
done
if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
  echo '--port 必须指定 1–65535 的端口。' >&2
  exit 1
fi
port=$((10#$port))

is_project_dashboard() {
  local pid="$1" command prefix line process_directory=""
  command=$(ps -p "$pid" -o command= 2>/dev/null) || return 1
  # An absolute entry must belong to this checkout. Relative entries additionally
  # require the process working directory to identify the same repository.
  local dashboard_command='^([^[:space:]]*/)?node[[:space:]]+(--[^[:space:]]+[[:space:]]+)*(.*/)?dist/apps/host/src/cli\.js[[:space:]]+dashboard([[:space:]]|$)'
  [[ "$command" =~ $dashboard_command ]] || return 1
  prefix="${BASH_REMATCH[3]}"
  if [[ "$prefix" == /* ]]; then
    [[ "$(cd -P "${prefix%/}" 2>/dev/null && pwd)" == "$PWD" ]]
    return
  fi
  [[ -z "$prefix" || "$prefix" == ./ ]] || return 1
  while IFS= read -r line; do
    if [[ "$line" == n* ]]; then process_directory="${line#n}"; fi
  done < <(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null || true)
  [[ "$process_directory" == "$PWD" ]]
}

stop_previous_dashboard() {
  local listeners pid attempt
  if ! command -v lsof >/dev/null || ! command -v ps >/dev/null; then
    echo '缺少 lsof 或 ps，无法检查旧看板进程。' >&2
    return 1
  fi
  listeners=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  [[ -n "$listeners" ]] || return 0
  # Verify every listener before stopping any of them.
  for pid in $listeners; do
    if [[ ! "$pid" =~ ^[0-9]+$ ]] || ! is_project_dashboard "$pid"; then
      printf '端口 %s 的监听进程不是当前项目的看板，无法启动。\n' "$port" >&2
      return 1
    fi
  done
  printf '正在停止旧看板（端口 %s）…\n' "$port"
  for pid in $listeners; do
    if ! is_project_dashboard "$pid"; then
      if ! kill -0 "$pid" 2>/dev/null; then continue; fi
      printf '旧看板进程 %s 身份已变化，无法继续停止。\n' "$pid" >&2
      return 1
    fi
    if ! kill -TERM "$pid" 2>/dev/null; then
      if ! is_project_dashboard "$pid"; then continue; fi
      printf '旧看板进程 %s 无法停止。\n' "$pid" >&2
      return 1
    fi
    for ((attempt=0; attempt<50; attempt++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep .1
    done
    if kill -0 "$pid" 2>/dev/null; then
      if ! is_project_dashboard "$pid"; then
        printf '旧看板进程 %s 身份已变化，无法继续停止。\n' "$pid" >&2
        return 1
      fi
      kill -KILL "$pid"
      for ((attempt=0; attempt<20; attempt++)); do
        kill -0 "$pid" 2>/dev/null || break
        sleep .1
      done
      if kill -0 "$pid" 2>/dev/null; then
        printf '旧看板进程 %s 尚未退出。\n' "$pid" >&2
        return 1
      fi
    fi
  done
}

stop_previous_dashboard

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
    printf '%s\n%s\n' '看板准备失败：' "$output" >&2
    return "$status"
  fi
}

if ! npm ls --depth=0 --silent >/dev/null 2>&1 || [[ ! -f .runtime/pi.json || ! -f .runtime/prime.json || ! -f vendor/pi/packages/coding-agent/dist/index.js || ! -f vendor/prime-agent/packages/coding-agent/dist/index.js ]]; then
  prepare '正在安装看板依赖…' node scripts/bootstrap.mjs
  prepare '正在构建看板与运行时…' node scripts/build.mjs
else
  prepare '正在准备看板…' node scripts/build-app.mjs
fi

configs=(--config configs/host.json)
if [[ -f configs/local/models.json ]]; then
  configs+=(--config configs/local/models.json)
fi

exec node dist/apps/host/src/cli.js dashboard "${configs[@]}" ${args[@]+"${args[@]}"}
