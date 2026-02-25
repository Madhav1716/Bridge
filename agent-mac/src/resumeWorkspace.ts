import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  Logger,
  PathMappingOptions,
  ResumeIntent,
  WorkspaceState,
  createOpenProjectFolderIntent,
  createResumeWorkspaceIntents,
  mapWindowsPathToSharedPath,
} from '@bridge/shared';

export interface ResumeAccessOptions {
  mapping?: PathMappingOptions;
  smbMountRoot?: string;
  mountTimeoutMs?: number;
}

interface ParsedSmbRoot {
  shareName: string;
  shareSubPath: string[];
}

const DEFAULT_MOUNT_TIMEOUT_MS = 12000;

async function openTarget(target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('open', [target], {
      stdio: 'ignore',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`open exited with code ${code}`));
        return;
      }

      resolve();
    });
  });
}

function mapPath(rawPath: string, mapping?: PathMappingOptions): string {
  return mapWindowsPathToSharedPath(rawPath, mapping);
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function parseSmbRoot(smbRoot: string): ParsedSmbRoot | null {
  if (!smbRoot.startsWith('smb://')) {
    return null;
  }

  try {
    const parsed = new URL(smbRoot);
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

    if (segments.length === 0) {
      return null;
    }

    return {
      shareName: segments[0],
      shareSubPath: segments.slice(1),
    };
  } catch {
    return null;
  }
}

function deriveMountRoot(accessOptions: ResumeAccessOptions): string | null {
  if (accessOptions.smbMountRoot) {
    return accessOptions.smbMountRoot;
  }

  const smbRoot = accessOptions.mapping?.smbRoot;
  if (!smbRoot) {
    return null;
  }

  const parsedRoot = parseSmbRoot(smbRoot);
  if (!parsedRoot) {
    return null;
  }

  return path.join('/Volumes', parsedRoot.shareName);
}

function toWindowsSegments(value: string): string[] {
  return value
    .replace(/\//g, '\\')
    .split('\\')
    .filter((segment) => segment.length > 0);
}

function mapWindowsPathToMountedPath(
  windowsPath: string,
  accessOptions: ResumeAccessOptions,
): string | null {
  const mapping = accessOptions.mapping;
  if (!mapping) {
    return null;
  }

  const normalizedPath = normalizeWindowsPath(windowsPath);
  const normalizedRoot = normalizeWindowsPath(mapping.windowsRoot);
  if (!normalizedPath.startsWith(normalizedRoot)) {
    return null;
  }

  const smbParsed = parseSmbRoot(mapping.smbRoot);
  const mountRoot = deriveMountRoot(accessOptions);
  if (!smbParsed || !mountRoot) {
    return null;
  }

  const sourcePath = windowsPath.replace(/\//g, '\\');
  const sourceRoot = mapping.windowsRoot.replace(/\//g, '\\').replace(/\\+$/g, '');
  const relativeRaw = sourcePath.slice(sourceRoot.length).replace(/^\\+/, '');
  const relativeSegments = toWindowsSegments(relativeRaw);

  return path.join(mountRoot, ...smbParsed.shareSubPath, ...relativeSegments);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(target: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await pathExists(target)) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 350);
    });
  }

  return false;
}

async function ensureShareMounted(
  logger: Logger,
  accessOptions: ResumeAccessOptions,
): Promise<void> {
  const mapping = accessOptions.mapping;
  if (!mapping || !mapping.smbRoot.startsWith('smb://')) {
    return;
  }

  const mountRoot = deriveMountRoot(accessOptions);
  if (!mountRoot) {
    return;
  }

  if (await pathExists(mountRoot)) {
    return;
  }

  logger.info('Mounting SMB share for workspace access', {
    smbRoot: mapping.smbRoot,
    mountRoot,
  });

  try {
    await openTarget(mapping.smbRoot);
  } catch (error) {
    const typed = error as Error;
    logger.warn('Failed to trigger SMB mount', {
      smbRoot: mapping.smbRoot,
      error: typed.message,
    });
    return;
  }

  const mountTimeoutMs = accessOptions.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;
  const mounted = await waitForPath(mountRoot, mountTimeoutMs);

  if (!mounted) {
    logger.warn('SMB share was not confirmed as mounted before timeout', {
      mountRoot,
      timeoutMs: mountTimeoutMs,
    });
  }
}

