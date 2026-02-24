import { spawn } from 'node:child_process';
import {
  Logger,
  PathMappingOptions,
  ResumeIntent,
  WorkspaceState,
  createOpenProjectFolderIntent,
  createResumeWorkspaceIntents,
  mapWindowsPathToSharedPath,
} from '@bridge/shared';

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

async function executeResumeIntent(
  logger: Logger,
  intent: ResumeIntent,
  mapping?: PathMappingOptions,
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
    await openTarget(mapPath(intent.projectPath, mapping));
    return;
  }

  for (const openFile of intent.files) {
    const targetPath = mapPath(openFile, mapping);
    try {
      await openTarget(targetPath);
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
  mapping?: PathMappingOptions,
): Promise<boolean> {
  if (!workspaceState) {
    logger.warn('Open project requested but no workspace state is available');
    return false;
  }

  const intent = createOpenProjectFolderIntent(workspaceState);
  await executeResumeIntent(logger, intent, mapping);
  return true;
}

export async function resumeWorkspace(
  logger: Logger,
  workspaceState: WorkspaceState | null,
  mapping?: PathMappingOptions,
): Promise<boolean> {
  if (!workspaceState) {
    logger.warn('Resume workspace requested but no workspace state is available');
    return false;
  }

  const intents = createResumeWorkspaceIntents(workspaceState);
  for (const intent of intents) {
    await executeResumeIntent(logger, intent, mapping);
  }

  return true;
}
