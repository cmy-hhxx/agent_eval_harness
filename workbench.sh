#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="${WORKBENCH_RUNTIME_ROOT:-$(cd "$ROOT/.." && pwd)/runtime}"
CONFIG="${WORKBENCH_CONFIG:-$RUNTIME_ROOT/config/workbench.json}"

mise_bin="$(command -v mise 2>/dev/null || true)"
if [[ -z "$mise_bin" && -x "$HOME/.local/bin/mise" ]]; then mise_bin="$HOME/.local/bin/mise"; fi
if [[ -n "$mise_bin" && "${WORKBENCH_MISE:-}" != 1 ]]; then
  export WORKBENCH_MISE=1
  exec "$mise_bin" exec -- bash "$0" "$@"
fi

for command in node npm python3 uv; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '缺少 %s。先按 mise.toml 安装固定工具链后重试。\n' "$command" >&2
    exit 1
  fi
done
[[ -f "$CONFIG" ]] || { printf '缺少工作台配置：%s\n' "$CONFIG" >&2; exit 1; }

expected_node="$(node -p 'require("./package.json").engines.node')"
actual_node="$(node -p 'process.versions.node')"
expected_npm="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
actual_npm="$(npm --version)"
expected_python="$(sed -n 's/^python = "\(.*\)"/\1/p' mise.toml)"
actual_python="$(python3 -c 'import platform; print(platform.python_version())')"
[[ "$actual_node" == "$expected_node" ]] || { printf 'Node 版本不匹配：需要 %s，当前 %s。\n' "$expected_node" "$actual_node" >&2; exit 1; }
[[ "$actual_npm" == "$expected_npm" ]] || { printf 'npm 版本不匹配：需要 %s，当前 %s。\n' "$expected_npm" "$actual_npm" >&2; exit 1; }
[[ "$actual_python" == "$expected_python" ]] || { printf 'Python 版本不匹配：需要 %s，当前 %s。\n' "$expected_python" "$actual_python" >&2; exit 1; }

prepare() {
  local label="$1"; shift
  printf '%s\n' "$label"
  "$@"
}

if [[ ! -d node_modules ]] || ! npm ls --depth=0 --silent >/dev/null 2>&1 || [[ ! -f .runtime/pi.json ]] || \
   [[ ! -f .runtime/prime.json ]] || [[ ! -f vendor/pi/packages/coding-agent/dist/index.js ]] || \
   [[ ! -f vendor/prime-agent/packages/coding-agent/dist/index.js ]] || [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  prepare '正在准备固定依赖…' npm run bootstrap
  prepare '正在构建应用与运行时…' npm run build
elif [[ ! -f dist/apps/host/src/workbench.js ]] || \
  [[ -n "$(find apps packages scripts schemas configs package.json package-lock.json tsconfig.json mise.toml -type f -newer dist/apps/host/src/workbench.js -print -quit 2>/dev/null)" ]]; then
  prepare '正在构建当前应用…' npm run build:app
fi
if [[ ! -f server_dashboard_ths/records.bundle.js ]] || \
  [[ -n "$(find server_dashboard_ths/records.js server_dashboard_ths/records-markdown.js -type f -newer server_dashboard_ths/records.bundle.js -print -quit 2>/dev/null)" ]]; then
  prepare '正在构建样本浏览页…' node server_dashboard_ths/build.mjs
fi

exec node dist/apps/host/src/workbench.js --config "$CONFIG"
