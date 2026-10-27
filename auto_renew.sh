#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  printf '%s\n' '用法：bash auto_renew.sh [--check|--once] [--config FILE]' \
    '默认持续监控问财与 AIME 日常；Ctrl+C 安全收尾，再次启动自动续跑。' \
    '--check 只读检查路径、依赖和清洗状态；--once 执行一轮（新包仍需稳定观察）。' \
    '配置默认 configs/auto-renew.json；建议在 tmux 中运行。'
  exit 0
fi
cd "$ROOT"
mise_bin="$(command -v mise || true)"
if [[ -z "$mise_bin" && -x "$HOME/.local/bin/mise" ]]; then mise_bin="$HOME/.local/bin/mise"; fi
if [[ -n "$mise_bin" && "${AUTO_RENEW_MISE:-}" != 1 ]]; then
  export AUTO_RENEW_MISE=1
  exec "$mise_bin" exec -- bash "$ROOT/auto_renew.sh" "$@"
fi
exec node "$ROOT/scripts/auto-renew.mjs" "$@"
