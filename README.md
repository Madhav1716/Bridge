# Bridge MVP

Bridge is a LAN-only background system for workspace continuity between a Windows host and a Mac client.

- Windows Agent hosts workspace state and WebSocket updates.
- Mac Agent discovers Windows automatically (mDNS), receives state, and can reconstruct workspace context.
- Tray UI is tiny (tray/menu bar only) and controls reconnect/pause/resume/open actions.

No cloud, no custom file sync, no dashboard.

## Monorepo Structure

```text
/Users/maddy/Development/Bridge
├── agent-windows
│   └── src
│       ├── autostart.ts
│       ├── commandExecutor.ts
│       ├── config.ts
│       └── index.ts
├── agent-mac
│   └── src
│       ├── autostart.ts
│       ├── commandRequest.ts
│       ├── config.ts
│       ├── index.ts
│       └── resumeWorkspace.ts
├── shared
│   └── src
│       ├── discovery
│       │   ├── mdnsBrowser.ts
│       │   ├── hostSelection.ts
│       │   └── mdnsPublisher.ts
│       ├── filesystem
│       │   └── projectFileWatcher.ts
│       ├── networking
│       │   ├── webSocketClient.ts
│       │   ├── webSocketServer.ts
│       │   └── wsProtocol.ts
│       ├── process
│       │   └── processTracker.ts
│       ├── state
│       │   ├── jsonStore.ts
│       │   └── workspaceStateManager.ts
│       ├── ui
│       │   ├── uiBridgeClient.ts
│       │   └── uiBridgeServer.ts
│       ├── utils
│       │   └── pathMapping.ts
│       ├── workspace
│       │   └── resumeIntent.ts
│       ├── index.ts
│       ├── logger.ts
│       └── types.ts
└── ui-tray
    └── src
        └── main.ts
```

## Architecture and Data Flow

1. Windows Agent initializes state for the active project path.
2. Windows Agent watches project file events (`chokidar`) and dev process status (`ps-list`).
3. Windows Agent publishes mDNS service (`bonjour`) and hosts WebSocket state stream (`ws`).
4. Mac Agent browses mDNS services and auto-connects/reconnects over WebSocket.
5. Mac Agent stores latest workspace state locally and exposes a local UI bridge socket.
6. Tray UI connects to the local UI bridge and shows status/actions only.
7. `Resume Workspace` on Mac opens the shared project path and attempts to open tracked files.
8. `Run Windows Command` on Mac sends an allowlisted command to Windows and streams lifecycle events.

Connection lifecycle model:
- `DISCONNECTED`
- `DISCOVERING`
- `CONNECTING`
- `CONNECTED`
- `PAUSED`
- `RECONNECTING`

## Implemented MVP Phases

### Phase 1: Shared Core + Agent WebSocket Communication

Decision:
- Keep all cross-agent contracts and infrastructure inside `/shared` to avoid drift.
- Use typed envelope messages and reconnecting client behavior.

Includes:
- Message contracts
- WebSocket server/client
- mDNS publisher/browser
- JSON state store + manager
- File watcher
- Process tracker
- UI bridge protocol

### Phase 2: Windows Agent (Host)

Decision:
- Keep host logic small and event-driven: watcher/process updates directly feed state manager and broadcasts.

Includes:
- Project state initialization
- Recent file tracking
- Dev process detection snapshots
- mDNS host publishing
- WebSocket server and heartbeat state pushes
- Autostart placeholder hook

### Phase 3: Mac Agent (Client)

Decision:
- Mac agent remains headless and acts as a continuity reconstructor, not process migrator.

Includes:
- mDNS discovery + service selection
- deterministic host selection with stale pruning
- Auto-reconnecting WebSocket client
- Local state persistence
- Local UI bridge server for tray integration
- `Resume Workspace` and `Open Project Folder` actions
- Shared-path mapping support (`BRIDGE_WINDOWS_PROJECT_ROOT` + `BRIDGE_SMB_ROOT`)
- Autostart placeholder hook

### Phase 4: Tiny Tray UI

Decision:
- Electron main-process-only tray app (no dashboard window) to match minimal UX requirements.

Includes:
- Connection/host/project/last-event status
- Quick actions: reconnect, pause/resume, open project folder, resume workspace, run/cancel Windows command

## Prerequisites

- Node.js 20+
- Windows and Mac on the same LAN
- Native shared folder (SMB) configured so Mac can access the Windows project directory

## Build

```bash
cd /Users/maddy/Development/Bridge
npm install
npm run build
```

## Easier Startup (One-Time Config Files)

You can avoid repeated env vars with one-time setup scripts.

Mac setup:
```bash
cd /Users/maddy/Development/Bridge
npm run setup:mac
```

Windows setup (run in Administrator PowerShell):
```powershell
cd D:\Bridge\Bridge
npm run setup:windows
```

When prompted for permission mode, choose `everyone` for easiest first-time setup (no dedicated SMB user required).

