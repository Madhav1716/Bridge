import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AgentHello,
  BridgeServiceRecord,
  BridgeWebSocketServer,
  CommandCancelRequest,
  CommandRunRequest,
  ConnectionResponse,
  createEnvelope,
  DevProcessTracker,
  JsonStore,
  Logger,
  MdnsBrowser,
  MdnsPublisher,
  ProjectFileWatcher,
  UiBridgeServer,
  UiDiscoveredDevice,
  WorkspaceState,
  WorkspaceStateManager,
} from '@bridge/shared';
import { loadWindowsAgentConfig } from './config';
import { ensureAutoStartPrepared } from './autostart';
import { WindowsCommandExecutor } from './commandExecutor';

interface TrackedMacClient {
  id: string;
  name: string;
  address: string;
  wsClientId: number | null;
  paired: boolean;
  lastSeenAt: number;
}

async function main(): Promise<void> {
  const config = loadWindowsAgentConfig();
  const logger = new Logger('agent-windows');

  const initialState: WorkspaceState = {
    projectName: path.basename(config.projectPath),
    projectPath: config.projectPath,
    openFiles: config.mockOpenFiles,
    recentlyModifiedFiles: [],
    processes: [],
    activeProcess: false,
    hostDevice: config.hostName,
    connection: {
      lifecycle: 'DISCONNECTED',
      hostId: config.hostId,
      hostName: config.hostName,
      lastHeartbeatAt: null,
      lastTransitionAt: new Date().toISOString(),
    },
    lastEvent: new Date().toISOString(),
  };

  const store = new JsonStore<WorkspaceState>(config.statePath);
  const stateManager = new WorkspaceStateManager(logger, store, initialState);
  await stateManager.init();

  await stateManager.updateWorkspaceMetadata({
    projectName: path.basename(config.projectPath),
    projectPath: config.projectPath,
    hostDevice: config.hostName,
    openFiles: config.mockOpenFiles,
  });

  await ensureAutoStartPrepared(logger);

  let paused = false;

  // Track Mac clients: discovered via mDNS or WS
  const macClients = new Map<string, TrackedMacClient>();
  // Map WS client IDs to Mac client IDs
  const wsToMac = new Map<number, string>();
  // Paired Mac IDs persisted across restarts
  const pairedMacIds = new Set<string>();

  const wsServer = new BridgeWebSocketServer(logger);
  wsServer.start(config.wsPort);

  const uiBridge = new UiBridgeServer(logger, {
    connectionStatus: 'DISCONNECTED',
    hostDevice: config.hostName,
    activeProject: initialState.projectName,
    projectPath: config.projectPath,
    lastEvent: initialState.lastEvent,
    connectedDevice: null,
    discoveredDevices: [],
  });
  uiBridge.start(config.uiBridgePort);

  const buildDeviceList = (): UiDiscoveredDevice[] => {
    const devices: UiDiscoveredDevice[] = [];
    for (const client of macClients.values()) {
      devices.push({
        id: client.id,
        name: client.name,
        address: client.address,
        connected: client.wsClientId !== null,
        paired: client.paired,
      });
    }
    return devices;
  };

  const getConnectedDeviceName = (): string | null => {
    for (const client of macClients.values()) {
      if (client.paired && client.wsClientId !== null) {
        return client.name;
      }
    }
    return null;
  };

  const syncUiStatus = (): void => {
    const state = stateManager.getState();
    const connectedDevice = getConnectedDeviceName();
    const connectionStatus = paused
      ? 'PAUSED'
      : connectedDevice
        ? 'CONNECTED'
        : 'DISCONNECTED';
    uiBridge.updateStatus({
      connectionStatus,
      hostDevice: config.hostName,
      activeProject: state.projectName || null,
      projectPath: state.projectPath || null,
      lastEvent: state.lastEvent,
      connectedDevice,
      discoveredDevices: buildDeviceList(),
    });
  };

  const commandExecutor = new WindowsCommandExecutor(logger, wsServer, {
    projectPath: config.projectPath,
    sharedWindowsRoot: config.sharedWindowsRoot,
    allowedCommands: config.allowedCommands,
    commandTimeoutMs: config.commandTimeoutMs,
  });

  const clientHeartbeats = new Map<number, number>();

  const updateConnectionSnapshot = async (): Promise<void> => {
    const connectedClientIds = wsServer.getClientIds();
    for (const clientId of [...clientHeartbeats.keys()]) {
      if (!connectedClientIds.includes(clientId)) {
        clientHeartbeats.delete(clientId);
      }
    }

    const heartbeatValues = [...clientHeartbeats.values()];
    const lastHeartbeatAt =
      heartbeatValues.length > 0
        ? new Date(Math.max(...heartbeatValues)).toISOString()
        : null;

    const hasPairedConnected = getConnectedDeviceName() !== null;
    await stateManager.updateConnectionState({
      lifecycle: hasPairedConnected ? 'CONNECTED' : 'DISCONNECTED',
      hostId: config.hostId,
      hostName: config.hostName,
      lastHeartbeatAt,
    });
  };

  const sendWorkspaceStateToPaired = (): void => {
    const state = stateManager.getState();
    const envelope = createEnvelope('workspace:state', state);
    for (const client of macClients.values()) {
      if (client.paired && client.wsClientId !== null) {
        wsServer.sendToClient(client.wsClientId, envelope);
      }
    }
  };

  // Browse for Mac clients on the network
  const macBrowser = new MdnsBrowser(logger);

  macBrowser.on('serviceUp', (service) => {
    const platform = service.txt.platform;
    if (platform && platform !== 'mac') {
      return;
    }

    const clientId = service.txt.clientId ?? service.name;
    const existing = macClients.get(clientId);
    macClients.set(clientId, {
      id: clientId,
      name: service.txt.clientName ?? service.name,
      address: service.host,
      wsClientId: existing?.wsClientId ?? null,
      paired: existing?.paired ?? pairedMacIds.has(clientId),
      lastSeenAt: Date.now(),
    });

    logger.info('Mac discovered via mDNS', {
      clientId,
      name: service.name,
      host: service.host,
    });

    syncUiStatus();
  });

  macBrowser.on('serviceDown', (service) => {
    const clientId = service.txt.clientId ?? service.name;
    const existing = macClients.get(clientId);
    if (existing && existing.wsClientId === null) {
      macClients.delete(clientId);
    }
    syncUiStatus();
  });

  macBrowser.start('bridgeclient');

  wsServer.on('clientsChanged', (_count) => {
    void updateConnectionSnapshot();
    syncUiStatus();
  });

  wsServer.on('clientDisconnected', (clientId) => {
    commandExecutor.cancelCommandsForClient(clientId);
    const macId = wsToMac.get(clientId);
    if (macId) {
      const entry = macClients.get(macId);
      if (entry) {
        entry.wsClientId = null;
      }
      wsToMac.delete(clientId);
    }
    syncUiStatus();
  });

  wsServer.on('message', (clientId, message) => {
    if (message.type === 'bridge:hello') {
      const hello = message.payload as AgentHello;
      clientHeartbeats.set(clientId, Date.now());

      const macId = hello.agentId ?? hello.name;
      wsToMac.set(clientId, macId);

      const existing = macClients.get(macId);
      const isPaired = existing?.paired ?? pairedMacIds.has(macId);
      macClients.set(macId, {
        id: macId,
        name: hello.name,
        address: '',
        wsClientId: clientId,
        paired: isPaired,
        lastSeenAt: Date.now(),
      });

      logger.event(
        {
          component: 'ws-server',
          event: 'client-hello',
          state: stateManager.getState().connection.lifecycle,
          hostId: config.hostId,
        },
        { clientId, macId, name: hello.name, paired: isPaired },
      );

      if (isPaired) {
        wsServer.sendToClient(
          clientId,
          createEnvelope('workspace:state', stateManager.getState()),
        );
      }

      void updateConnectionSnapshot();
      syncUiStatus();
      return;
    }

    if (message.type === 'bridge:connection-response') {
      const response = message.payload as ConnectionResponse;
      const macId = wsToMac.get(clientId) ?? response.clientId;

      if (response.accepted) {
        pairedMacIds.add(macId);
        const entry = macClients.get(macId);
        if (entry) {
          entry.paired = true;
        }
        logger.info('Mac approved connection', { macId, clientName: response.clientName });

        wsServer.sendToClient(
          clientId,
          createEnvelope('workspace:state', stateManager.getState()),
        );
      } else {
        logger.info('Mac declined connection', { macId, clientName: response.clientName });
      }

      void updateConnectionSnapshot();
      syncUiStatus();
      return;
    }

    if (message.type === 'bridge:ping') {
      wsServer.sendToClient(
        clientId,
        createEnvelope('bridge:pong', {
          timestamp: new Date().toISOString(),
          hostId: config.hostId,
        }),
      );
      return;
    }

    if (message.type === 'bridge:pong') {
      clientHeartbeats.set(clientId, Date.now());
      void stateManager.updateConnectionState({
        lifecycle: 'CONNECTED',
        hostId: config.hostId,
        hostName: config.hostName,
        lastHeartbeatAt: new Date().toISOString(),
      });
      return;
    }

    if (message.type === 'command:run') {
      commandExecutor.handleRunRequest(clientId, message.payload as CommandRunRequest);
      return;
    }

    if (message.type === 'command:cancel') {
      commandExecutor.handleCancelRequest(
        clientId,
        message.payload as CommandCancelRequest,
      );
    }
  });

  stateManager.on('changed', (state) => {
    if (!paused) {
      sendWorkspaceStateToPaired();
    }
    syncUiStatus();
  });

  uiBridge.on('action', (payload) => {
    const action = payload.action;

    if (action === 'connect-device' && payload.hostId) {
      const targetMac = macClients.get(payload.hostId);
      if (!targetMac) {
        logger.warn('Connect device: unknown Mac', { hostId: payload.hostId });
        return;
      }

      if (targetMac.paired) {
        logger.info('Mac already paired', { macId: targetMac.id });
        return;
      }

      if (targetMac.wsClientId === null) {
        logger.warn('Connect device: Mac not connected via WebSocket yet', {
          macId: targetMac.id,
        });
        return;
      }

      logger.info('Sending connection request to Mac', { macId: targetMac.id });
      wsServer.sendToClient(
        targetMac.wsClientId,
        createEnvelope('bridge:connection-request', {
          hostId: config.hostId,
          hostName: config.hostName,
        }),
      );
      return;
    }

    if (action === 'pause') {
      paused = true;
      wsServer.stop();
      syncUiStatus();
      logger.info('Bridge paused by user');
      return;
    }

    if (action === 'resume') {
      paused = false;
      wsServer.start(config.wsPort);
      syncUiStatus();
      logger.info('Bridge resumed by user');
      return;
    }

    if (action === 'open-project') {
      try {
        spawn('explorer', [config.projectPath], { stdio: 'ignore' });
      } catch (err) {
        logger.warn('Failed to open project folder', { error: (err as Error).message });
      }
    }
  });

  syncUiStatus();

  const publisher = new MdnsPublisher(logger);
  publisher.start({
    type: config.discoveryType,
    name: config.hostName,
    port: config.wsPort,
    txt: {
      platform: 'windows',
      projectName: initialState.projectName,
      hostId: config.hostId,
      shareName: config.shareName ?? '',
      windowsRoot: config.sharedWindowsRoot,
      shares: config.shares,
    },
  });

  const fileWatcher = new ProjectFileWatcher(
    logger,
    config.projectPath,
    (relativePath) => {
      if (config.mockOpenFiles.length > 0) {
        void stateManager.updateRecentFiles({ modifiedFilePath: relativePath });
        return;
      }

      const absolutePath = path.join(config.projectPath, relativePath);
      const nextOpenFiles = [
        absolutePath,
        ...stateManager
          .getState()
          .openFiles.filter((openFile) => openFile !== absolutePath),
      ].slice(0, 8);

      void stateManager.updateRecentFiles({
        modifiedFilePath: relativePath,
        openFiles: nextOpenFiles,
      });
    },
  );
  fileWatcher.start();

  const processTracker = new DevProcessTracker(logger);

  const refreshProcessState = async (): Promise<void> => {
    const processes = await processTracker.snapshot();
    await stateManager.updateProcessStatus(processes);
  };

  await refreshProcessState();
  const processInterval = setInterval(() => {
    void refreshProcessState();
  }, config.processPollMs);

  const heartbeatInterval = setInterval(() => {
    const now = Date.now();

    for (const clientId of wsServer.getClientIds()) {
      wsServer.sendToClient(
        clientId,
        createEnvelope('bridge:ping', {
          timestamp: new Date(now).toISOString(),
          hostId: config.hostId,
        }),
      );

      const lastSeen = clientHeartbeats.get(clientId);
      if (!lastSeen) {
        continue;
      }

      if (now - lastSeen > config.heartbeatTimeoutMs) {
        logger.warn('Disconnecting stale websocket client', {
          clientId,
          timeoutMs: config.heartbeatTimeoutMs,
        });
        clientHeartbeats.delete(clientId);
        commandExecutor.cancelCommandsForClient(clientId);
        wsServer.closeClient(clientId);
      }
    }

    void updateConnectionSnapshot();
  }, config.heartbeatMs);

  const shutdown = async (): Promise<void> => {
    clearInterval(processInterval);
    clearInterval(heartbeatInterval);
    commandExecutor.stopAll();
    await fileWatcher.stop();
    publisher.stop();
    macBrowser.stop();
    wsServer.stop();
    uiBridge.stop();
    logger.info('Windows agent stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });

  logger.event(
    {
      component: 'agent-windows',
      event: 'started',
      state: stateManager.getState().connection.lifecycle,
      hostId: config.hostId,
    },
    {
      wsPort: config.wsPort,
      projectPath: config.projectPath,
    },
  );
}

process.on('unhandledRejection', (error) => {
  const logger = new Logger('agent-windows');
  logger.error('Unhandled rejection', {
    error: String(error),
  });
});

process.on('uncaughtException', (error) => {
  const logger = new Logger('agent-windows');
  logger.error('Uncaught exception', { error: error.message });
});

void main();