async function resolveOpenCandidates(
  rawWindowsPath: string,
  accessOptions: ResumeAccessOptions,
): Promise<string[]> {
  const candidates: string[] = [];

  const mountedPath = mapWindowsPathToMountedPath(rawWindowsPath, accessOptions);
  if (mountedPath && (await pathExists(mountedPath))) {
    candidates.push(mountedPath);
  }

  const mappedPath = mapPath(rawWindowsPath, accessOptions.mapping);
  candidates.push(mappedPath);

  if (mountedPath && !candidates.includes(mountedPath)) {
    candidates.push(mountedPath);
  }

  return Array.from(new Set(candidates));
}

async function openWithFallback(
  logger: Logger,
  sourcePath: string,
  candidates: string[],
): Promise<void> {
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      await openTarget(candidate);
      return;
    } catch (error) {
      const typed = error as Error;
      lastError = typed;
      logger.warn('Failed to open mapped target, trying fallback', {
        sourcePath,
        candidate,
        error: typed.message,
      });
    }
  }

  if (lastError) {
    throw lastError;
  }
}

async function executeResumeIntent(
  logger: Logger,
  intent: ResumeIntent,
  accessOptions: ResumeAccessOptions,
): Promise<void> {
  if (intent.type === 'RESUME_CONTEXT') {
    logger.event(
      {
        component: 'resume-workspace',
        event: 'resume-context',
      },
      {
        projectName: intent.projectName,
        hostDevice: intent.hostDevice,
        lastEvent: intent.lastEvent,
      },
    );
    return;
  }

  if (intent.type === 'OPEN_PROJECT_FOLDER') {
    const candidates = await resolveOpenCandidates(intent.projectPath, accessOptions);
    await openWithFallback(logger, intent.projectPath, candidates);
    return;
  }

  for (const openFile of intent.files) {
    try {
      const candidates = await resolveOpenCandidates(openFile, accessOptions);
      await openWithFallback(logger, openFile, candidates);
    } catch (error) {
      const typed = error as Error;
      logger.warn('Failed to open workspace file during resume', {
        openFile,
        error: typed.message,
      });
    }
  }
}

export async function openProjectFolder(
  logger: Logger,
  workspaceState: WorkspaceState | null,
  accessOptions: ResumeAccessOptions = {},
): Promise<boolean> {
  if (!workspaceState) {
    logger.warn('Open project requested but no workspace state is available');
    return false;
  }

  if (
    !accessOptions.mapping &&
    isWindowsPath(workspaceState.projectPath)
  ) {
    logger.warn(
      'Open project requires Windows-to-SMB mapping (set BRIDGE_WINDOWS_PROJECT_ROOT and BRIDGE_SMB_ROOT)',
      { projectPath: workspaceState.projectPath },
    );
    return false;
  }

  await ensureShareMounted(logger, accessOptions);
  const intent = createOpenProjectFolderIntent(workspaceState);
  try {
    await executeResumeIntent(logger, intent, accessOptions);
    return true;
  } catch (error) {
    const typed = error as Error;
    logger.warn('Open project action failed', {
      projectPath: workspaceState.projectPath,
      error: typed.message,
    });
    return false;
  }
}

export async function resumeWorkspace(
  logger: Logger,
  workspaceState: WorkspaceState | null,
  accessOptions: ResumeAccessOptions = {},
): Promise<boolean> {
  if (!workspaceState) {
    logger.warn('Resume workspace requested but no workspace state is available');
    return false;
  }

  if (
    !accessOptions.mapping &&
    isWindowsPath(workspaceState.projectPath)
  ) {
    logger.warn(
      'Resume workspace requires Windows-to-SMB mapping (set BRIDGE_WINDOWS_PROJECT_ROOT and BRIDGE_SMB_ROOT)',
      { projectPath: workspaceState.projectPath },
    );
    return false;
  }

  await ensureShareMounted(logger, accessOptions);

  const intents = createResumeWorkspaceIntents(workspaceState);
  try {
    for (const intent of intents) {
      await executeResumeIntent(logger, intent, accessOptions);
    }
    return true;
  } catch (error) {
    const typed = error as Error;
    logger.warn('Resume workspace action failed', {
      projectPath: workspaceState.projectPath,
      error: typed.message,
    });
    return false;
  }
}
