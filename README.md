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
│       ├── config.ts
│       └── index.ts
├── agent-mac
│   └── src
│       ├── autostart.ts
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
- Quick actions: reconnect, pause/resume, open project folder, resume workspace

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

## Run

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

### 2. Start Mac Agent (on Mac machine)

```bash
cd /Users/maddy/Development/Bridge
export BRIDGE_WINDOWS_PROJECT_ROOT='C:\path\to\project-root'
export BRIDGE_SMB_ROOT='smb://WINDOWS-HOST/Shared/project-root'
npm run start:mac
```

Optional environment variables:
- `BRIDGE_UI_BRIDGE_PORT` (default `47832`)
- `BRIDGE_DISCOVERY_TYPE` (default `bridgeworkspace`)
- `BRIDGE_MAC_STATE_PATH`
- `BRIDGE_PING_MS` (default `5000`)
- `BRIDGE_HEARTBEAT_TIMEOUT_MS` (default `12000`)
- `BRIDGE_DISCOVERY_STALE_MS` (default `15000`)
- `BRIDGE_DISCOVERY_SWEEP_MS` (default `4000`)

### 3. Start Tray UI (on Mac machine)

```bash
cd /Users/maddy/Development/Bridge
npm run start:tray
```

## Notes

- This MVP intentionally reconstructs state only; it does not migrate running processes.
- File sync is intentionally not implemented; use SMB/native sharing.
- Autostart registration is represented by explicit placeholder hooks in both agents.
# Bridge
# Bridge
# Bridge
