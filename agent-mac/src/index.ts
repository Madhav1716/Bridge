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
  TrackedHost,
  UiActionPayload,
  UiDiscoveredHost,
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
import { PairingStore } from './pairingStore';

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
    pairedHostId: null,
    pairedHostName: null,
    discoveredHosts: [],
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
  const pairingStore = new PairingStore(logger, config.pairingPath);
  const pairingState = await pairingStore.load();

  let selectedService: BridgeServiceRecord | null = null;
  let activeTargetHost: string | null = config.windowsHost ?? null;
  let lastServerHeartbeatAt = 0;
  let heartbeatReconnectIssued = false;
  let activeCommandRequestId: string | null = null;
  let pairedHostId: string | null = pairingState.pairedHostId;
  let pairedHostName: string | null = pairingState.pairedHostName;

  const buildDiscoveredHostsSnapshot = (): UiDiscoveredHost[] => {
    const trackedHosts = hostSelection.listHosts();
    return trackedHosts.map((tracked: TrackedHost) => {
      const isPaired = pairedHostId !== null && tracked.identity === pairedHostId;
      const isConnected =
        selectedService?.identity === tracked.identity &&
        stateManager.getState().connection.lifecycle === 'CONNECTED';

      return {
        hostId: tracked.identity,
        hostName: tracked.service.name,
        address: tracked.service.host,
        lastSeenAt: tracked.lastSeenAt,
        seenCount: tracked.seenCount,
        isPaired,
        isConnected,
      };
    });
  };

  const syncDiscoverySnapshot = (): void => {
    uiBridge.updateStatus({
      pairedHostId,
      pairedHostName,
      discoveredHosts: buildDiscoveredHostsSnapshot(),
    });
  };

  const persistPairingState = async (): Promise<void> => {
    await pairingStore.save({
      pairedHostId,
      pairedHostName,
      updatedAt: new Date().toISOString(),
    });
  };

  syncDiscoverySnapshot();

  const connectDirectHostFallback = async (): Promise<boolean> => {
    const directHost = config.windowsHost?.trim();
    if (!directHost) {
      return false;
    }

    activeTargetHost = directHost;

    if (wsClient.getStatus() === 'PAUSED') {
      await stateManager.updateConnectionState({
        lifecycle: 'PAUSED',
        hostId: directHost,
        hostName: directHost,
      });
      return true;
    }

    const wsStatus = wsClient.getStatus();
    if (
      wsStatus === 'CONNECTED' ||
      wsStatus === 'CONNECTING' ||
      wsStatus === 'RECONNECTING'
    ) {
      return true;
    }

    const targetUrl = `ws://${directHost}:${config.windowsWsPort}`;
    logger.event(
      {
        component: 'ws-client',
        event: 'direct-connect-attempt',
        state: stateManager.getState().connection.lifecycle,
        hostId: directHost,
      },
      { targetUrl },
    );

    await stateManager.updateConnectionState({
      lifecycle: 'CONNECTING',
      hostId: directHost,
      hostName: directHost,
    });

    wsClient.connect(targetUrl);
    return true;
  };

  const connectToSelectedService = async (): Promise<void> => {
    const pairedHostMatch = pairedHostId
      ? hostSelection
          .listHosts()
          .find((trackedHost) => trackedHost.identity === pairedHostId)
      : undefined;
    const preferred =
      pairedHostMatch?.service ??
      hostSelection.selectPreferred(selectedService?.identity ?? pairedHostId ?? undefined);
    if (!preferred) {
      selectedService = null;

      if (wsClient.getStatus() === 'PAUSED') {
        await stateManager.updateConnectionState({
          lifecycle: 'PAUSED',
          hostId: activeTargetHost,
          hostName: activeTargetHost,
        });
        syncDiscoverySnapshot();
        return;
      }

      const usedDirectFallback = await connectDirectHostFallback();
      if (!usedDirectFallback) {
        activeTargetHost = null;
        await stateManager.updateConnectionState({
          lifecycle: 'DISCOVERING',
          hostId: null,
          hostName: null,
        });
      }

      syncDiscoverySnapshot();
      return;
    }

    const previousSelected = selectedService;
    selectedService = preferred;
    activeTargetHost = preferred.host;

    if (wsClient.getStatus() === 'PAUSED') {
      await stateManager.updateConnectionState({
        lifecycle: 'PAUSED',
        hostId: preferred.identity,
        hostName: preferred.name,
      });
      syncDiscoverySnapshot();
      return;
    }

    const sameHost = previousSelected?.identity === preferred.identity;
    const wsStatus = wsClient.getStatus();
    if (
      (sameHost || activeTargetHost === preferred.host) &&
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
    syncDiscoverySnapshot();
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

    syncDiscoverySnapshot();
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

    syncDiscoverySnapshot();
    void connectToSelectedService();
  });

  browser.start(config.discoveryType);
  await stateManager.updateConnectionState({
    lifecycle: 'DISCOVERING',
    hostId: null,
    hostName: null,
  });

  wsClient.on('status', (status) => {
    const hostId = selectedService?.identity ?? activeTargetHost ?? null;
    const hostName = selectedService?.name ?? activeTargetHost ?? null;

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

    syncDiscoverySnapshot();
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
        hostId: selectedService?.identity ?? activeTargetHost ?? null,
        hostName: selectedService?.name ?? activeTargetHost ?? null,
        lastHeartbeatAt: new Date().toISOString(),
      });

      wsClient.send(
        createEnvelope('bridge:pong', {
          timestamp: new Date().toISOString(),
          hostId: selectedService?.identity ?? activeTargetHost ?? undefined,
        }),
      );
      return;
    }

    if (message.type === 'bridge:pong') {
      lastServerHeartbeatAt = Date.now();
      void stateManager.updateConnectionState({
        lifecycle: 'CONNECTED',
        hostId: selectedService?.identity ?? activeTargetHost ?? null,
        hostName: selectedService?.name ?? activeTargetHost ?? null,
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
          hostId: selectedService?.identity ?? activeTargetHost ?? undefined,
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
          hostId: selectedService?.identity ?? activeTargetHost ?? undefined,
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

  uiBridge.on('action', (payload: UiActionPayload) => {
    void (async () => {
      const action = payload.action;
      try {
        const dynamicMapping =
          config.pathMapping ?? deriveAutoMapping(selectedService);
        const dynamicMountRoot =
          config.smbMountRoot ?? deriveAutoMountRoot(selectedService);

        if (action === 'pair-host') {
          const requestedHostId = payload.hostId?.trim();
          if (!requestedHostId) {
            logger.warn('Pair host action received without hostId');
            return;
          }

          const trackedHost = hostSelection
            .listHosts()
            .find((candidate) => candidate.identity === requestedHostId);
          if (!trackedHost) {
            logger.warn('Requested host is not currently discoverable', {
              requestedHostId,
            });
            return;
          }

          pairedHostId = trackedHost.identity;
          pairedHostName = trackedHost.service.name;
          await persistPairingState();
          syncDiscoverySnapshot();
          void connectToSelectedService();
          return;
        }

        if (action === 'clear-paired-host') {
          pairedHostId = null;
          pairedHostName = null;
          await persistPairingState();
          syncDiscoverySnapshot();
          void connectToSelectedService();
          return;
        }

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

        if (action === 'open-remote-control') {
          const remoteService =
            selectedService ??
            (activeTargetHost
              ? {
                  id: `direct-${activeTargetHost}`,
                  identity: activeTargetHost,
                  name: activeTargetHost,
                  host: activeTargetHost,
                  port: config.windowsWsPort,
                  addresses: [activeTargetHost],
                  txt: {
                    remoteControl: '1',
                    remoteProtocol: 'rdp',
                    remotePort: '3389',
                  },
                }
              : null);

          await openRemoteControlSession(logger, remoteService);
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
        hostId: selectedService?.identity ?? activeTargetHost ?? undefined,
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
      hostId: selectedService?.identity ?? activeTargetHost ?? null,
      hostName: selectedService?.name ?? activeTargetHost ?? null,
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
      syncDiscoverySnapshot();
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
