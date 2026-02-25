import {
  BridgeServiceRecord,
  BridgeWebSocketClient,
  CommandCompletedEvent,
  CommandErrorEvent,
  CommandOutputEvent,
  CommandStartedEvent,
  HostSelection,
  JsonStore,
  Logger,
  MdnsBrowser,
  UiActionType,
  UiBridgeServer,
  WorkspaceState,
  WorkspaceStateManager,
  createEnvelope,
} from '@bridge/shared';
import { loadMacAgentConfig } from './config';
import { ensureAutoStartPrepared } from './autostart';
import { createCommandRunRequest } from './commandRequest';
import {
  openProjectFolder,
  resumeWorkspace,
  ResumeAccessOptions,
} from './resumeWorkspace';
import { openRemoteControlSession } from './remoteControl';

function deriveAutoMapping(
  service: BridgeServiceRecord | null,
): { windowsRoot: string; smbRoot: string } | undefined {
  if (!service) {
    return undefined;
  }

  const shareName = service.txt.shareName?.trim();
  const windowsRoot = service.txt.windowsRoot?.trim();
  if (!shareName || !windowsRoot) {
    return undefined;
  }

  const encodedShareName = encodeURIComponent(shareName);
  const smbRoot = `smb://${service.host}/${encodedShareName}`;

  return {
    windowsRoot,
    smbRoot,
  };
}

function deriveAutoMountRoot(service: BridgeServiceRecord | null): string | undefined {
  if (!service) {
    return undefined;
  }

  const shareName = service.txt.shareName?.trim();
  if (!shareName) {
    return undefined;
  }

  return `/Volumes/${shareName}`;
}

function buildCommandLine(command: string, args: string[]): string {
  if (args.length === 0) {
    return command;
  }

  return `${command} ${args.join(' ')}`;
}

