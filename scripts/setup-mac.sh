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

# Only ask for Windows IP when mDNS might not work. Everything else is automatic.
DEFAULT_WINDOWS_HOST="${BRIDGE_WINDOWS_HOST:-}"

if [[ "${QUICK_MODE}" -eq 1 ]]; then
  WINDOWS_HOST="${DEFAULT_WINDOWS_HOST}"
else
  echo "Bridge will find your Windows PC on the network automatically."
  echo "Only enter an IP below if it can't find it (e.g. strict firewall)."
  echo ""
  read -r -p "Windows PC IP address (press Enter to skip): " WINDOWS_HOST
  WINDOWS_HOST="${WINDOWS_HOST:-$DEFAULT_WINDOWS_HOST}"
fi

CONFIG_DIR="${REPO_ROOT}"
CONFIG_PATH="${CONFIG_DIR}/bridge.mac.json"

mkdir -p "${CONFIG_DIR}"

if [[ -n "${WINDOWS_HOST:-}" ]]; then
  node -e "
const fs = require('node:fs');
const path = require('node:path');
const config = {
  discoveryType: 'bridgeworkspace',
  windowsHost: process.env.WINDOWS_HOST.trim(),
  windowsWsPort: 47831,
};
const configPath = process.env.CONFIG_PATH;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('Saved config with Windows fallback:', configPath);
" CONFIG_PATH="${CONFIG_PATH}" WINDOWS_HOST="${WINDOWS_HOST}"
else
  node -e "
const fs = require('node:fs');
const config = {
  discoveryType: 'bridgeworkspace',
  windowsWsPort: 47831,
};
const configPath = process.env.CONFIG_PATH;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('Saved config (auto-discover only):', configPath);
" CONFIG_PATH="${CONFIG_PATH}"
fi

echo ""
echo "Setup complete."
echo ""
echo "Start Bridge:  npm run start:mac:all"
echo ""
echo "The first time you click \"Resume Workspace\" or \"Open Project Folder\","
echo "macOS may ask you to connect to the Windows folder — approve once and you're set."
echo ""
