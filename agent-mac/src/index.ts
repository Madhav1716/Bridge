import os from 'node:os';
import {
  BridgeServiceRecord,
  BridgeWebSocketClient,
  ConnectionRequest,
  HostSelection,
  JsonStore,
  Logger,
  MdnsBrowser,
  MdnsPublisher,
  UiActionPayload,
  UiActionType,
  UiBridgeServer,
  WorkspaceState,
  WorkspaceStateManager,
  createEnvelope,
} from '@bridge/shared';
import { loadMacAgentConfig } from './config';
import { ensureAutoStartPrepared } from './autostart';
import {
  openProjectFolder,
  resumeWorkspace,
  ResumeAccessOptions,
} from './resumeWorkspace';
import { PairingStore } from './pairingStore';

interface DerivedMappings {
  primary?: { windowsRoot: string; smbRoot: string };
  all: { windowsRoot: string; smbRoot: string }[];
  primaryMountRoot?: string;
}

function parseSharesField(
  sharesRaw: string | undefined,
  host: string,
): { windowsRoot: string; smbRoot: string }[] {
  if (!sharesRaw || !sharesRaw.trim()) {
    return [];
  }

  return sharesRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colonIdx = entry.indexOf(':');
      if (colonIdx < 1) {
        return null;
      }
      const driveLetter = entry.substring(0, colonIdx).toUpperCase();
      const shareName = entry.substring(colonIdx + 1);
      if (!shareName) {
        return null;
      }
      return {
        windowsRoot: `${driveLetter}:\\`,
        smbRoot: `smb://${host}/${encodeURIComponent(shareName)}`,
      };
    })
    .filter((m): m is { windowsRoot: string; smbRoot: string } => m !== null);
}

function deriveMappings(service: BridgeServiceRecord | null): DerivedMappings {
  const empty: DerivedMappings = { all: [] };
  if (!service) {
    return empty;
  }

  const allFromShares = parseSharesField(service.txt.shares, service.host);

  const shareName = service.txt.shareName?.trim();
  const windowsRoot = service.txt.windowsRoot?.trim();
  let primary: { windowsRoot: string; smbRoot: string } | undefined;
  if (shareName && windowsRoot) {
    primary = {
      windowsRoot,
      smbRoot: `smb://${service.host}/${encodeURIComponent(shareName)}`,
    };
  }

  const all = allFromShares.length > 0 ? allFromShares : primary ? [primary] : [];
  const primaryMountRoot = shareName ? `/Volumes/${shareName}` : undefined;

  return { primary, all, primaryMountRoot };
}

async function main(): Promise<void> {
  const config = loadMacAgentConfig();
  const logger = new Logger('agent-mac');

  await ensureAutoStartPrepared(logger);

  const macName = os.hostname().replace(/\.local$/, '');

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
    pendingConnectionRequest: null,
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
  let pairedHostId: string | null = pairingState.pairedHostId;
  let pairedHostName: string | null = pairingState.pairedHostName;

  const persistPairingState = async (): Promise<void> => {
    await pairingStore.save({
      pairedHostId,
      pairedHostName,
      updatedAt: new Date().toISOString(),
    });
  };

  // Publish this Mac on the network so Windows can discover it
  const clientPublisher = new MdnsPublisher(logger);
  clientPublisher.start({
    type: 'bridgeclient',
    name: macName,
    port: config.uiBridgePort,
    txt: {
      platform: 'mac',
      clientId: macName,
      clientName: macName,
    },
  });

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
    const hostId = selectedService?.identity ?? activeTargetHost ?? null;
    const hostName = selectedService?.name ?? activeTargetHost ?? null;

    if (status === 'CONNECTED') {
      lastServerHeartbeatAt = Date.now();
      heartbeatReconnectIssued = false;

      wsClient.send(
        createEnvelope('bridge:hello', {
          agentId: macName,
          name: macName,
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
  });

  wsClient.on('message', (message) => {
    if (message.type === 'workspace:state') {
      const workspaceState = message.payload as WorkspaceState;
      lastServerHeartbeatAt = Date.now();

      const hostId = selectedService?.identity ?? workspaceState.connection.hostId ?? activeTargetHost;
      const hostName = selectedService?.name ?? workspaceState.hostDevice ?? activeTargetHost;
      if (hostId && (!pairedHostId || pairedHostId === hostId)) {
        pairedHostId = hostId;
        pairedHostName = hostName ?? hostId;
        void persistPairingState();
      }

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

    if (message.type === 'bridge:connection-request') {
      const request = message.payload as ConnectionRequest;
      logger.info('Received connection request from host', {
        hostId: request.hostId,
        hostName: request.hostName,
      });

      // If already paired with this host, auto-approve
      if (pairedHostId && pairedHostId === request.hostId) {
        logger.info('Auto-approving connection from paired host');
        wsClient.send(
          createEnvelope('bridge:connection-response', {
            accepted: true,
            clientId: macName,
            clientName: macName,
          }),
        );
        return;
      }

      // Show approval request in tray
      uiBridge.updateStatus({
        pendingConnectionRequest: {
          hostName: request.hostName,
          hostId: request.hostId,
        },
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
    }
  });

  uiBridge.on('action', (payload: UiActionPayload) => {
    void (async () => {
      const action = payload.action;
      try {
        if (action === 'approve-connection') {
          const pending = uiBridge.getStatus().pendingConnectionRequest;
          if (pending) {
            pairedHostId = pending.hostId;
            pairedHostName = pending.hostName;
            await persistPairingState();
            logger.info('Connection approved by user', {
              pairedHostId,
              pairedHostName,
            });

            wsClient.send(
              createEnvelope('bridge:connection-response', {
                accepted: true,
                clientId: macName,
                clientName: macName,
              }),
            );

            uiBridge.updateStatus({ pendingConnectionRequest: null });
          }
          return;
        }

        if (action === 'decline-connection') {
          const pending = uiBridge.getStatus().pendingConnectionRequest;
          if (pending) {
            logger.info('Connection declined by user', {
              hostId: pending.hostId,
              hostName: pending.hostName,
            });

            wsClient.send(
              createEnvelope('bridge:connection-response', {
                accepted: false,
                clientId: macName,
                clientName: macName,
              }),
            );

            uiBridge.updateStatus({ pendingConnectionRequest: null });
          }
          return;
        }

        const derived = deriveMappings(selectedService);
        const dynamicMapping = config.pathMapping ?? derived.primary;
        const dynamicMountRoot = config.smbMountRoot ?? derived.primaryMountRoot;

        await handleUiAction(
          logger,
          action,
          wsClient,
          stateManager,
          () => selectedService,
          connectToSelectedService,
          {
            mapping: dynamicMapping,
            allMappings: derived.all,
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
    }

    void connectToSelectedService();
  }, config.discoverySweepMs);

  const shutdown = (): void => {
    clearInterval(pingInterval);
    clearInterval(heartbeatMonitorInterval);
    clearInterval(discoverySweepInterval);
    browser.stop();
    clientPublisher.stop();
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
