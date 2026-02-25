# Bridge Test Runbook

This file is a quick, repeatable guide to test Bridge end-to-end.

## 1) One-time setup

### Mac: install and build
```bash
cd /Users/maddy/Development/Bridge
npm install
npm run build
```

### Windows: shared folder requirements
1. Share the project root folder (example: `D:\Bridge\Bridge`) as `BridgeShare`.
2. Ensure Mac can open `smb://<WINDOWS_IP>/BridgeShare`.
3. Ensure Windows firewall allows File and Printer Sharing.

## 2) Quick sync from Mac -> Windows (repeatable)

Use this on Mac to copy latest code to Windows mounted share:

```bash
rsync -av --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  /Users/maddy/Development/Bridge/ \
  /Volumes/BridgeShare/Bridge/
```

Optional alias:
```bash
alias syncbridge="rsync -av --delete --exclude '.git' --exclude 'node_modules' --exclude 'dist' /Users/maddy/Development/Bridge/ /Volumes/BridgeShare/Bridge/"
```

Then run:
```bash
syncbridge
```

## 3) Start Windows agent

Run on Windows in project copy:

```bat
cd D:\Bridge\Bridge
set BRIDGE_PROJECT_PATH=D:\Bridge\Bridge\agent-windows
set BRIDGE_WINDOWS_PROJECT_ROOT=D:\Bridge\Bridge
set BRIDGE_SHARE_NAME=BridgeShare
set BRIDGE_HOST_ID=ASUS
set BRIDGE_HOST_NAME=Asus
set BRIDGE_DISCOVERY_TYPE=bridgeworkspace
set BRIDGE_ALLOWED_COMMANDS=npm,pnpm,yarn,node,npx,git,python,pytest,dotnet,cargo,go
set BRIDGE_COMMAND_TIMEOUT_MS=900000
npm run start:windows
```

## 4) Start Mac agent

Run on Mac:

```bash
cd /Users/maddy/Development/Bridge
export BRIDGE_DISCOVERY_TYPE=bridgeworkspace
export BRIDGE_WINDOWS_COMMAND='npm -v'
export BRIDGE_WINDOWS_COMMAND_CWD='D:\\Bridge\\Bridge\\agent-windows'
npm run start:mac
```

If auto-mapping is not available, set manual mapping:
```bash
export BRIDGE_WINDOWS_PROJECT_ROOT='D:\\Bridge\\Bridge'
export BRIDGE_SMB_ROOT='smb://<WINDOWS_IP>/BridgeShare'
export BRIDGE_SMB_MOUNT_ROOT='/Volumes/BridgeShare'
```

## 5) Start tray UI (Mac)

```bash
cd /Users/maddy/Development/Bridge
npm run start:tray
```

## 6) Test checklist (pass/fail)

### A) Connection lifecycle
1. Tray reaches `🟢 Connected`.
2. Host + project are shown.

### B) Workspace continuity
1. Click `Open Project Folder` -> shared folder opens on Mac.
2. Click `Resume Workspace` -> folder + recent files open.

### C) Heartbeat/reconnect
1. Stop Windows agent.
2. Tray shows reconnect/discovering state.
3. Start Windows agent again.
4. Tray returns to `🟢 Connected`.

### D) Windows command execution from Mac
1. Click `Run Windows Command`.
2. Command state changes to `Running`, then `Succeeded` (or `Failed` with exit).
3. Click `Cancel Windows Command` during a long command and confirm `Cancelled`.

## 7) Fast retest loop

1. Edit code on Mac.
2. `syncbridge` (or rsync command).
3. Restart Windows + Mac agents.
4. Re-run tray checks from section 6.

## 8) Troubleshooting

### SMB login keeps failing
1. Use Windows account credentials (not Mac password, not Windows PIN).
2. Try username format: `ASUS\\username`.
3. Use IP-based SMB URL: `smb://<WINDOWS_IP>/BridgeShare`.

### Stuck in Discovering
1. Confirm both devices are on same LAN.
2. Confirm both use `BRIDGE_DISCOVERY_TYPE=bridgeworkspace`.
3. Confirm Windows agent is running and firewall allows Node/File sharing.

### Resume says mapping required
Set either:
1. Windows share metadata (`BRIDGE_SHARE_NAME` + `BRIDGE_WINDOWS_PROJECT_ROOT`) on host, or
2. Manual Mac mapping (`BRIDGE_WINDOWS_PROJECT_ROOT` + `BRIDGE_SMB_ROOT`).
