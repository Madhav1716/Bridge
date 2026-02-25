import { app, Menu, Tray, nativeImage } from 'electron';
import { Logger, UiBridgeClient, UiStatusSnapshot } from '@bridge/shared';

const logger = new Logger('ui-tray');
const isWindowsHost = process.platform === 'win32';
const defaultPort = isWindowsHost ? 47833 : 47832;
const uiBridgePort = Number(process.env.BRIDGE_UI_BRIDGE_PORT ?? defaultPort);

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

/** Windows host: same icons, but DISCONNECTED = "Hosting" (waiting for Mac) */
function getLifecycleLabelForHost(connectionStatus: UiStatusSnapshot['connectionStatus']): {
  icon: string;
  text: string;
} {
  switch (connectionStatus) {
    case 'CONNECTED':
      return { icon: '🟢', text: 'Connected' };
    case 'PAUSED':
      return { icon: '⏸', text: 'Paused' };
    case 'DISCONNECTED':
    default:
      return { icon: '🟢', text: 'Hosting' };
  }
}

function buildMacMenu(): Electron.Menu {
  const lifecycle = getLifecycleLabel(status.connectionStatus);
  const isPaused = status.connectionStatus === 'PAUSED';

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: `${lifecycle.icon} ${lifecycle.text}`, enabled: false },
    { label: `Host: ${status.hostDevice ?? 'Not connected'}`, enabled: false },
    { label: `Project: ${status.activeProject ?? 'No project'}`, enabled: false },
    { label: `Last Update: ${formatLastUpdate(status.lastEvent)}`, enabled: false },
    { type: 'separator' },
    { label: 'Resume Workspace', click: () => uiClient.sendAction('resume-workspace') },
    { label: 'Open Project Folder', click: () => uiClient.sendAction('open-project') },
    {
      label: 'Access Windows',
      enabled: status.connectionStatus === 'CONNECTED',
      click: () => uiClient.sendAction('open-remote-control'),
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume' : 'Pause',
      click: () => uiClient.sendAction(isPaused ? 'resume' : 'pause'),
    },
    { label: 'Reconnect', click: () => uiClient.sendAction('reconnect') },
    { type: 'separator' },
    { label: 'Quit Bridge', click: () => app.quit() },
  ];

  return Menu.buildFromTemplate(template);
}

function buildWindowsMenu(): Electron.Menu {
  const lifecycle = getLifecycleLabelForHost(status.connectionStatus);
  const isPaused = status.connectionStatus === 'PAUSED';
  const macCount = status.macConnected ?? 0;
  const macConnectedLabel = macCount > 0 ? `Yes (${macCount})` : 'No';

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: `Status: ${lifecycle.icon} ${lifecycle.text}`, enabled: false },
    { label: `Project: ${status.activeProject ?? 'No project'}`, enabled: false },
    { label: `Mac Connected: ${macConnectedLabel}`, enabled: false },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume Bridge' : 'Pause Bridge',
      click: () => uiClient.sendAction(isPaused ? 'resume' : 'pause'),
    },
    { label: 'Restart Host', click: () => uiClient.sendAction('restart-host') },
    { label: 'Open Project Folder', click: () => uiClient.sendAction('open-project') },
    { type: 'separator' },
    { label: 'Quit Bridge', click: () => app.quit() },
  ];

  return Menu.buildFromTemplate(template);
}

function buildMenu(): Electron.Menu {
  return isWindowsHost ? buildWindowsMenu() : buildMacMenu();
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  const lifecycle = isWindowsHost
    ? getLifecycleLabelForHost(status.connectionStatus)
    : getLifecycleLabel(status.connectionStatus);

  tray.setContextMenu(buildMenu());
  tray.setTitle(`Bridge ${lifecycle.icon}`);
  tray.setToolTip(
    `Bridge · ${lifecycle.text} · ${status.activeProject ?? (isWindowsHost ? 'Hosting' : 'No active project')}`,
  );
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  tray = new Tray(createTrayIcon());

  tray.on('click', () => {
    if (tray) {
      tray.popUpContextMenu();
    }
  });

  refreshTrayMenu();

  uiClient.on('status', (nextStatus) => {
    status = nextStatus;
    refreshTrayMenu();
  });

  uiClient.connect(uiBridgePort);

  logger.info('Tray UI started', { uiBridgePort, isWindowsHost });
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
