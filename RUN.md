# Bridge — Run in 5 Minutes

## Step 1: Windows (do this first)

1. Open **PowerShell as Administrator** (right-click → Run as administrator).
2. Go to the Bridge folder:
   ```powershell
   cd D:\Bridge\Bridge
   ```
   (Or wherever your Bridge repo is.)
3. Run setup (opens firewall so Mac can connect):
   ```powershell
   npm run setup:windows
   ```
4. Start Bridge:
   ```powershell
   npm run start:windows:all
   ```
5. Leave it running. You should see "Hosting Workspace" in the tray.

---

## Step 2: Mac

1. Open Terminal. Go to Bridge:
   ```bash
   cd /path/to/Bridge
   ```
2. If you haven’t run setup yet:
   ```bash
   npm run setup:mac
   ```
   No prompts — Bridge discovers your Windows PC on the same WiFi automatically.
3. Start Bridge:
   ```bash
   npm run start:mac:all
   ```
4. Wait a few seconds. The Mac should discover Windows and connect. The tray should show **Connected** and the Windows tray should show your Mac under "Devices on this WiFi" and "Connected Device: [Your Mac name]".

---

## If "No devices found" on Windows

- On **Windows**: Run `npm run setup:windows` **as Administrator** again (this opens the firewall).
- Make sure **Mac and Windows are on the same WiFi**.

---

## Quick test

- **Mac tray** → "Resume Workspace" or "Open Project Folder" → macOS may ask once to connect to the Windows share → Approve → Finder opens the project.
- **Windows tray** → "Open Project Folder" → opens the project folder on Windows.

You’re done when the Mac tray shows **Connected** and the Windows tray shows your Mac as the connected device.
