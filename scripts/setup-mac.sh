#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This setup script is for macOS only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

QUICK_MODE=0
if [[ "${1:-}" == "--quick" ]]; then
  QUICK_MODE=1
fi

echo "Bridge — Mac one-time setup"
echo ""

CONFIG_DIR="${REPO_ROOT}"
CONFIG_PATH="${CONFIG_DIR}/bridge.mac.json"
mkdir -p "${CONFIG_DIR}"

# No IP. Bridge discovers Windows automatically on the same WiFi (mDNS).
CONFIG_PATH="${CONFIG_PATH}" node -e "
const fs = require('node:fs');
const config = {
  discoveryType: 'bridgeworkspace',
  windowsWsPort: 47831,
};
const configPath = process.env.CONFIG_PATH;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('Saved config:', configPath);
"

echo ""
echo "Setup complete."
echo ""
echo "Start Bridge:  npm run start:mac:all"
echo ""
echo "The first time you click \"Resume Workspace\" or \"Open Project Folder\","
echo "macOS may ask you to connect to the Windows folder — approve once and you're set."
echo ""
