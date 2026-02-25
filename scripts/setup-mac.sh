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

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local user_input=""

  read -r -p "${prompt} [${default_value}]: " user_input
  if [[ -z "${user_input}" ]]; then
    printf '%s' "${default_value}"
    return
  fi

  printf '%s' "${user_input}"
}

prompt_optional() {
  local prompt="$1"
  local user_input=""

  read -r -p "${prompt}: " user_input
  printf '%s' "${user_input}"
}

echo "Bridge macOS one-time setup"
echo

DEFAULT_WINDOWS_HOST="${BRIDGE_WINDOWS_HOST:-192.168.29.65}"
DEFAULT_WINDOWS_WS_PORT="${BRIDGE_WINDOWS_WS_PORT:-47831}"
DEFAULT_SHARE_NAME="${BRIDGE_SHARE_NAME:-BridgeShare}"
DEFAULT_SMB_USERNAME="${BRIDGE_SMB_USERNAME:-}"
DEFAULT_WINDOWS_PROJECT_ROOT="${BRIDGE_WINDOWS_PROJECT_ROOT:-D:/}"
DEFAULT_WINDOWS_COMMAND="${BRIDGE_WINDOWS_COMMAND:-npm -v}"
DEFAULT_WINDOWS_COMMAND_CWD="${BRIDGE_WINDOWS_COMMAND_CWD:-D:/Bridge/Bridge/agent-windows}"

if [[ "${QUICK_MODE}" -eq 1 ]]; then
  WINDOWS_HOST="${DEFAULT_WINDOWS_HOST}"
  WINDOWS_WS_PORT="${DEFAULT_WINDOWS_WS_PORT}"
  SHARE_NAME="${DEFAULT_SHARE_NAME}"
  SMB_USERNAME="${DEFAULT_SMB_USERNAME}"
  WINDOWS_PROJECT_ROOT="${DEFAULT_WINDOWS_PROJECT_ROOT}"
  WINDOWS_COMMAND="${DEFAULT_WINDOWS_COMMAND}"
  WINDOWS_COMMAND_CWD="${DEFAULT_WINDOWS_COMMAND_CWD}"
else
  WINDOWS_HOST="$(prompt_with_default "Windows host IP or name" "${DEFAULT_WINDOWS_HOST}")"
  WINDOWS_WS_PORT="$(prompt_with_default "Windows websocket port" "${DEFAULT_WINDOWS_WS_PORT}")"
  SHARE_NAME="$(prompt_with_default "Windows SMB share name" "${DEFAULT_SHARE_NAME}")"
  SMB_USERNAME="$(prompt_optional "Windows SMB username (optional, example: ASUS\\\\bridgeuser)")"
  WINDOWS_PROJECT_ROOT="$(prompt_with_default "Windows shared project root" "${DEFAULT_WINDOWS_PROJECT_ROOT}")"
  WINDOWS_COMMAND="$(prompt_with_default "Default Windows command (tray run action)" "${DEFAULT_WINDOWS_COMMAND}")"
  WINDOWS_COMMAND_CWD="$(prompt_with_default "Windows command cwd" "${DEFAULT_WINDOWS_COMMAND_CWD}")"
fi

ENCODED_SHARE_NAME="$(SHARE_NAME="${SHARE_NAME}" node -e 'process.stdout.write(encodeURIComponent(process.env.SHARE_NAME || ""))')"
SMB_AUTHORITY="${WINDOWS_HOST}"
if [[ -n "${SMB_USERNAME}" ]]; then
  ENCODED_SMB_USERNAME="$(SMB_USERNAME="${SMB_USERNAME}" node -e 'process.stdout.write(encodeURIComponent(process.env.SMB_USERNAME || ""))')"
  SMB_AUTHORITY="${ENCODED_SMB_USERNAME}@${WINDOWS_HOST}"
fi
SMB_ROOT="smb://${SMB_AUTHORITY}/${ENCODED_SHARE_NAME}"
MOUNT_ROOT="/Volumes/${SHARE_NAME}"

WINDOWS_HOST="${WINDOWS_HOST}" \
WINDOWS_WS_PORT="${WINDOWS_WS_PORT}" \
SHARE_NAME="${SHARE_NAME}" \
WINDOWS_PROJECT_ROOT="${WINDOWS_PROJECT_ROOT}" \
SMB_ROOT="${SMB_ROOT}" \
MOUNT_ROOT="${MOUNT_ROOT}" \
WINDOWS_COMMAND="${WINDOWS_COMMAND}" \
WINDOWS_COMMAND_CWD="${WINDOWS_COMMAND_CWD}" \
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const configPath = path.join(process.cwd(), 'bridge.mac.json');
const config = {
  discoveryType: 'bridgeworkspace',
  windowsHost: process.env.WINDOWS_HOST,
  windowsWsPort: Number(process.env.WINDOWS_WS_PORT || '47831'),
  windowsProjectRoot: process.env.WINDOWS_PROJECT_ROOT,
  smbRoot: process.env.SMB_ROOT,
  smbMountRoot: process.env.MOUNT_ROOT,
  windowsCommand: process.env.WINDOWS_COMMAND,
  windowsCommandCwd: process.env.WINDOWS_COMMAND_CWD,
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log(`Wrote ${configPath}`);
NODE

echo
echo "Triggering SMB mount prompt (accept once and save in Keychain)..."
open "${SMB_ROOT}" || true

if ! open -Ra "Windows App" >/dev/null 2>&1 && ! open -Ra "Microsoft Remote Desktop" >/dev/null 2>&1; then
  echo
  echo "For full Windows control from Bridge tray, install one of:"
  echo "  - Windows App (Microsoft)"
  echo "  - Microsoft Remote Desktop"
fi

echo
echo "Setup done. Next runs are simple:"
echo "  npm run start:mac:all"
echo "Or separately:"
echo "  npm run start:mac"
echo "  npm run start:tray"
