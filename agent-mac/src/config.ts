import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PathMappingOptions } from '@bridge/shared';

interface MacConfigFile {
  discoveryType?: string;
  windowsHost?: string;
  windowsWsPort?: number;
  pairingPath?: string;
  statePath?: string;
  uiBridgePort?: number;
  pingMs?: number;
  heartbeatTimeoutMs?: number;
  discoveryStaleMs?: number;
  discoverySweepMs?: number;
  smbMountRoot?: string;
  smbMountTimeoutMs?: number;
  windowsCommand?: string;
  windowsCommandCwd?: string;
  windowsProjectRoot?: string;
  smbRoot?: string;
}

export interface MacAgentConfig {
  discoveryType: string;
  windowsHost?: string;
  windowsWsPort: number;
  pairingPath: string;
  statePath: string;
  uiBridgePort: number;
  pingMs: number;
  heartbeatTimeoutMs: number;
  discoveryStaleMs: number;
  discoverySweepMs: number;
  smbMountRoot?: string;
  smbMountTimeoutMs: number;
  windowsCommand: string;
  windowsCommandCwd?: string;
  pathMapping?: PathMappingOptions;
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

function loadMacConfigFile(): MacConfigFile {
  const candidates = [
    process.env.BRIDGE_MAC_CONFIG_PATH,
    path.join(process.cwd(), 'bridge.mac.json'),
    path.join(os.homedir(), '.bridge', 'bridge.mac.json'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as MacConfigFile;
      return parsed;
    } catch {
      continue;
    }
  }

  return {};
}

export function loadMacAgentConfig(): MacAgentConfig {
  const fileConfig = loadMacConfigFile();

  const statePath =
    process.env.BRIDGE_MAC_STATE_PATH ??
    fileConfig.statePath ??
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Bridge',
      'mac-state.json',
    );

  const pairingPath =
    process.env.BRIDGE_MAC_PAIRING_PATH ??
    fileConfig.pairingPath ??
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Bridge',
      'mac-pairing.json',
    );

  const windowsRoot =
    process.env.BRIDGE_WINDOWS_PROJECT_ROOT ?? fileConfig.windowsProjectRoot;
  const smbRoot = process.env.BRIDGE_SMB_ROOT ?? fileConfig.smbRoot;
  const pathMapping =
    windowsRoot && smbRoot
      ? {
          windowsRoot,
          smbRoot,
        }
      : undefined;

  return {
    discoveryType:
      process.env.BRIDGE_DISCOVERY_TYPE ??
      fileConfig.discoveryType ??
      'bridgeworkspace',
    windowsHost: process.env.BRIDGE_WINDOWS_HOST ?? fileConfig.windowsHost,
    windowsWsPort:
      process.env.BRIDGE_WINDOWS_WS_PORT !== undefined
        ? toNumber(process.env.BRIDGE_WINDOWS_WS_PORT, 47831)
        : toNumberFromUnknown(fileConfig.windowsWsPort, 47831),
    pairingPath,
    statePath,
    uiBridgePort:
      process.env.BRIDGE_UI_BRIDGE_PORT !== undefined
        ? toNumber(process.env.BRIDGE_UI_BRIDGE_PORT, 47832)
        : toNumberFromUnknown(fileConfig.uiBridgePort, 47832),
    pingMs:
      process.env.BRIDGE_PING_MS !== undefined
        ? toNumber(process.env.BRIDGE_PING_MS, 5000)
        : toNumberFromUnknown(fileConfig.pingMs, 5000),
    heartbeatTimeoutMs:
      process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS !== undefined
        ? toNumber(process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS, 12000)
        : toNumberFromUnknown(fileConfig.heartbeatTimeoutMs, 12000),
    discoveryStaleMs:
      process.env.BRIDGE_DISCOVERY_STALE_MS !== undefined
        ? toNumber(process.env.BRIDGE_DISCOVERY_STALE_MS, 15000)
        : toNumberFromUnknown(fileConfig.discoveryStaleMs, 15000),
    discoverySweepMs:
      process.env.BRIDGE_DISCOVERY_SWEEP_MS !== undefined
        ? toNumber(process.env.BRIDGE_DISCOVERY_SWEEP_MS, 4000)
        : toNumberFromUnknown(fileConfig.discoverySweepMs, 4000),
    smbMountRoot: process.env.BRIDGE_SMB_MOUNT_ROOT ?? fileConfig.smbMountRoot,
    smbMountTimeoutMs:
      process.env.BRIDGE_SMB_MOUNT_TIMEOUT_MS !== undefined
        ? toNumber(process.env.BRIDGE_SMB_MOUNT_TIMEOUT_MS, 12000)
        : toNumberFromUnknown(fileConfig.smbMountTimeoutMs, 12000),
    windowsCommand:
      process.env.BRIDGE_WINDOWS_COMMAND ?? fileConfig.windowsCommand ?? 'npm -v',
    windowsCommandCwd:
      process.env.BRIDGE_WINDOWS_COMMAND_CWD ?? fileConfig.windowsCommandCwd,
    pathMapping,
  };
}
