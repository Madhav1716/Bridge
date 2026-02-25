import { app, Menu, Tray, nativeImage } from 'electron';
import { Logger, UiBridgeClient, UiStatusSnapshot } from '@bridge/shared';

const logger = new Logger('ui-tray');
const uiBridgePort = Number(process.env.BRIDGE_UI_BRIDGE_PORT ?? 47832);

let tray: Tray | null = null;
const uiClient = new UiBridgeClient(logger);

let status: UiStatusSnapshot = {
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
};

function createTrayIcon() {
  const image = nativeImage
    .createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8nK4sAAAAASUVORK5CYII=',
    )
    .resize({ width: 16, height: 16 });

  return image;
}

function formatLastUpdate(lastEvent: string | null): string {
  if (!lastEvent) {
    return 'N/A';
  }

  const parsed = new Date(lastEvent);
  if (Number.isNaN(parsed.getTime())) {
    return lastEvent;
  }

  return parsed.toLocaleTimeString();
}

function getLifecycleLabel(connectionStatus: UiStatusSnapshot['connectionStatus']): {
  icon: string;
  text: string;
} {
  switch (connectionStatus) {
    case 'CONNECTED':
      return { icon: '🟢', text: 'Connected' };
    case 'RECONNECTING':
      return { icon: '🟡', text: 'Reconnecting' };
    case 'CONNECTING':
      return { icon: '🟡', text: 'Connecting' };
    case 'DISCOVERING':
      return { icon: '⚪', text: 'Discovering' };
    case 'PAUSED':
      return { icon: '⏸', text: 'Paused' };
    case 'DISCONNECTED':
    default:
      return { icon: '🔴', text: 'Disconnected' };
  }
}

function getCommandStatusLabel(snapshot: UiStatusSnapshot): string {
  const commandState = snapshot.commandState ?? 'idle';
  const command = snapshot.activeCommand ?? 'No command';

  if (commandState === 'running') {
    return `Command: Running (${command})`;
  }

  if (commandState === 'succeeded') {
    return `Command: Succeeded (${command})`;
  }

  if (commandState === 'failed') {
    const exitCode = snapshot.commandExitCode;
    return exitCode === null || exitCode === undefined
      ? `Command: Failed (${command})`
      : `Command: Failed (${command}, exit ${exitCode})`;
  }

  if (commandState === 'cancelled') {
    return `Command: Cancelled (${command})`;
  }

  return 'Command: Idle';
}

function buildMenu(): Electron.Menu {
  const lifecycle = getLifecycleLabel(status.connectionStatus);
  const pauseAction =
    status.connectionStatus === 'PAUSED'
      ? { label: 'Resume', action: 'resume' as const }
      : { label: 'Pause', action: 'pause' as const };
  const commandRunning = status.commandState === 'running';
  const discoveredHosts = status.discoveredHosts ?? [];
  const pairedHostLabel = status.pairedHostName ?? status.pairedHostId ?? 'None';

  const deviceItems: Electron.MenuItemConstructorOptions[] =
    discoveredHosts.length === 0
      ? [
          {
            label: 'No Windows hosts found',
            enabled: false,
          },
        ]
      : discoveredHosts.map((host) => {
          const prefix = host.isConnected ? '🟢' : host.isPaired ? '⭐' : '⚪';
          return {
            label: `${prefix} ${host.hostName} (${host.address})`,
            click: () => {
              uiClient.sendAction('pair-host', host.hostId);
            },
          };
        });

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: `${lifecycle.icon} ${lifecycle.text}`,
      enabled: false,
    },
    {
      label: `Host: ${status.hostDevice ?? 'Not connected'}`,
      enabled: false,
    },
    {
      label: `Project: ${status.activeProject ?? 'No project'}`,
      enabled: false,
    },
    {
      label: `Last Update: ${formatLastUpdate(status.lastEvent)}`,
      enabled: false,
    },
    {
      label: getCommandStatusLabel(status),
      enabled: false,
    },
    {
      type: 'separator',
    },
    {
      label: `Paired Host: ${pairedHostLabel}`,
      enabled: false,
    },
    {
      label: 'Forget Paired Host',
      enabled: Boolean(status.pairedHostId),
      click: () => {
        uiClient.sendAction('clear-paired-host');
      },
    },
    ...deviceItems,
    {
      type: 'separator',
    },
    {
      label: 'Resume Workspace',
      click: () => {
        uiClient.sendAction('resume-workspace');
      },
    },
    {
      label: 'Open Project Folder',
      click: () => {
        uiClient.sendAction('open-project');
      },
    },
    {
      label: 'Control Windows (Remote)',
      enabled: status.connectionStatus === 'CONNECTED',
      click: () => {
        uiClient.sendAction('open-remote-control');
      },
    },
    {
      label: 'Reconnect',
      click: () => {
        uiClient.sendAction('reconnect');
      },
    },
    {
      label: pauseAction.label,
      click: () => {
        uiClient.sendAction(pauseAction.action);
      },
    },
    {
      label: 'Run Windows Command',
      enabled: status.connectionStatus === 'CONNECTED' && !commandRunning,
      click: () => {
        uiClient.sendAction('run-windows-command');
      },
    },
    {
      label: 'Cancel Windows Command',
      enabled: commandRunning,
      click: () => {
        uiClient.sendAction('cancel-windows-command');
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit Bridge Tray',
      click: () => {
        app.quit();
      },
    },
  ];

  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  const lifecycle = getLifecycleLabel(status.connectionStatus);
  tray.setContextMenu(buildMenu());
  tray.setTitle(`Bridge ${lifecycle.icon}`);
  tray.setToolTip(
    `Bridge · ${lifecycle.text} · ${status.activeProject ?? 'No active project'}`,
  );
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  tray = new Tray(createTrayIcon());

  refreshTrayMenu();

  uiClient.on('status', (nextStatus) => {
    status = nextStatus;
    refreshTrayMenu();
  });

  uiClient.connect(uiBridgePort);

  logger.info('Tray UI started', { uiBridgePort });
}

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in tray UI', { error: error.message });
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection in tray UI', { error: String(error) });
});

app.on('before-quit', () => {
  uiClient.disconnect();
});

void bootstrap();
