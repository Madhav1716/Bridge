import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  BridgeWebSocketServer,
  CommandCancelRequest,
  CommandRunRequest,
  createEnvelope,
  DevProcessTracker,
  JsonStore,
  Logger,
  MdnsPublisher,
  ProjectFileWatcher,
  UiBridgeServer,
  WorkspaceState,
  WorkspaceStateManager,
} from '@bridge/shared';
import { loadWindowsAgentConfig } from './config';
import { ensureAutoStartPrepared } from './autostart';
import { WindowsCommandExecutor } from './commandExecutor';

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

  const wsServer = new BridgeWebSocketServer(logger);
  wsServer.start(config.wsPort);

  const uiBridge = new UiBridgeServer(logger, {
    connectionStatus: 'DISCONNECTED',
    hostDevice: config.hostName,
    activeProject: initialState.projectName,
    projectPath: config.projectPath,
    lastEvent: initialState.lastEvent,
    macConnected: 0,
  });
  uiBridge.start(config.uiBridgePort);

  const syncUiStatus = (): void => {
    const clientCount = paused ? 0 : wsServer.getClientIds().length;
    const state = stateManager.getState();
    const connectionStatus = paused
      ? 'PAUSED'
      : clientCount > 0
        ? 'CONNECTED'
        : 'DISCONNECTED';
    uiBridge.updateStatus({
      connectionStatus,
      hostDevice: config.hostName,
      activeProject: state.projectName || null,
      projectPath: state.projectPath || null,
      lastEvent: state.lastEvent,
      macConnected: clientCount,
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

    await stateManager.updateConnectionState({
      lifecycle: connectedClientIds.length > 0 ? 'CONNECTED' : 'DISCONNECTED',
      hostId: config.hostId,
      hostName: config.hostName,
      lastHeartbeatAt,
    });
  };

  wsServer.on('clientsChanged', (_count) => {
    void updateConnectionSnapshot();
    syncUiStatus();
  });

  wsServer.on('clientDisconnected', (clientId) => {
    commandExecutor.cancelCommandsForClient(clientId);
  });

  wsServer.on('message', (clientId, message) => {
    if (message.type === 'bridge:hello') {
      clientHeartbeats.set(clientId, Date.now());
      logger.event(
        {
          component: 'ws-server',
          event: 'client-hello',
          state: stateManager.getState().connection.lifecycle,
          hostId: config.hostId,
        },
        { clientId, payload: message.payload },
      );

      wsServer.sendToClient(
        clientId,
        createEnvelope('workspace:state', stateManager.getState()),
      );
      void updateConnectionSnapshot();
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
      wsServer.broadcast(createEnvelope('workspace:state', state));
    }
    syncUiStatus();
  });

  uiBridge.on('action', (payload) => {
    const action = payload.action;
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
      return;
    }
    if (action === 'restart-host') {
      logger.info('Restarting Bridge host');
      const entry = path.join(__dirname, 'index.js');
      spawn(process.execPath, [entry], {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
      });
      process.exit(0);
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
      remoteControl: config.remoteControlEnabled ? '1' : '0',
      remoteProtocol: config.remoteProtocol,
      remotePort: String(config.remotePort),
      remoteUsername: config.remoteUsername ?? '',
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
