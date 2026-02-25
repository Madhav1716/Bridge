import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeServiceRecord, Logger } from '@bridge/shared';

const DEFAULT_RDP_PORT = 3389;

function sanitizeForFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'bridge-host';
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_RDP_PORT;
  }

  const parsed = Number(rawPort);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_RDP_PORT;
  }

  return parsed;
}

function isRemoteControlEnabled(service: BridgeServiceRecord): boolean {
  const rawFlag = service.txt.remoteControl?.trim().toLowerCase();
  if (!rawFlag) {
    return true;
  }

  return rawFlag === '1' || rawFlag === 'true' || rawFlag === 'yes';
}

function buildRdpProfile(
  host: string,
  port: number,
  username?: string,
): string {
  const lines = [
    `full address:s:${host}:${port}`,
    'prompt for credentials:i:1',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    'redirectclipboard:i:1',
    'screen mode id:i:2',
  ];

  if (username && username.trim().length > 0) {
    lines.push(`username:s:${username.trim()}`);
  }

  return `${lines.join('\r\n')}\r\n`;
}

async function openTarget(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('open', args, {
      stdio: 'ignore',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`open exited with code ${code}`));
    });
  });
}

async function launchRdpProfile(profilePath: string): Promise<void> {
  try {
    await openTarget(['-a', 'Windows App', profilePath]);
    return;
  } catch {
    try {
      await openTarget(['-a', 'Microsoft Remote Desktop', profilePath]);
      return;
    } catch {
      // Final fallback for environments where app association is configured.
      await openTarget([profilePath]);
    }
  }
}

export async function openRemoteControlSession(
  logger: Logger,
  service: BridgeServiceRecord | null,
): Promise<boolean> {
  if (!service) {
    logger.warn('Remote control requested but no Windows host is selected');
    return false;
  }

  if (!isRemoteControlEnabled(service)) {
    logger.warn('Remote control is disabled by Windows host policy', {
      host: service.name,
      hostId: service.identity,
    });
    return false;
  }

  const protocol = (service.txt.remoteProtocol ?? 'rdp').trim().toLowerCase();
  if (protocol !== 'rdp') {
    logger.warn('Unsupported remote control protocol from host', {
      host: service.name,
      hostId: service.identity,
      protocol,
    });
    return false;
  }

  const host = service.host;
  const port = parsePort(service.txt.remotePort);
  const username = service.txt.remoteUsername?.trim();

  const profileName = `bridge-${sanitizeForFileName(service.identity)}.rdp`;
  const profilePath = path.join(os.tmpdir(), profileName);
  const profileContent = buildRdpProfile(host, port, username);

  try {
    await fs.writeFile(profilePath, profileContent, 'utf8');
    await launchRdpProfile(profilePath);

    logger.info('Remote control session launch requested', {
      host,
      port,
      username: username ?? null,
      profilePath,
    });

    return true;
  } catch (error) {
    const typed = error as Error;
    logger.warn('Failed to open Remote Desktop session', {
      host,
      port,
      error: typed.message,
      hint: 'Install Windows App or Microsoft Remote Desktop on macOS and retry',
    });
    return false;
  }
}
