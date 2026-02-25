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
  connectedDevice: null,
  discoveredDevices: [],
  pendingConnectionRequest: null,
};

function createTrayIcon() {
  const image = nativeImage
    .createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8nK4sAAAAASUVORK5CYII=',
    )
    .resize({ width: 16, height: 16 });

  return image;
}

function getStatusIcon(connectionStatus: UiStatusSnapshot['connectionStatus']): string {
  switch (connectionStatus) {
    case 'CONNECTED':
      return '\u{1F7E2}';
    case 'RECONNECTING':
    case 'CONNECTING':
      return '\u{1F7E1}';
    case 'DISCOVERING':
      return '\u26AA';
    case 'PAUSED':
      return '\u23F8';
    case 'DISCONNECTED':
    default:
      return '\u{1F534}';
  }
}

function getStatusText(connectionStatus: UiStatusSnapshot['connectionStatus']): string {
  switch (connectionStatus) {
    case 'CONNECTED':
      return 'Connected';
    case 'RECONNECTING':
      return 'Reconnecting';
    case 'CONNECTING':
      return 'Connecting';
    case 'DISCOVERING':
      return 'Discovering';
    case 'PAUSED':
      return 'Paused';
    case 'DISCONNECTED':
    default:
      return 'Disconnected';
  }
}

function buildWindowsMenu(): Electron.Menu {
  const isPaused = status.connectionStatus === 'PAUSED';
  const statusLabel = isPaused ? 'Paused' : 'Hosting Workspace';
  const icon = getStatusIcon(status.connectionStatus);
  const connectedDevice = status.connectedDevice ?? 'None';
  const devices = status.discoveredDevices ?? [];

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Bridge', enabled: false },
    { type: 'separator' },
    { label: `Status: ${statusLabel}`, enabled: false },
    { label: `Connected Device: ${connectedDevice}`, enabled: false },
    { type: 'separator' },
    { label: 'Devices on this WiFi:', enabled: false },
  ];

  if (devices.length === 0) {
    template.push({
      label: '  No devices found',
      enabled: false,
    });
    template.push({
      label: '  (Run Bridge on Mac, same WiFi)',
      enabled: false,
    });
  } else {
    for (const device of devices) {
      const suffix = device.paired ? ' (paired)' : device.connected ? ' (connected)' : '';
      template.push({
        label: `  \u2022 ${device.name}${suffix}`,
        enabled: false,
      });
    }
  }

  template.push({ type: 'separator' });

  const unpairedDevices = devices.filter((d) => !d.paired && d.connected);
  if (unpairedDevices.length > 0) {
    template.push({
      label: 'Connect Device',
      submenu: unpairedDevices.map((d) => ({
        label: d.name,
        click: () => uiClient.sendAction('connect-device', d.id),
      })),
    });
  } else {
    template.push({
      label: 'Connect Device',
      enabled: false,
    });
  }

  template.push(
    { type: 'separator' },
    {
      label: isPaused ? 'Resume' : 'Pause',
      click: () => uiClient.sendAction(isPaused ? 'resume' : 'pause'),
    },
    {
      label: 'Open Project Folder',
      click: () => uiClient.sendAction('open-project'),
    },
    { type: 'separator' },
    { label: 'Quit Bridge', click: () => app.quit() },
  );

  tray?.setTitle(`Bridge ${icon}`);

  return Menu.buildFromTemplate(template);
}

function buildMacMenu(): Electron.Menu {
  const icon = getStatusIcon(status.connectionStatus);
  const statusText = getStatusText(status.connectionStatus);
  const isPaused = status.connectionStatus === 'PAUSED';
  const pending = status.pendingConnectionRequest;

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Bridge', enabled: false },
    { type: 'separator' },
    { label: `Status: ${statusText}`, enabled: false },
    { label: `Host: ${status.hostDevice ?? 'Not connected'}`, enabled: false },
    { label: `Project: ${status.activeProject ?? 'No project'}`, enabled: false },
    { type: 'separator' },
  ];

  if (pending) {
    template.push(
      { label: `${pending.hostName} wants to connect.`, enabled: false },
      {
        label: 'Approve',
        click: () => uiClient.sendAction('approve-connection'),
      },
      {
        label: 'Decline',
        click: () => uiClient.sendAction('decline-connection'),
      },
      { type: 'separator' },
    );
  }

  template.push(
    { label: 'Resume Workspace', click: () => uiClient.sendAction('resume-workspace') },
    { label: 'Open Project Folder', click: () => uiClient.sendAction('open-project') },
    {
      label: isPaused ? 'Resume' : 'Pause',
      click: () => uiClient.sendAction(isPaused ? 'resume' : 'pause'),
    },
    { label: 'Reconnect', click: () => uiClient.sendAction('reconnect') },
  );

  tray?.setTitle(`Bridge ${icon}`);

  return Menu.buildFromTemplate(template);
}

function refreshTrayMenu(): void {
  if (!tray) {
    return;
  }

  const menu = isWindowsHost ? buildWindowsMenu() : buildMacMenu();
  tray.setContextMenu(menu);

  const icon = getStatusIcon(status.connectionStatus);
  const statusText = getStatusText(status.connectionStatus);
  tray.setToolTip(`Bridge \u00B7 ${statusText}`);
  tray.setTitle(`Bridge ${icon}`);
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
