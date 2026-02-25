import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Logger } from '@bridge/shared';

const STARTUP_SCRIPT_NAME = 'BridgeAgent.vbs';

function getStartupDir(): string {
  const appData = process.env.APPDATA;
  if (appData) {
    return path.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
    );
  }

  return path.join(
    os.homedir(),
    'AppData',
    'Roaming',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
}

function getStartupScriptPath(): string {
  return path.join(getStartupDir(), STARTUP_SCRIPT_NAME);
}

function getNodePath(): string {
  return process.execPath;
}

function getAgentEntryPoint(): string {
  return path.resolve(__dirname, 'index.js');
}

function buildVbsScript(nodePath: string, entryPoint: string): string {
  const workingDir = path.dirname(entryPoint);
  return [
    'Set objShell = CreateObject("WScript.Shell")',
    `objShell.CurrentDirectory = "${workingDir}"`,
    `objShell.Run """${nodePath}"" ""${entryPoint}""", 0, False`,
    '',
  ].join('\r\n');
}

export async function ensureAutoStartPrepared(logger: Logger): Promise<void> {
  if (process.platform !== 'win32') {
    logger.info('Skipping Windows Startup registration on non-Windows platform');
    return;
  }

  const scriptPath = getStartupScriptPath();
  const nodePath = getNodePath();
  const entryPoint = getAgentEntryPoint();

  const desiredContent = buildVbsScript(nodePath, entryPoint);

  try {
    const startupDir = getStartupDir();
    await mkdir(startupDir, { recursive: true });

    if (existsSync(scriptPath)) {
      const existing = await readFile(scriptPath, 'utf8');
      if (existing === desiredContent) {
        logger.info('Startup script is up to date', { path: scriptPath });
        return;
      }
    }

    await writeFile(scriptPath, desiredContent, 'utf8');
    logger.info('Startup script written for login autostart', {
      path: scriptPath,
    });
  } catch (error) {
    const typed = error as Error;
    logger.warn('Failed to write Startup script', {
      path: scriptPath,
      error: typed.message,
    });
  }
}

export async function removeAutoStart(logger: Logger): Promise<void> {
  const scriptPath = getStartupScriptPath();

  if (!existsSync(scriptPath)) {
    return;
  }

  try {
    await unlink(scriptPath);
    logger.info('Startup script removed', { path: scriptPath });
  } catch (error) {
    const typed = error as Error;
    logger.warn('Failed to remove Startup script', {
      path: scriptPath,
      error: typed.message,
    });
  }
}
