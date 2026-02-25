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
  allMappings?: PathMappingOptions[];
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

function toWindowsSegments(value: string): string[] {
  return value
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .split('\\')
    .filter((segment) => segment.length > 0);
}

function tryMapWithMapping(
  windowsPath: string,
  mapping: PathMappingOptions,
): string | null {
  const sourceSegments = toWindowsSegments(windowsPath);
  const rootSegments = toWindowsSegments(mapping.windowsRoot);
  if (rootSegments.length === 0 || sourceSegments.length < rootSegments.length) {
    return null;
  }

  for (let index = 0; index < rootSegments.length; index += 1) {
    if (sourceSegments[index].toLowerCase() !== rootSegments[index].toLowerCase()) {
      return null;
    }
  }

  const smbParsed = parseSmbRoot(mapping.smbRoot);
  if (!smbParsed) {
    return null;
  }

  const mountRoot = path.join('/Volumes', smbParsed.shareName);
  const relativeSegments = sourceSegments.slice(rootSegments.length);
  return path.join(mountRoot, ...smbParsed.shareSubPath, ...relativeSegments);
}

function mapWindowsPathToMountedPath(
  windowsPath: string,
  accessOptions: ResumeAccessOptions,
): string | null {
  const candidates = accessOptions.allMappings ?? [];
  if (accessOptions.mapping) {
    candidates.unshift(accessOptions.mapping);
  }

  for (const mapping of candidates) {
    const result = tryMapWithMapping(windowsPath, mapping);
    if (result) {
      return result;
    }
  }

  return null;
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

function mountRootForMapping(mapping: PathMappingOptions): string | null {
  const parsed = parseSmbRoot(mapping.smbRoot);
  if (!parsed) {
    return null;
  }
  return path.join('/Volumes', parsed.shareName);
}

async function mountSingleShare(
  logger: Logger,
  mapping: PathMappingOptions,
  timeoutMs: number,
): Promise<void> {
  if (!mapping.smbRoot.startsWith('smb://')) {
    return;
  }

  const mountRoot = mountRootForMapping(mapping);
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

  const mounted = await waitForPath(mountRoot, timeoutMs);
  if (!mounted) {
    logger.warn('SMB share was not confirmed as mounted before timeout', {
      mountRoot,
      timeoutMs,
    });
  }
}

async function ensureShareMounted(
  logger: Logger,
  accessOptions: ResumeAccessOptions,
): Promise<void> {
  const timeoutMs = accessOptions.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;

  const mappingsToMount: PathMappingOptions[] = [];
  if (accessOptions.allMappings && accessOptions.allMappings.length > 0) {
    mappingsToMount.push(...accessOptions.allMappings);
  } else if (accessOptions.mapping) {
    mappingsToMount.push(accessOptions.mapping);
  }

  for (const mapping of mappingsToMount) {
    await mountSingleShare(logger, mapping, timeoutMs);
  }
}

function findMatchingMapping(
  rawWindowsPath: string,
  accessOptions: ResumeAccessOptions,
): PathMappingOptions | undefined {
  const allMappings = accessOptions.allMappings ?? [];
  const primary = accessOptions.mapping;
  const candidates = primary ? [primary, ...allMappings] : allMappings;

  for (const mapping of candidates) {
    const segments = toWindowsSegments(rawWindowsPath);
    const rootSegments = toWindowsSegments(mapping.windowsRoot);
    if (rootSegments.length === 0 || segments.length < rootSegments.length) {
      continue;
    }
    let match = true;
    for (let i = 0; i < rootSegments.length; i += 1) {
      if (segments[i].toLowerCase() !== rootSegments[i].toLowerCase()) {
        match = false;
        break;
      }
    }
    if (match) {
      return mapping;
    }
  }

  return primary;
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

  const bestMapping = findMatchingMapping(rawWindowsPath, accessOptions);
  const mappedPath = mapPath(rawWindowsPath, bestMapping);
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

  const hasMapping = Boolean(accessOptions.mapping) ||
    (accessOptions.allMappings && accessOptions.allMappings.length > 0);

  if (!hasMapping && isWindowsPath(workspaceState.projectPath)) {
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

  const hasMapping = Boolean(accessOptions.mapping) ||
    (accessOptions.allMappings && accessOptions.allMappings.length > 0);

  if (!hasMapping && isWindowsPath(workspaceState.projectPath)) {
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
