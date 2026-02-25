import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Logger } from '@bridge/shared';

const LABEL = 'com.bridge.agent-mac';
const PLIST_NAME = `${LABEL}.plist`;

function getLaunchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function getPlistPath(): string {
  return path.join(getLaunchAgentsDir(), PLIST_NAME);
}

function getNodePath(): string {
  return process.execPath;
}

function getAgentEntryPoint(): string {
  return path.resolve(__dirname, 'index.js');
}

function getLogDir(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'Bridge');
}

function buildPlist(nodePath: string, entryPoint: string, logDir: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${nodePath}</string>`,
    `    <string>${entryPoint}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${logDir}/agent-mac.log</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${logDir}/agent-mac.err.log</string>`,
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export async function ensureAutoStartPrepared(logger: Logger): Promise<void> {
  if (process.platform !== 'darwin') {
    logger.info('Skipping LaunchAgent setup on non-macOS platform');
    return;
  }

  const plistPath = getPlistPath();
  const nodePath = getNodePath();
  const entryPoint = getAgentEntryPoint();
  const logDir = getLogDir();

  const desiredContent = buildPlist(nodePath, entryPoint, logDir);

  try {
    await mkdir(getLaunchAgentsDir(), { recursive: true });
    await mkdir(logDir, { recursive: true });

    if (existsSync(plistPath)) {
      const existing = await readFile(plistPath, 'utf8');
      if (existing === desiredContent) {
        logger.info('LaunchAgent plist is up to date', { path: plistPath });
        return;
      }
    }

    await writeFile(plistPath, desiredContent, 'utf8');
    logger.info('LaunchAgent plist written for login autostart', {
      path: plistPath,
      label: LABEL,
    });
  } catch (error) {
    const typed = error as Error;
    logger.warn('Failed to write LaunchAgent plist', {
      path: plistPath,
      error: typed.message,
    });
  }
}

export async function removeAutoStart(logger: Logger): Promise<void> {
  const plistPath = getPlistPath();

  if (!existsSync(plistPath)) {
    return;
  }

  try {
    await unlink(plistPath);
    logger.info('LaunchAgent plist removed', { path: plistPath });
  } catch (error) {
    const typed = error as Error;
    logger.warn('Failed to remove LaunchAgent plist', {
      path: plistPath,
      error: typed.message,
    });
  }
}