These scripts:
- create/update local config files (`bridge.mac.json`, `bridge.windows.json`)
- prepare SMB path settings
- prepare one-time share permissions/firewall rules on Windows
- trigger the first SMB mount prompt on Mac
- let Mac setup optionally store SMB username in `smb://user@host/share` format

Daily run after setup:
- Windows: `npm run start:windows`
- Mac (agent + tray together): `npm run start:mac:all`

You can also create configs manually:

Mac manual:
1. Copy [bridge.mac.example.json](/Users/maddy/Development/Bridge/bridge.mac.example.json) to `bridge.mac.json`.
2. Update `windowsProjectRoot`, `smbRoot`, and `smbMountRoot`.
3. Start with `npm run start:mac`.

Windows manual:
1. Copy [bridge.windows.example.json](/Users/maddy/Development/Bridge/bridge.windows.example.json) to `bridge.windows.json`.
2. Update `projectPath`, `windowsProjectRoot`, and `shareName`.
3. Start with `npm run start:windows`.

Environment variables still work and override config file values.

## Run

### Recommended Daily Start (after one-time setup)

Windows:
```bat
npm run start:windows
```

Mac:
```bash
npm run start:mac:all
```

### 1. Start Windows Agent (on Windows machine)

```bash
cd /Users/maddy/Development/Bridge
set BRIDGE_PROJECT_PATH=C:\path\to\project
set BRIDGE_OPEN_FILES=src/index.ts,README.md
npm run start:windows
```

Optional environment variables:
- `BRIDGE_WS_PORT` (default `47831`)
- `BRIDGE_DISCOVERY_TYPE` (default `bridgeworkspace`)
- `BRIDGE_WINDOWS_STATE_PATH`
- `BRIDGE_HOST_ID` (default hostname, used for stable identity)
- `BRIDGE_HEARTBEAT_MS` (default `4000`)
- `BRIDGE_HEARTBEAT_TIMEOUT_MS` (default `12000`)
- `BRIDGE_SHARE_NAME` (recommended: SMB share name; enables Mac auto-mapping)
- `BRIDGE_WINDOWS_PROJECT_ROOT` (optional shared root path for mapping; defaults to `BRIDGE_PROJECT_PATH`)
- `BRIDGE_ALLOWED_COMMANDS` (comma-separated allowlist for remote command execution)
- `BRIDGE_COMMAND_TIMEOUT_MS` (default `900000`)

### 2. Start Mac Agent (on Mac machine)

```bash
cd /Users/maddy/Development/Bridge
export BRIDGE_WINDOWS_PROJECT_ROOT='C:\path\to\project-root'
export BRIDGE_SMB_ROOT='smb://WINDOWS-HOST/Shared/project-root'
npm run start:mac
```

Or start Mac agent + tray in one command:
```bash
npm run start:mac:all
```

Optional environment variables:
- `BRIDGE_UI_BRIDGE_PORT` (default `47832`)
- `BRIDGE_DISCOVERY_TYPE` (default `bridgeworkspace`)
- `BRIDGE_MAC_STATE_PATH`
- `BRIDGE_PING_MS` (default `5000`)
- `BRIDGE_HEARTBEAT_TIMEOUT_MS` (default `12000`)
- `BRIDGE_DISCOVERY_STALE_MS` (default `15000`)
- `BRIDGE_DISCOVERY_SWEEP_MS` (default `4000`)
- `BRIDGE_SMB_MOUNT_ROOT` (optional, default derived as `/Volumes/<ShareName>`)
- `BRIDGE_SMB_MOUNT_TIMEOUT_MS` (default `12000`)
- `BRIDGE_WINDOWS_COMMAND` (command run by tray action; default `npm -v`)
- `BRIDGE_WINDOWS_COMMAND_CWD` (optional Windows working directory)

### Easier Setup Path (Recommended)

You can avoid manual Mac path-mapping variables by publishing share metadata from Windows.

Windows:
```bat
set BRIDGE_PROJECT_PATH=D:\Bridge\Bridge\agent-windows
set BRIDGE_SHARE_NAME=BridgeShare
set BRIDGE_WINDOWS_PROJECT_ROOT=D:\Bridge\Bridge
npm run start:windows
```

Mac:
```bash
npm run start:mac
```

Bridge will derive SMB mapping from discovery metadata and prompt for SMB login once.

### 3. Start Tray UI (on Mac machine)

```bash
cd /Users/maddy/Development/Bridge
npm run start:tray
```

### 4. Test Windows Command Execution (from Mac tray)

Set the default command on Mac agent before startup:

```bash
export BRIDGE_WINDOWS_COMMAND='npm -v'
```

Then in tray:
- Click `Run Windows Command` to execute on Windows host.
- Click `Cancel Windows Command` to stop a running command.

The tray status line shows command state (`Idle`, `Running`, `Succeeded`, `Failed`, `Cancelled`).

## Notes

- This MVP intentionally reconstructs state only; it does not migrate running processes.
- File sync is intentionally not implemented; use SMB/native sharing.
- Autostart registration is represented by explicit placeholder hooks in both agents.
