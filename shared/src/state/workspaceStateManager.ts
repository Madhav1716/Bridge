import { EventEmitter } from 'node:events';
import { Logger } from '../logger';
import {
  ConnectionLifecycleState,
  ConnectionState,
  ProcessStatus,
  WorkspaceState,
} from '../types';
import { JsonStore } from './jsonStore';

interface StateEvents {
  changed: (state: WorkspaceState) => void;
}

interface RecentFilesUpdateRequest {
  modifiedFilePath?: string;
  openFiles?: string[];
  recentlyModifiedFiles?: string[];
}

interface WorkspaceMetadataUpdateRequest {
  projectName?: string;
  projectPath?: string;
  hostDevice?: string;
  openFiles?: string[];
}

interface ConnectionStateUpdateRequest {
  lifecycle?: ConnectionLifecycleState;
  hostId?: string | null;
  hostName?: string | null;
  lastHeartbeatAt?: string | null;
}

interface WorkspaceStateManagerOptions {
  debounceMs?: number;
  recentFileLimit?: number;
  openFileLimit?: number;
}

const VALID_CONNECTION_STATES: Set<ConnectionLifecycleState> = new Set([
  'DISCONNECTED',
  'DISCOVERING',
  'CONNECTING',
  'CONNECTED',
  'PAUSED',
  'RECONNECTING',
]);

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_RECENT_FILE_LIMIT = 30;
const DEFAULT_OPEN_FILE_LIMIT = 8;

function createDefaultConnectionState(now: string): ConnectionState {
  return {
    lifecycle: 'DISCONNECTED',
    hostId: null,
    hostName: null,
    lastHeartbeatAt: null,
    lastTransitionAt: now,
  };
}

