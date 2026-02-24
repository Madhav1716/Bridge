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

function buildMenu(): Electron.Menu {
  const lifecycle = getLifecycleLabel(status.connectionStatus);
  const pauseAction =
    status.connectionStatus === 'PAUSED'
      ? { label: 'Resume', action: 'resume' as const }
      : { label: 'Pause', action: 'pause' as const };

  return Menu.buildFromTemplate([
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
      type: 'separator',
    },
    {
      label: 'Quit Bridge Tray',
      click: () => {
        app.quit();
      },
    },
  ]);
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
