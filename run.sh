#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Build the current Host and dashboard assets without rebuilding the SDKs on every start.
npm run build:app

configs=(--config configs/host.json)
if [[ -f configs/local/models.json ]]; then
  configs+=(--config configs/local/models.json)
fi

exec npm run eval -- dashboard --port 4173 "${configs[@]}"