function cloneProcesses(processes: ProcessStatus[]): ProcessStatus[] {
  return processes.map((processStatus) => ({
    ...processStatus,
    pids: [...processStatus.pids],
  }));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

export class WorkspaceStateManager extends EventEmitter {
  private state: WorkspaceState;
  private readonly debounceMs: number;
  private readonly recentFileLimit: number;
  private readonly openFileLimit: number;

  private pendingPatch: Partial<WorkspaceState> | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingResolvers: Array<(state: WorkspaceState) => void> = [];
  private pendingRejecters: Array<(error: unknown) => void> = [];
  private commitQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly logger: Logger,
    private readonly store: JsonStore<WorkspaceState>,
    initialState: WorkspaceState,
    options: WorkspaceStateManagerOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.recentFileLimit = options.recentFileLimit ?? DEFAULT_RECENT_FILE_LIMIT;
    this.openFileLimit = options.openFileLimit ?? DEFAULT_OPEN_FILE_LIMIT;
    this.state = this.normalizeState(initialState);
  }

  public on<EventKey extends keyof StateEvents>(
    eventName: EventKey,
    listener: StateEvents[EventKey],
  ): this {
    return super.on(eventName, listener);
  }

  public async init(): Promise<void> {
    const stored = await this.store.read();
    if (stored) {
      this.state = this.normalizeState(stored);
      this.logger.info('Loaded persisted workspace state');
      this.emit('changed', this.getState());
      return;
    }

    await this.store.write(this.state);
  }

  public getState(): WorkspaceState {
    return {
      ...this.state,
      openFiles: [...this.state.openFiles],
      recentlyModifiedFiles: [...this.state.recentlyModifiedFiles],
      processes: cloneProcesses(this.state.processes),
      connection: { ...this.state.connection },
    };
  }

  // Dedicated updater for recent/open file information. This centralizes file-derived mutations.
  public async updateRecentFiles(
    update: RecentFilesUpdateRequest,
  ): Promise<WorkspaceState> {
    const projectedState = this.getProjectedState();

    const openFiles = update.openFiles
      ? uniqueStrings(update.openFiles).slice(0, this.openFileLimit)
      : projectedState.openFiles;

    let recentlyModifiedFiles = update.recentlyModifiedFiles
      ? uniqueStrings(update.recentlyModifiedFiles).slice(0, this.recentFileLimit)
      : projectedState.recentlyModifiedFiles;

    if (update.modifiedFilePath) {
      recentlyModifiedFiles = [
        update.modifiedFilePath,
        ...recentlyModifiedFiles.filter(
          (candidate) => candidate !== update.modifiedFilePath,
        ),
      ].slice(0, this.recentFileLimit);
    }

    return this.enqueuePatch({
      openFiles,
      recentlyModifiedFiles,
    });
  }

  // Dedicated updater for process snapshots. Active state is always derived here.
  public async updateProcessStatus(
    processes: ProcessStatus[],
  ): Promise<WorkspaceState> {
    const sanitizedProcesses = this.normalizeProcesses(processes);
    const activeProcess = sanitizedProcesses.some((status) => status.running);

    return this.enqueuePatch({
      processes: sanitizedProcesses,
      activeProcess,
    });
  }

  // Dedicated updater for connection lifecycle so consumers cannot mutate status ad-hoc.
  public async updateConnectionState(
    update: ConnectionStateUpdateRequest,
  ): Promise<WorkspaceState> {
    const projectedState = this.getProjectedState();
    const previousConnection = projectedState.connection;

    const lifecycle =
      update.lifecycle && VALID_CONNECTION_STATES.has(update.lifecycle)
        ? update.lifecycle
        : previousConnection.lifecycle;

    const nextConnection: ConnectionState = {
      ...previousConnection,
      ...update,
      lifecycle,
      lastTransitionAt:
        lifecycle === previousConnection.lifecycle
          ? previousConnection.lastTransitionAt
          : new Date().toISOString(),
    };

    return this.enqueuePatch({
      connection: nextConnection,
    });
  }

  // Dedicated updater for workspace identity metadata.
  public async updateWorkspaceMetadata(
    update: WorkspaceMetadataUpdateRequest,
  ): Promise<WorkspaceState> {
    const patch: Partial<WorkspaceState> = {
      projectName: update.projectName,
      projectPath: update.projectPath,
      hostDevice: update.hostDevice,
    };

    if (update.openFiles) {
      patch.openFiles = uniqueStrings(update.openFiles).slice(0, this.openFileLimit);
    }

    return this.enqueuePatch(patch);
  }

  private getProjectedState(): WorkspaceState {
    if (!this.pendingPatch) {
      return this.getState();
    }

    return this.mergeStateWithPatch(this.state, this.pendingPatch);
  }

  private enqueuePatch(patch: Partial<WorkspaceState>): Promise<WorkspaceState> {
    const sanitizedPatch = this.sanitizePatch(patch);
    if (Object.keys(sanitizedPatch).length === 0) {
      return Promise.resolve(this.getState());
    }

    this.pendingPatch = this.pendingPatch
      ? this.mergePatches(this.pendingPatch, sanitizedPatch)
      : sanitizedPatch;

    return new Promise<WorkspaceState>((resolve, reject) => {
      this.pendingResolvers.push(resolve);
      this.pendingRejecters.push(reject);
      this.scheduleDebouncedCommit();
    });
  }

  private scheduleDebouncedCommit(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.queuePendingCommit();
    }, this.debounceMs);
  }

  private queuePendingCommit(): void {
    if (!this.pendingPatch) {
      return;
    }

    const patch = this.pendingPatch;
    const resolvers = this.pendingResolvers;
    const rejecters = this.pendingRejecters;

    this.pendingPatch = null;
    this.pendingResolvers = [];
    this.pendingRejecters = [];

    this.commitQueue = this.commitQueue
      .then(async () => {
        const didCommit = await this.commitPatch(patch);
        const currentState = this.getState();

        if (didCommit) {
          this.logger.debug('Committed workspace state patch', {
            lastEvent: currentState.lastEvent,
            lifecycle: currentState.connection.lifecycle,
          });
        }

        for (const resolve of resolvers) {
          resolve(currentState);
        }
      })
      .catch((error) => {
        for (const reject of rejecters) {
          reject(error);
        }
      });
  }

  private async commitPatch(patch: Partial<WorkspaceState>): Promise<boolean> {
    const previousState = this.state;
    const candidateState = this.mergeStateWithPatch(previousState, patch);

    if (this.isMeaningfullyEqual(previousState, candidateState)) {
      return false;
    }

    const committedState: WorkspaceState = {
      ...candidateState,
      lastEvent: new Date().toISOString(),
    };

    this.state = committedState;
    await this.store.write(this.state);
    this.emit('changed', this.getState());
    return true;
  }

  private mergeStateWithPatch(
    currentState: WorkspaceState,
    patch: Partial<WorkspaceState>,
  ): WorkspaceState {
    const mergedConnection = patch.connection
      ? {
          ...currentState.connection,
          ...patch.connection,
        }
      : currentState.connection;

    return this.normalizeState({
      ...currentState,
      ...patch,
      connection: mergedConnection,
      lastEvent: currentState.lastEvent,
    });
  }

  private normalizeState(candidate: WorkspaceState): WorkspaceState {
    const now = new Date().toISOString();

    const connection = this.normalizeConnectionState(candidate.connection, now);
    const openFiles = uniqueStrings(candidate.openFiles ?? []).slice(
      0,
      this.openFileLimit,
    );
    const recentlyModifiedFiles = uniqueStrings(
      candidate.recentlyModifiedFiles ?? [],
    ).slice(0, this.recentFileLimit);
    const processes = this.normalizeProcesses(candidate.processes ?? []);

    return {
      projectName: candidate.projectName ?? '',
      projectPath: candidate.projectPath ?? '',
      openFiles,
      recentlyModifiedFiles,
      processes,
      activeProcess: processes.some((status) => status.running),
      hostDevice: candidate.hostDevice ?? '',
      connection,
      lastEvent: candidate.lastEvent ?? now,
    };
  }

  private normalizeConnectionState(
    candidate: ConnectionState | undefined,
    now: string,
  ): ConnectionState {
    const fallback = createDefaultConnectionState(now);
    if (!candidate) {
      return fallback;
    }

    const lifecycle = VALID_CONNECTION_STATES.has(candidate.lifecycle)
      ? candidate.lifecycle
      : fallback.lifecycle;

    return {
      lifecycle,
      hostId: candidate.hostId ?? null,
      hostName: candidate.hostName ?? null,
      lastHeartbeatAt: candidate.lastHeartbeatAt ?? null,
      lastTransitionAt: candidate.lastTransitionAt ?? now,
    };
  }

  private normalizeProcesses(processes: ProcessStatus[]): ProcessStatus[] {
    return processes.map((status) => {
      const rawPids = Array.isArray(status.pids) ? status.pids : [];
      const pids = Array.from(new Set(rawPids.filter((pid) => pid > 0)));
      return {
        name: status.name,
        running: status.running,
        count: pids.length,
        pids,
      };
    });
  }

  private sanitizePatch(patch: Partial<WorkspaceState>): Partial<WorkspaceState> {
    const sanitized: Partial<WorkspaceState> = {};

    if (patch.projectName !== undefined) {
      sanitized.projectName = patch.projectName;
    }

    if (patch.projectPath !== undefined) {
      sanitized.projectPath = patch.projectPath;
    }

    if (patch.hostDevice !== undefined) {
      sanitized.hostDevice = patch.hostDevice;
    }

    if (patch.openFiles !== undefined) {
      sanitized.openFiles = uniqueStrings(patch.openFiles).slice(0, this.openFileLimit);
    }

    if (patch.recentlyModifiedFiles !== undefined) {
      sanitized.recentlyModifiedFiles = uniqueStrings(
        patch.recentlyModifiedFiles,
      ).slice(0, this.recentFileLimit);
    }

    if (patch.processes !== undefined) {
      sanitized.processes = this.normalizeProcesses(patch.processes);
      sanitized.activeProcess = sanitized.processes.some((status) => status.running);
    }

    if (patch.activeProcess !== undefined && sanitized.processes === undefined) {
      sanitized.activeProcess = patch.activeProcess;
    }

    if (patch.connection !== undefined) {
      const projectedConnection = this.pendingPatch?.connection
        ? {
            ...this.state.connection,
            ...this.pendingPatch.connection,
            ...patch.connection,
          }
        : {
            ...this.state.connection,
            ...patch.connection,
          };

      const normalizedConnection = this.normalizeConnectionState(
        projectedConnection,
        new Date().toISOString(),
      );
      sanitized.connection = normalizedConnection;
    }

    return sanitized;
  }

  private mergePatches(
    left: Partial<WorkspaceState>,
    right: Partial<WorkspaceState>,
  ): Partial<WorkspaceState> {
    const merged: Partial<WorkspaceState> = {
      ...left,
      ...right,
    };

    if (right.connection) {
      merged.connection = right.connection;
    } else if (left.connection) {
      merged.connection = left.connection;
    }

    return merged;
  }

  private isMeaningfullyEqual(
    previousState: WorkspaceState,
    nextState: WorkspaceState,
  ): boolean {
    const previousComparable = {
      ...previousState,
      lastEvent: '',
    };

    const nextComparable = {
      ...nextState,
      lastEvent: '',
    };

    return JSON.stringify(previousComparable) === JSON.stringify(nextComparable);
  }
}
