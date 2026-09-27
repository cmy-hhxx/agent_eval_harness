#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "请先安装 mise.toml 指定的 Node.js 与 npm。" >&2
  exit 1
fi
if ! npm ls --depth=0 --silent >/dev/null 2>&1 || [[ ! -f .runtime/pi.json || ! -f .runtime/prime.json || ! -f vendor/pi/packages/coding-agent/dist/index.js || ! -f vendor/prime-agent/packages/coding-agent/dist/index.js ]]; then
  npm run bootstrap
  npm run build
else
  npm run build:app
fi
exec node --env-file-if-exists=.env dist/apps/host/src/agent.js "$@"
