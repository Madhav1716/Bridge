#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "start-mac-all.sh is intended for macOS." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

npm run start:mac &
MAC_AGENT_PID=$!

cleanup() {
  if kill -0 "${MAC_AGENT_PID}" >/dev/null 2>&1; then
    kill "${MAC_AGENT_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

npm run start:tray
