import os from 'node:os';
import path from 'node:path';

export interface WindowsAgentConfig {
  wsPort: number;
  discoveryType: string;
  projectPath: string;
  statePath: string;
  processPollMs: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  hostId: string;
  hostName: string;
  mockOpenFiles: string[];
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadWindowsAgentConfig(): WindowsAgentConfig {
  const projectPath = process.env.BRIDGE_PROJECT_PATH ?? process.cwd();
  const statePath =
    process.env.BRIDGE_WINDOWS_STATE_PATH ??
    path.join(os.homedir(), '.bridge', 'windows-state.json');

  const openFilesRaw = process.env.BRIDGE_OPEN_FILES ?? '';
  const mockOpenFiles = openFilesRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (path.isAbsolute(item) ? item : path.join(projectPath, item)));

  return {
    wsPort: toNumber(process.env.BRIDGE_WS_PORT, 47831),
    discoveryType: process.env.BRIDGE_DISCOVERY_TYPE ?? 'bridgeworkspace',
    projectPath,
    statePath,
    processPollMs: toNumber(process.env.BRIDGE_PROCESS_POLL_MS, 5000),
    heartbeatMs: toNumber(process.env.BRIDGE_HEARTBEAT_MS, 4000),
    heartbeatTimeoutMs: toNumber(process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS, 12000),
    hostId: process.env.BRIDGE_HOST_ID ?? os.hostname(),
    hostName: process.env.BRIDGE_HOST_NAME ?? os.hostname(),
    mockOpenFiles,
  };
}
