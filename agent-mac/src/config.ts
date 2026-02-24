import os from 'node:os';
import path from 'node:path';
import { PathMappingOptions } from '@bridge/shared';

export interface MacAgentConfig {
  discoveryType: string;
  statePath: string;
  uiBridgePort: number;
  pingMs: number;
  heartbeatTimeoutMs: number;
  discoveryStaleMs: number;
  discoverySweepMs: number;
  pathMapping?: PathMappingOptions;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadMacAgentConfig(): MacAgentConfig {
  const statePath =
    process.env.BRIDGE_MAC_STATE_PATH ??
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Bridge',
      'mac-state.json',
    );

  const windowsRoot = process.env.BRIDGE_WINDOWS_PROJECT_ROOT;
  const smbRoot = process.env.BRIDGE_SMB_ROOT;
  const pathMapping =
    windowsRoot && smbRoot
      ? {
          windowsRoot,
          smbRoot,
        }
      : undefined;

  return {
    discoveryType: process.env.BRIDGE_DISCOVERY_TYPE ?? 'bridgeworkspace',
    statePath,
    uiBridgePort: toNumber(process.env.BRIDGE_UI_BRIDGE_PORT, 47832),
    pingMs: toNumber(process.env.BRIDGE_PING_MS, 5000),
    heartbeatTimeoutMs: toNumber(process.env.BRIDGE_HEARTBEAT_TIMEOUT_MS, 12000),
    discoveryStaleMs: toNumber(process.env.BRIDGE_DISCOVERY_STALE_MS, 15000),
    discoverySweepMs: toNumber(process.env.BRIDGE_DISCOVERY_SWEEP_MS, 4000),
    pathMapping,
  };
}
