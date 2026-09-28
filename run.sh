#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "请先安装 mise.toml 指定的 Node.js 与 npm。" >&2
  exit 1
fi
debug=false
args=()
for arg in "$@"; do
  if [[ "$arg" == --debug ]]; then debug=true; else args+=("$arg"); fi
done

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

exec node --env-file-if-exists=.env dist/apps/host/src/cli.js dashboard "${configs[@]}" ${args[@]+"${args[@]}"}