async function main(): Promise<void> {
  const config = loadMacAgentConfig();
  const logger = new Logger('agent-mac');

  await ensureAutoStartPrepared(logger);

  const initialWorkspaceState: WorkspaceState = {
    projectName: '',
    projectPath: '',
    openFiles: [],
    recentlyModifiedFiles: [],
    processes: [],
    activeProcess: false,
    hostDevice: '',
    connection: {
      lifecycle: 'DISCONNECTED',
      hostId: null,
      hostName: null,
      lastHeartbeatAt: null,
      lastTransitionAt: new Date().toISOString(),
    },
    lastEvent: new Date().toISOString(),
  };

  const stateStore = new JsonStore<WorkspaceState>(config.statePath);
  const stateManager = new WorkspaceStateManager(
    logger,
    stateStore,
    initialWorkspaceState,
  );
  await stateManager.init();

  const uiBridge = new UiBridgeServer(logger, {
    connectionStatus: 'DISCONNECTED',
    hostDevice: null,
    activeProject: null,
    projectPath: null,
    lastEvent: null,
    commandState: 'idle',
    activeCommand: null,
    activeCommandRequestId: null,
    commandExitCode: null,
    lastCommandAt: null,
  });
  uiBridge.start(config.uiBridgePort);

  const syncUiSnapshot = (state: WorkspaceState): void => {
    uiBridge.updateStatus({
      connectionStatus: state.connection.lifecycle,
      hostDevice: (state.connection.hostName ?? state.hostDevice) || null,
      activeProject: state.projectName || null,
      projectPath: state.projectPath || null,
      lastEvent: state.lastEvent,
    });
  };

  stateManager.on('changed', (state) => {
    syncUiSnapshot(state);
  });
  syncUiSnapshot(stateManager.getState());

  const wsClient = new BridgeWebSocketClient(logger, {
    reconnectBaseMs: 1000,
    reconnectMaxMs: 10000,
  });

  const browser = new MdnsBrowser(logger);
  const hostSelection = new HostSelection({
    staleAfterMs: config.discoveryStaleMs,
  });

  let selectedService: BridgeServiceRecord | null = null;
  let lastServerHeartbeatAt = 0;
  let heartbeatReconnectIssued = false;
  let activeCommandRequestId: string | null = null;

  const connectToSelectedService = async (): Promise<void> => {
    const preferred = hostSelection.selectPreferred(selectedService?.identity);
    if (!preferred) {
      selectedService = null;

      if (wsClient.getStatus() !== 'PAUSED') {
        await stateManager.updateConnectionState({
          lifecycle: 'DISCOVERING',
          hostId: null,
          hostName: null,
        });
      }

      return;
    }

    const previousSelected = selectedService;
    selectedService = preferred;

    if (wsClient.getStatus() === 'PAUSED') {
      await stateManager.updateConnectionState({
        lifecycle: 'PAUSED',
        hostId: preferred.identity,
        hostName: preferred.name,
      });
      return;
    }

    const sameHost = previousSelected?.identity === preferred.identity;
    const wsStatus = wsClient.getStatus();
    if (
      sameHost &&
      (wsStatus === 'CONNECTED' ||
        wsStatus === 'CONNECTING' ||
        wsStatus === 'RECONNECTING')
    ) {
      return;
    }

    await stateManager.updateConnectionState({
      lifecycle: 'CONNECTING',
      hostId: preferred.identity,
      hostName: preferred.name,
    });

    wsClient.connect(`ws://${preferred.host}:${preferred.port}`);
  };

  browser.on('serviceUp', (service) => {
    const platform = service.txt.platform;
    if (platform && platform !== 'windows') {
      return;
    }

    const tracked = hostSelection.upsert(service);
    logger.event(
      {
        component: 'mdns-browser',
        event: 'host-seen',
        state: stateManager.getState().connection.lifecycle,
        hostId: tracked.identity,
      },
      {
        lastSeenAt: tracked.lastSeenAt,
        seenCount: tracked.seenCount,
      },
    );

    void connectToSelectedService();
  });

  browser.on('serviceDown', (service) => {
    const removed = hostSelection.markDown(service.id);
    logger.event(
      {
        component: 'mdns-browser',
        event: removed ? 'host-removed' : 'host-down-observed',
        state: stateManager.getState().connection.lifecycle,
        hostId: service.identity,
      },
      { serviceId: service.id },
    );

    void connectToSelectedService();
  });

  browser.start(config.discoveryType);
  await stateManager.updateConnectionState({
    lifecycle: 'DISCOVERING',
    hostId: null,
    hostName: null,
  });

  wsClient.on('status', (status) => {
    const hostId = selectedService?.identity ?? null;
    const hostName = selectedService?.name ?? null;

    if (status === 'CONNECTED') {
      lastServerHeartbeatAt = Date.now();
      heartbeatReconnectIssued = false;

      wsClient.send(
        createEnvelope('bridge:hello', {
          agentId: 'mac-agent',
          name: 'Bridge Mac Agent',
          platform: 'mac',
        }),
      );
    }

    if (status === 'DISCONNECTED') {
      void connectToSelectedService();
    }

    const connectionPatch: {
      lifecycle: WorkspaceState['connection']['lifecycle'];
      hostId: string | null;
      hostName: string | null;
      lastHeartbeatAt?: string | null;
    } = {
      lifecycle: status,
      hostId,
      hostName,
    };

    if (status === 'CONNECTED') {
      connectionPatch.lastHeartbeatAt = new Date().toISOString();
    }

    void stateManager.updateConnectionState(connectionPatch);

    if (status !== 'CONNECTED' && activeCommandRequestId) {
      uiBridge.updateStatus({
        commandState: 'failed',
        activeCommandRequestId: null,
        lastCommandAt: new Date().toISOString(),
      });
      activeCommandRequestId = null;
    }
  });

  wsClient.on('message', (message) => {
    if (message.type === 'workspace:state') {
      const workspaceState = message.payload as WorkspaceState;
      lastServerHeartbeatAt = Date.now();

      void stateManager.updateWorkspaceMetadata({
        projectName: workspaceState.projectName,
        projectPath: workspaceState.projectPath,
        hostDevice: workspaceState.hostDevice,
        openFiles: workspaceState.openFiles,
      });

      void stateManager.updateRecentFiles({
        openFiles: workspaceState.openFiles,
        recentlyModifiedFiles: workspaceState.recentlyModifiedFiles,
      });

      void stateManager.updateProcessStatus(workspaceState.processes);

      void stateManager.updateConnectionState({
        lifecycle: 'CONNECTED',
        hostId: selectedService?.identity ?? workspaceState.connection.hostId,
        hostName: selectedService?.name ?? workspaceState.hostDevice,
        lastHeartbeatAt: new Date().toISOString(),
      });

      return;
    }

    if (message.type === 'bridge:ping') {
      lastServerHeartbeatAt = Date.now();
      void stateManager.updateConnectionState({
        lifecycle: 'CONNECTED',
        hostId: selectedService?.identity ?? null,
        hostName: selectedService?.name ?? null,
        lastHeartbeatAt: new Date().toISOString(),
      });

      wsClient.send(
        createEnvelope('bridge:pong', {
          timestamp: new Date().toISOString(),
          hostId: selectedService?.identity,
        }),
      );
      return;
    }

    if (message.type === 'bridge:pong') {
      lastServerHeartbeatAt = Date.now();
      void stateManager.updateConnectionState({
        lifecycle: 'CONNECTED',
        hostId: selectedService?.identity ?? null,
        hostName: selectedService?.name ?? null,
        lastHeartbeatAt: new Date().toISOString(),
      });
      return;
    }

    if (message.type === 'command:started') {
      const started = message.payload as CommandStartedEvent;
      activeCommandRequestId = started.requestId;

      uiBridge.updateStatus({
        commandState: 'running',
        activeCommand: buildCommandLine(started.command, started.args),
        activeCommandRequestId: started.requestId,
        commandExitCode: null,
        lastCommandAt: started.startedAt,
      });

      logger.event(
        {
          component: 'remote-command',
          event: 'started',
          state: stateManager.getState().connection.lifecycle,
          hostId: selectedService?.identity ?? undefined,
        },
        {
          requestId: started.requestId,
          command: started.command,
          args: started.args,
          cwd: started.cwd,
        },
      );
      return;
    }

    if (message.type === 'command:output') {
      const output = message.payload as CommandOutputEvent;
      const trimmedChunk = output.chunk.trim();

      if (trimmedChunk.length > 0) {
        logger.info('Remote command output', {
          requestId: output.requestId,
          stream: output.stream,
          chunk: trimmedChunk.slice(0, 500),
        });
      }
      return;
    }

    if (message.type === 'command:completed') {
      const completed = message.payload as CommandCompletedEvent;
      const commandState = completed.cancelled
        ? 'cancelled'
        : completed.exitCode === 0 && !completed.timedOut
          ? 'succeeded'
          : 'failed';

      uiBridge.updateStatus({
        commandState,
        activeCommandRequestId: null,
        commandExitCode: completed.exitCode,
        lastCommandAt: completed.completedAt,
      });

      if (activeCommandRequestId === completed.requestId) {
        activeCommandRequestId = null;
      }

      logger.event(
        {
          component: 'remote-command',
          event: 'completed',
          state: stateManager.getState().connection.lifecycle,
          hostId: selectedService?.identity ?? undefined,
        },
        {
          requestId: completed.requestId,
          exitCode: completed.exitCode,
          signal: completed.signal,
          cancelled: completed.cancelled,
          timedOut: completed.timedOut,
        },
      );
      return;
    }

    if (message.type === 'command:error') {
      const error = message.payload as CommandErrorEvent;

      uiBridge.updateStatus({
        commandState: 'failed',
        activeCommandRequestId: null,
        commandExitCode: null,
        lastCommandAt: error.at,
      });

      if (activeCommandRequestId === error.requestId) {
        activeCommandRequestId = null;
      }

      logger.warn('Remote command failed', {
        requestId: error.requestId,
        error: error.message,
      });
    }
  });

  uiBridge.on('action', (action: UiActionType) => {
    void (async () => {
      try {
        const dynamicMapping =
          config.pathMapping ?? deriveAutoMapping(selectedService);
        const dynamicMountRoot =
          config.smbMountRoot ?? deriveAutoMountRoot(selectedService);

        if (action === 'run-windows-command') {
          if (wsClient.getStatus() !== 'CONNECTED') {
            logger.warn('Cannot run Windows command while disconnected');
            return;
          }

          if (activeCommandRequestId) {
            logger.warn('A Windows command is already running', {
              requestId: activeCommandRequestId,
            });
            return;
          }

          const requestId = `cmd-${Date.now()}-${Math.random()
            .toString(16)
            .slice(2, 8)}`;
          const request = createCommandRunRequest(
            config.windowsCommand,
            requestId,
            config.windowsCommandCwd,
          );

          if (!request) {
            logger.warn('BRIDGE_WINDOWS_COMMAND is empty; command run ignored');
            return;
          }

          activeCommandRequestId = requestId;
          uiBridge.updateStatus({
            commandState: 'running',
            activeCommand: config.windowsCommand,
            activeCommandRequestId: requestId,
            commandExitCode: null,
            lastCommandAt: new Date().toISOString(),
          });

          wsClient.send(createEnvelope('command:run', request));
          return;
        }

        if (action === 'cancel-windows-command') {
          if (!activeCommandRequestId) {
            logger.warn('No running Windows command to cancel');
            return;
          }

          wsClient.send(
            createEnvelope('command:cancel', {
              requestId: activeCommandRequestId,
            }),
          );
          return;
        }

        await handleUiAction(
          logger,
          action,
          wsClient,
          stateManager,
          () => selectedService,
          connectToSelectedService,
          {
            mapping: dynamicMapping,
            smbMountRoot: dynamicMountRoot,
            mountTimeoutMs: config.smbMountTimeoutMs,
          },
        );
      } catch (error) {
        const typed = error as Error;
        logger.error('UI action failed', {
          action,
          error: typed.message,
        });
      }
    })();
  });

  const pingInterval = setInterval(() => {
    if (wsClient.getStatus() !== 'CONNECTED') {
      return;
    }

    wsClient.send(
      createEnvelope('bridge:ping', {
        timestamp: new Date().toISOString(),
        hostId: selectedService?.identity,
      }),
    );
  }, config.pingMs);

  const heartbeatMonitorInterval = setInterval(() => {
    if (wsClient.getStatus() !== 'CONNECTED') {
      return;
    }

    const staleForMs = Date.now() - lastServerHeartbeatAt;
    if (staleForMs <= config.heartbeatTimeoutMs) {
      return;
    }

    if (heartbeatReconnectIssued) {
      return;
    }

    heartbeatReconnectIssued = true;

    logger.warn('Heartbeat timeout reached, reconnecting websocket', {
      staleForMs,
      timeoutMs: config.heartbeatTimeoutMs,
      hostId: selectedService?.identity,
    });

    void stateManager.updateConnectionState({
      lifecycle: 'RECONNECTING',
      hostId: selectedService?.identity ?? null,
      hostName: selectedService?.name ?? null,
    });

    wsClient.reconnectNow();
  }, Math.max(1000, Math.floor(config.pingMs / 2)));

  const discoverySweepInterval = setInterval(() => {
    const removedHosts = hostSelection.pruneStale();
    if (removedHosts.length > 0) {
      logger.info('Pruned stale mDNS hosts', {
        count: removedHosts.length,
        staleAfterMs: config.discoveryStaleMs,
      });
    }

    void connectToSelectedService();
  }, config.discoverySweepMs);

  const shutdown = (): void => {
    clearInterval(pingInterval);
    clearInterval(heartbeatMonitorInterval);
    clearInterval(discoverySweepInterval);
    browser.stop();
    wsClient.disconnect();
    uiBridge.stop();
    logger.info('Mac agent stopped');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.event(
    {
      component: 'agent-mac',
      event: 'started',
      state: stateManager.getState().connection.lifecycle,
      hostId: stateManager.getState().connection.hostId ?? undefined,
    },
    {
      discoveryType: config.discoveryType,
      uiBridgePort: config.uiBridgePort,
    },
  );
}

async function handleUiAction(
  logger: Logger,
  action: UiActionType,
  wsClient: BridgeWebSocketClient,
  stateManager: WorkspaceStateManager,
  getSelectedService: () => BridgeServiceRecord | null,
  connectToSelectedService: () => Promise<void>,
  resumeAccessOptions: ResumeAccessOptions,
): Promise<void> {
  const selectedService = getSelectedService();

  if (action === 'reconnect') {
    if (!selectedService) {
      await connectToSelectedService();
      return;
    }

    await stateManager.updateConnectionState({
      lifecycle: 'RECONNECTING',
      hostId: selectedService.identity,
      hostName: selectedService.name,
    });
    wsClient.reconnectNow();
    return;
  }

  if (action === 'pause') {
    wsClient.setPaused(true);
    await stateManager.updateConnectionState({
      lifecycle: 'PAUSED',
      hostId: selectedService?.identity ?? null,
      hostName: selectedService?.name ?? null,
    });
    return;
  }

  if (action === 'resume') {
    wsClient.setPaused(false);
    await connectToSelectedService();
    return;
  }

  if (action === 'open-remote-control') {
    await openRemoteControlSession(logger, selectedService);
    return;
  }

  const stateSnapshot = stateManager.getState();
  const hasWorkspace =
    stateSnapshot.projectPath.length > 0 || stateSnapshot.projectName.length > 0;
  const workspaceState = hasWorkspace ? stateSnapshot : null;

  if (action === 'open-project') {
    await openProjectFolder(logger, workspaceState, resumeAccessOptions);
    return;
  }

  if (action === 'resume-workspace') {
    await resumeWorkspace(logger, workspaceState, resumeAccessOptions);
  }
}

process.on('unhandledRejection', (error) => {
  const logger = new Logger('agent-mac');
  logger.error('Unhandled rejection', {
    error: String(error),
  });
});

process.on('uncaughtException', (error) => {
  const logger = new Logger('agent-mac');
  logger.error('Uncaught exception', { error: error.message });
});

void main();
