#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

debug=false
args=()
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      printf '%s\n' '用法：bash automation.sh [--port 4174] [--config FILE] [--debug]' \
        '启动自动化流水线与本机动态看板；Ctrl+C 保存进度并一起退出。'
      exit 0 ;;
    --debug) debug=true ;;
    *) args+=("$arg") ;;
  esac
done
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo '请先安装 mise.toml 指定的 Node.js 与 npm。' >&2
  exit 1
fi

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
    printf '%s\n%s\n' '自动化准备失败：' "$output" >&2
    return "$status"
  fi
}

if ! npm ls --depth=0 --silent >/dev/null 2>&1 || [[ ! -f .runtime/pi.json || ! -f .runtime/prime.json || ! -f vendor/pi/packages/coding-agent/dist/index.js || ! -f vendor/prime-agent/packages/coding-agent/dist/index.js ]]; then
  prepare '正在安装自动化依赖…' node scripts/bootstrap.mjs
  prepare '正在构建自动化与运行时…' node scripts/build.mjs
else
  prepare '正在准备自动化看板…' node scripts/build-app.mjs
fi

exec node --env-file-if-exists=.env dist/apps/host/src/automations.js run --dashboard ${args[@]+"${args[@]}"}
