import path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  BridgeWebSocketServer,
  CommandCancelRequest,
  CommandRunRequest,
  Logger,
  createEnvelope,
} from '@bridge/shared';

interface CommandExecutorOptions {
  projectPath: string;
  sharedWindowsRoot: string;
  allowedCommands: string[];
  commandTimeoutMs: number;
}

interface RunningCommand {
  clientId: number;
  requestId: string;
  key: string;
  child: ChildProcessWithoutNullStreams;
  timeoutTimer: NodeJS.Timeout | null;
  timedOut: boolean;
  cancelled: boolean;
}

const MAX_OUTPUT_CHUNK_SIZE = 4000;

function normalizeCommandName(command: string): string {
  const base = path.basename(command).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

function resolvePath(targetPath: string): string {
  return path.resolve(targetPath).toLowerCase();
}

export class WindowsCommandExecutor {
  private readonly runningByKey = new Map<string, RunningCommand>();
  private readonly allowedCommands: Set<string>;
  private readonly projectPath: string;
  private readonly sharedWindowsRoot: string;
  private readonly commandTimeoutMs: number;

  public constructor(
    private readonly logger: Logger,
    private readonly wsServer: BridgeWebSocketServer,
    options: CommandExecutorOptions,
  ) {
    this.projectPath = path.resolve(options.projectPath);
    this.sharedWindowsRoot = path.resolve(options.sharedWindowsRoot);
    this.allowedCommands = new Set(
      options.allowedCommands.map((command) => normalizeCommandName(command)),
    );
    this.commandTimeoutMs = options.commandTimeoutMs;
  }

  public handleRunRequest(clientId: number, request: CommandRunRequest): void {
    const requestKey = this.getRequestKey(clientId, request.requestId);
    if (this.runningByKey.has(requestKey)) {
      this.sendCommandError(
        clientId,
        request.requestId,
        'Command request is already running',
      );
      return;
    }

    const normalizedCommand = normalizeCommandName(request.command);
    if (!this.allowedCommands.has(normalizedCommand)) {
      this.sendCommandError(
        clientId,
        request.requestId,
        `Command '${request.command}' is not allowed`,
      );
      return;
    }

    const workingDirectory = this.resolveWorkingDirectory(request.cwd);
    if (!workingDirectory) {
      this.sendCommandError(
        clientId,
        request.requestId,
        `Requested cwd is outside shared root: ${request.cwd}`,
      );
      return;
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.command, request.args, {
        cwd: workingDirectory,
        env: process.env,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      const typed = error as Error;
      this.sendCommandError(clientId, request.requestId, typed.message);
      return;
    }

    const running: RunningCommand = {
      clientId,
      requestId: request.requestId,
      key: requestKey,
      child,
      timeoutTimer: null,
      timedOut: false,
      cancelled: false,
    };

    if (this.commandTimeoutMs > 0) {
      running.timeoutTimer = setTimeout(() => {
        running.timedOut = true;
        running.child.kill('SIGTERM');
      }, this.commandTimeoutMs);
    }

    this.runningByKey.set(requestKey, running);

    this.logger.event(
      {
        component: 'command-executor',
        event: 'started',
      },
      {
        clientId,
        requestId: request.requestId,
        command: request.command,
        args: request.args,
        cwd: workingDirectory,
      },
    );

    this.wsServer.sendToClient(
      clientId,
      createEnvelope('command:started', {
        requestId: request.requestId,
        command: request.command,
        args: request.args,
        cwd: workingDirectory,
        startedAt: new Date().toISOString(),
      }),
    );

    child.stdout.on('data', (buffer) => {
      this.sendOutputChunks(clientId, request.requestId, 'stdout', buffer.toString());
    });

    child.stderr.on('data', (buffer) => {
      this.sendOutputChunks(clientId, request.requestId, 'stderr', buffer.toString());
    });

    child.on('error', (error) => {
      this.logger.warn('Command process error', {
        requestId: request.requestId,
        error: error.message,
      });

      this.sendCommandError(clientId, request.requestId, error.message);
    });

    child.on('close', (exitCode, signal) => {
      this.runningByKey.delete(requestKey);
      if (running.timeoutTimer) {
        clearTimeout(running.timeoutTimer);
      }

      this.wsServer.sendToClient(
        clientId,
        createEnvelope('command:completed', {
          requestId: request.requestId,
          exitCode,
          signal,
          timedOut: running.timedOut,
          cancelled: running.cancelled,
          completedAt: new Date().toISOString(),
        }),
      );

      this.logger.event(
        {
          component: 'command-executor',
          event: 'completed',
        },
        {
          clientId,
          requestId: request.requestId,
          exitCode,
          signal,
          timedOut: running.timedOut,
          cancelled: running.cancelled,
        },
      );
    });
  }

  public handleCancelRequest(clientId: number, request: CommandCancelRequest): void {
    const requestKey = this.getRequestKey(clientId, request.requestId);
    const running = this.runningByKey.get(requestKey);
    if (!running) {
      this.sendCommandError(clientId, request.requestId, 'Command is not running');
      return;
    }

    running.cancelled = true;
    running.child.kill('SIGTERM');
  }

  public cancelCommandsForClient(clientId: number): void {
    for (const running of this.runningByKey.values()) {
      if (running.clientId !== clientId) {
        continue;
      }

      running.cancelled = true;
      running.child.kill('SIGTERM');
    }
  }

  public stopAll(): void {
    for (const running of this.runningByKey.values()) {
      running.cancelled = true;
      running.child.kill('SIGTERM');
    }

    this.runningByKey.clear();
  }

  private sendCommandError(
    clientId: number,
    requestId: string,
    message: string,
  ): void {
    this.wsServer.sendToClient(
      clientId,
      createEnvelope('command:error', {
        requestId,
        message,
        at: new Date().toISOString(),
      }),
    );
  }

  private sendOutputChunks(
    clientId: number,
    requestId: string,
    stream: 'stdout' | 'stderr',
    output: string,
  ): void {
    for (let index = 0; index < output.length; index += MAX_OUTPUT_CHUNK_SIZE) {
      const chunk = output.slice(index, index + MAX_OUTPUT_CHUNK_SIZE);
      this.wsServer.sendToClient(
        clientId,
        createEnvelope('command:output', {
          requestId,
          stream,
          chunk,
          at: new Date().toISOString(),
        }),
      );
    }
  }

  private resolveWorkingDirectory(requestedCwd?: string): string | null {
    const fallback = this.projectPath;
    if (!requestedCwd) {
      return fallback;
    }

    const resolved = path.isAbsolute(requestedCwd)
      ? path.resolve(requestedCwd)
      : path.resolve(this.projectPath, requestedCwd);
    if (!this.isInsideSharedRoot(resolved)) {
      return null;
    }

    return resolved;
  }

  private isInsideSharedRoot(targetPath: string): boolean {
    const target = resolvePath(targetPath);
    const root = resolvePath(this.sharedWindowsRoot);
    return target === root || target.startsWith(`${root}${path.sep}`);
  }

  private getRequestKey(clientId: number, requestId: string): string {
    return `${clientId}:${requestId}`;
  }
}
