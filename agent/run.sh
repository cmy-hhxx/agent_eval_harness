#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
RUNTIME_ROOT="${ERIS_RUNTIME_ROOT:-$(cd .. && pwd)/runtime}"
if [[ $# == 0 ]]; then set -- --config "$RUNTIME_ROOT/config/eris.json"; fi
[[ $# == 2 && "$1" == --config && -f "$2" ]] || { printf '用法：bash agent/run.sh --config <eris.json>\n' >&2; exit 1; }
if [[ "${ERIS_MISE:-}" != 1 ]]; then
  export ERIS_MISE=1
  exec mise exec -- bash "$0" "$@"
fi
if [[ ! -d node_modules || ! -f .runtime/pi.json || ! -f .runtime/prime.json ]]; then
  npm run bootstrap
  npm run build
else
  npm run build:app
fi
exec node dist/apps/host/src/agent.js "$@"
