import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface WindowsConfigFile {
  wsPort?: number;
  discoveryType?: string;
  projectPath?: string;
  sharedWindowsRoot?: string;
  windowsProjectRoot?: string;
  shareName?: string;
  remoteControlEnabled?: boolean | string;
  remoteProtocol?: string;
  remotePort?: number | string;
  remoteUsername?: string;
  statePath?: string;
  processPollMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  commandTimeoutMs?: number;
  allowedCommands?: string[] | string;
  hostId?: string;
  hostName?: string;
  openFiles?: string[] | string;
}

export interface WindowsAgentConfig {
  wsPort: number;
  discoveryType: string;
  projectPath: string;
  sharedWindowsRoot: string;
  shareName?: string;
  remoteControlEnabled: boolean;
  remoteProtocol: 'rdp';
  remotePort: number;
  remoteUsername?: string;
  statePath: string;
  processPollMs: number;
  heartbeatMs: number;
  heartbeatTimeoutMs: number;
  commandTimeoutMs: number;
  allowedCommands: string[];
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

function toNumberFromUnknown(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }

  return fallback;
}

function toBooleanFromUnknown(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return toBoolean(value, fallback);
  }

  return fallback;
}

function toStringArray(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function loadWindowsConfigFile(): WindowsConfigFile {
  const candidates = [
    process.env.BRIDGE_WINDOWS_CONFIG_PATH,
    path.join(process.cwd(), 'bridge.windows.json'),
    path.join(os.homedir(), '.bridge', 'bridge.windows.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as WindowsConfigFile;
      return parsed;
    } catch {
      continue;
    }
  }

  return {};
}

export function loadWindowsAgentConfig(): WindowsAgentConfig {
  const fileConfig = loadWindowsConfigFile();

  const projectPath =
    process.env.BRIDGE_PROJECT_PATH ?? fileConfig.projectPath ?? process.cwd();
  const sharedWindowsRoot =
    process.env.BRIDGE_WINDOWS_PROJECT_ROOT ??
    fileConfig.windowsProjectRoot ??
    fileConfig.sharedWindowsRoot ??
    projectPath;

  const statePath =
    process.env.BRIDGE_WINDOWS_STATE_PATH ??
    fileConfig.statePath ??
    path.join(os.homedir(), '.bridge', 'windows-state.json');

  const remoteControlEnabled =
    process.env.BRIDGE_REMOTE_CONTROL_ENABLED !== undefined
      ? toBoolean(process.env.BRIDGE_REMOTE_CONTROL_ENABLED, true)
      : toBooleanFromUnknown(fileConfig.remoteControlEnabled, true);

  const remotePort =
    process.env.BRIDGE_REMOTE_PORT !== undefined
      ? toNumber(process.env.BRIDGE_REMOTE_PORT, 3389)
      : toNumberFromUnknown(fileConfig.remotePort, 3389);

  const remoteProtocolRaw =
    process.env.BRIDGE_REMOTE_PROTOCOL ?? fileConfig.remoteProtocol ?? 'rdp';
  const remoteProtocol = remoteProtocolRaw.toLowerCase() === 'rdp' ? 'rdp' : 'rdp';

  const openFilesRaw = process.env.BRIDGE_OPEN_FILES;
  const fileOpenFiles = toStringArray(fileConfig.openFiles);
  const mockOpenFiles = (openFilesRaw
    ? toStringArray(openFilesRaw)
    : fileOpenFiles
  ).map((item) => (path.isAbsolute(item) ? item : path.join(projectPath, item)));

  const allowedCommandsRaw = process.env.BRIDGE_ALLOWED_COMMANDS;
  const fileAllowedCommands = toStringArray(fileConfig.allowedCommands);
  const allowedCommands = (allowedCommandsRaw
    ? toStringArray(allowedCommandsRaw)
    : fileAllowedCommands.length > 0
      ? fileAllowedCommands
      : ['npm', 'pnpm', 'yarn', 'node', 'npx', 'git', 'python', 'pytest', 'dotnet', 'cargo', 'go']
  ).map((command) => command.trim().toLowerCase());

  return {
    wsPort:
      process.env.BRIDGE_WS_PORT !== undefined
        ? toNumber(process.env.BRIDGE_WS_PORT, 47831)
        : toNumberFromUnknown(fileConfig.wsPort, 47831),
    discoveryType:
      process.env.BRIDGE_DISCOVERY_TYPE ??
      fileConfig.discoveryType ??
      'bridgeworkspace',
    projectPath,
    sharedWindowsRoot,
    shareName: process.env.BRIDGE_SHARE_NAME ?? fileConfig.shareName,
    remoteControlEnabled,
    remoteProtocol,
    remotePort,
    remoteUsername: process.env.BRIDGE_REMOTE_USERNAME ?? fileConfig.remoteUsername,
    statePath,
    processPollMs:
      process.env.BRIDGE_PROCESS_POLL_MS !== undefined
        ? toNumber(process.env.BRIDGE_PROCESS_POLL_MS, 5000)
        : toNumberFromUnknown(fileConfig.processPollMs, 5000),
    heartbeatMs:
      process.env.BRIDGE_HEARTBEAT_MS !== undefined
        ? toNumber(process.env.BRIDGE_HEARTBEAT_MS, 4000)
        : toNumberFromUnknown(fileConfig.heartbeatMs, 4000),
    heartbeatTimeoutMs:
      process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS !== undefined
        ? toNumber(process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS, 12000)
        : toNumberFromUnknown(fileConfig.heartbeatTimeoutMs, 12000),
    commandTimeoutMs:
      process.env.BRIDGE_COMMAND_TIMEOUT_MS !== undefined
        ? toNumber(process.env.BRIDGE_COMMAND_TIMEOUT_MS, 900000)
        : toNumberFromUnknown(fileConfig.commandTimeoutMs, 900000),
    allowedCommands,
    hostId: process.env.BRIDGE_HOST_ID ?? fileConfig.hostId ?? os.hostname(),
    hostName: process.env.BRIDGE_HOST_NAME ?? fileConfig.hostName ?? os.hostname(),
    mockOpenFiles,
  };
}
