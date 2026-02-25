# Bridge MVP

Bridge is a LAN-only background system for workspace continuity between a Windows host and a Mac client.

- **Access entire Windows from Mac:** In the Mac tray, use **Access Windows** to open the full Windows desktop (Remote Desktop). No folder sharing required for full PC access. (Windows Pro/Enterprise required for RDP hosting.)
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
│       ├── remoteControl.ts
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
8. Commands and config are kept minimal so setup stays one-time and automatic.

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

## Build

```bash
cd /Users/maddy/Development/Bridge
npm install
npm run build
```

## Quick setup (minimal steps)

**Goal: one-time setup on each machine, then Bridge runs automatically.**

### On Windows (run once as Administrator)

1. Open PowerShell **as Administrator** (right-click, Run as administrator).
2. Go to the Bridge repo:
   ```powershell
   cd D:\Bridge\Bridge
   ```
3. Run setup — fully automatic, no prompts:
   ```powershell
   npm run setup:windows
   ```
   Bridge detects all drives and shares them so Mac can access any folder.
4. Start Bridge: `npm run start:windows`  
   To run the agent and the system-tray icon together: `npm run start:windows:all`. The tray shows status (Hosting / Connected / Paused), project, Mac connected, and quick actions (Pause, Restart, Open Project Folder)—same mental model as the Mac tray.

### On Mac (run once)

1. In the repo (or your project):
   ```bash
   cd /path/to/Bridge
   npm run setup:mac
   ```
   You’ll only be asked for a Windows IP if Bridge can’t find your PC automatically (e.g. strict firewall). Press Enter to skip and use auto-discovery.
2. Start Bridge: `npm run start:mac:all`

**That’s it.** Bridge will find the Windows PC, connect, and remember it. The first time you click **Resume Workspace** or **Open Project Folder** in the tray, macOS may ask you to connect to the Windows folder—approve once and you’re set.

### Daily use

- **Windows:** `npm run start:windows` (or `npm run start:windows:all` for agent + tray)
- **Mac:** `npm run start:mac:all`

No need to reconfigure or reconnect; Bridge auto-discovers and auto-pairs on first connection.

## How to test

**1. Build once**

```bash
cd /path/to/Bridge
npm install
npm run build
```

**2. Test on Mac only** (no Windows needed)

- Run: `npm run start:mac:all`
- You should see: a Bridge icon in the menu bar; tray menu shows **Discovering** or **Disconnected**, Host: Not connected, Project: No project.
- Click **Quit Bridge** to stop.

**3. Test on Windows only**

- Run: `npm run start:windows:all` (or run `npm run start:windows` in one terminal and `npm run start:tray` in another).
- You should see: a Bridge icon in the system tray; tray menu shows **Hosting**, Project: &lt;your project name&gt;, Mac Connected: No.
- Try **Pause Bridge** → status becomes Paused; **Resume Bridge** → back to Hosting. **Open Project Folder** → opens the project in Explorer. **Quit Bridge** to stop.

**4. Test full flow (Windows + Mac on same LAN)**

1. **One-time setup** (if not done): run `npm run setup:windows` (as Admin) on Windows and `npm run setup:mac` on Mac.
2. **Windows:** `npm run start:windows:all` → tray shows **Hosting**, project name.
3. **Mac:** `npm run start:mac:all` → within a few seconds the tray should show **Connected**, your Windows host name, and the same project name.
4. **Mac tray:** click **Resume Workspace** or **Open Project Folder** → macOS may ask once to connect to the Windows share; after that, Finder opens the project (and files if you use Resume Workspace).
5. **Windows tray:** should show **Connected**, Mac Connected: Yes.
6. **Mac:** click **Pause** → Mac tray shows Paused; Windows tray still Hosting (Mac disconnected). **Resume** → they connect again.
7. **Windows:** click **Pause Bridge** → Mac tray goes to Disconnected; **Resume Bridge** on Windows → Mac reconnects.

If something fails: check both machines are on the same LAN, no firewall blocking ports 47831 (WebSocket) or mDNS; on Mac, `bridge.mac.json` can optionally set `windowsHost` to the Windows IP if discovery doesn’t find it.

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
- `BRIDGE_WINDOWS_HOST` (direct websocket fallback host when mDNS is unavailable)
- `BRIDGE_WINDOWS_WS_PORT` (default `47831`)
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

### 5. Full Windows Control (from Mac tray)

After both agents + tray are running:
1. Click `Control Windows (Remote)` in the tray menu.
2. Bridge opens an RDP session to the discovered Windows host.
3. Log in with Windows credentials if prompted.

Remote control metadata can also be configured manually in [bridge.windows.example.json](/Users/maddy/Development/Bridge/bridge.windows.example.json):
- `remoteControlEnabled` (default `true`)
- `remoteProtocol` (`rdp`)
- `remotePort` (default `3389`)
- `remoteUsername` (optional prefill)

Then in tray:
- Click `Run Windows Command` to execute on Windows host.
- Click `Cancel Windows Command` to stop a running command.

The tray status line shows command state (`Idle`, `Running`, `Succeeded`, `Failed`, `Cancelled`).

## Notes

- This MVP intentionally reconstructs state only; it does not migrate running processes.
- File sync is intentionally not implemented; use SMB/native sharing.
- Autostart registration is represented by explicit placeholder hooks in both agents.
