import { WorkspaceState } from '../types';

export type ResumeIntentType =
  | 'OPEN_PROJECT_FOLDER'
  | 'OPEN_FILES'
  | 'RESUME_CONTEXT';

export interface OpenProjectFolderIntent {
  type: 'OPEN_PROJECT_FOLDER';
  projectPath: string;
}

export interface OpenFilesIntent {
  type: 'OPEN_FILES';
  files: string[];
}

export interface ResumeContextIntent {
  type: 'RESUME_CONTEXT';
  projectName: string;
  hostDevice: string;
  lastEvent: string;
}

export type ResumeIntent =
  | OpenProjectFolderIntent
  | OpenFilesIntent
  | ResumeContextIntent;

interface ResumeIntentOptions {
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 8;

export function createOpenProjectFolderIntent(
  state: WorkspaceState,
): OpenProjectFolderIntent {
  return {
    type: 'OPEN_PROJECT_FOLDER',
    projectPath: state.projectPath,
  };
}

export function createResumeWorkspaceIntents(
  state: WorkspaceState,
  options: ResumeIntentOptions = {},
): ResumeIntent[] {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  return [
    {
      type: 'RESUME_CONTEXT',
      projectName: state.projectName,
      hostDevice: state.hostDevice,
      lastEvent: state.lastEvent,
    },
    createOpenProjectFolderIntent(state),
    {
      type: 'OPEN_FILES',
      files: state.openFiles.slice(0, maxFiles),
    },
  ];
}
