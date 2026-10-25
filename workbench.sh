#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="${WORKBENCH_RUNTIME_ROOT:-$(cd "$ROOT/.." && pwd)/runtime}"
CONFIG="${WORKBENCH_CONFIG:-$RUNTIME_ROOT/config/workbench.json}"

usage() {
  printf '%s\n' 'Usage: bash workbench.sh [start|stop|status|check|logs] [--config FILE]' \
    '  start   前台启动（默认）；在 tmux 中运行可保持 SSH 断线后继续运行' \
    '  stop    停止当前实例并保存评测进度' \
    '  status  查看当前实例和子服务状态' \
    '  check   校验启动条件，不启动服务或安装依赖' \
    '  logs    查看现有日志；可加 --log runtime|evaluation、--lines N、--follow'
}
action=start
if [[ $# -gt 0 && "$1" != -* ]]; then action="$1"; shift; fi
case "$action" in start|stop|status|check|logs) ;; *) usage >&2; exit 2;; esac
options=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0;;
    --config)
      [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || { printf '缺少 --config FILE\n' >&2; exit 2; }
      CONFIG="$2"; shift 2;;
    --log|--lines)
      [[ "$action" == logs && $# -ge 2 && -n "$2" && "$2" != -* ]] || { usage >&2; exit 2; }
      options+=("$1" "$2"); shift 2;;
    --follow)
      [[ "$action" == logs ]] || { usage >&2; exit 2; }
      options+=("$1"); shift;;
    *) printf '未知参数：%s\n' "$1" >&2; usage >&2; exit 2;;
  esac
done
[[ "$CONFIG" == /* ]] || CONFIG="$PWD/$CONFIG"
cd "$ROOT"

mise_bin="$(command -v mise 2>/dev/null || true)"
if [[ -z "$mise_bin" && -x "$HOME/.local/bin/mise" ]]; then mise_bin="$HOME/.local/bin/mise"; fi
if [[ -n "$mise_bin" && "${WORKBENCH_MISE:-}" != 1 ]]; then
  if [[ "$action" == start ]]; then
    export WORKBENCH_MISE=1
    exec "$mise_bin" exec -- bash "$ROOT/workbench.sh" start --config "$CONFIG"
  fi
  tools=(node)
  [[ "$action" != check ]] || tools+=(npm python uv)
  for tool in "${tools[@]}"; do
    tool_path="$("$mise_bin" which "$tool")"
    PATH="$(dirname "$tool_path"):$PATH"
  done
  export PATH
fi

if [[ "$action" != start && "$action" != check ]]; then
  [[ -f dist/apps/host/src/workbench.js ]] || { printf '缺少构建产物，请先执行 npm run bootstrap && npm run build。\n' >&2; exit 1; }
  exec node dist/apps/host/src/workbench.js "$action" --config "$CONFIG" ${options[@]+"${options[@]}"}
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
expected_uv="$(sed -n 's/^uv = "\(.*\)"/\1/p' mise.toml)"
actual_uv="$(uv --version)"
actual_uv="${actual_uv#uv }"
actual_uv="${actual_uv%% *}"
[[ "$actual_uv" == "$expected_uv" ]] || { printf 'uv 版本不匹配：需要 %s，当前 %s。\n' "$expected_uv" "$actual_uv" >&2; exit 1; }
if [[ "$action" == check ]]; then
  [[ -f dist/apps/host/src/workbench.js ]] || { printf '缺少构建产物，请先执行 npm run bootstrap && npm run build。\n' >&2; exit 1; }
  exec node dist/apps/host/src/workbench.js check --config "$CONFIG"
fi

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

exec node dist/apps/host/src/workbench.js start --config "$CONFIG"
