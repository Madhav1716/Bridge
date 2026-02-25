# How to Test Bridge

Follow these steps in order. Each section tells you what to do and what you should see.

---

## Before you start

- **Need:** Node.js 20+, two machines (one Windows, one Mac) on the **same Wi‑Fi/LAN**, or one machine for single-side tests.
- **Build once:**
  ```bash
  cd /path/to/Bridge
  npm install
  npm run build
  ```

---

## Test 1: Mac only (no Windows)

**Steps:**

1. On your Mac, open Terminal and go to the Bridge folder.
2. Run:
   ```bash
   npm run start:mac:all
   ```

**You should get:**

- A **Bridge icon** in the **menu bar** (top right).
- Click the icon → menu shows:
  - **Discovering** or **Disconnected**
  - Host: Not connected
  - Project: No project
  - Last Update: N/A
  - Actions: Resume Workspace, Open Project Folder, Pause, Reconnect, Quit Bridge

**Stop:** Click **Quit Bridge** in the menu.

---

## Test 2: Windows only

**Steps:**

1. On Windows, open PowerShell or Command Prompt and go to the Bridge folder.
2. *(First time only)* Run setup as **Administrator** (right‑click PowerShell → Run as administrator):
   ```powershell
   npm run setup:windows
   ```
   When asked for the folder to share, press **Enter** (use current folder) or type a path like `D:\MyProject`.
3. Start Bridge with tray:
   ```powershell
   npm run start:windows:all
   ```

**You should get:**

- A **Bridge icon** in the **system tray** (bottom right, near the clock).
- Click the icon → menu shows:
  - **Status: Hosting** (green)
  - Project: *(your project folder name)*
  - Mac Connected: No
  - **Pause Bridge** | **Restart Host** | **Open Project Folder** | **Quit Bridge**

**Try:**

- **Pause Bridge** → status changes to **Paused**.
- **Resume Bridge** → status goes back to **Hosting**.
- **Open Project Folder** → Windows Explorer opens your project folder.
- **Restart Host** → Bridge process restarts (tray may close and you can run `npm run start:windows:all` again).
- **Quit Bridge** → tray and agent exit.

**Note:** Windows setup enables Remote Desktop (RDP) when possible so the Mac can access the **entire Windows PC** via the Mac tray’s **Access Windows** (no folder share needed for full access). Windows Home cannot host RDP; use Pro/Enterprise for that.

---

## Test 3: Full flow (Windows + Mac on same LAN)

Do this when both machines are on the same network (e.g. same Wi‑Fi).

### One-time setup

**On Windows (as Administrator):**

```powershell
cd D:\path\to\Bridge
npm run setup:windows
```

- When asked for the folder to share, press Enter or type your project path.
- You should see: “Setup complete” and “Share ready”.

**On Mac:**

```bash
cd /path/to/Bridge
npm run setup:mac
```

- When asked for “Windows PC IP address”, press **Enter** to use auto‑discovery (recommended).  
  If your Mac never finds the PC later, run this again and enter the Windows PC’s IP (e.g. `192.168.1.10`).

### Run both sides

**Step 1 – Start Windows**

On Windows:

```powershell
npm run start:windows:all
```

**You should get:** Tray icon; menu shows **Hosting**, your project name, Mac Connected: No.

---

**Step 2 – Start Mac**

On Mac:

```bash
npm run start:mac:all
```

**You should get (within a few seconds):**

- Tray icon in the menu bar.
- Menu shows:
  - **Connected**
  - Host: *(your Windows PC name)*
  - Project: *(same project name as on Windows)*
  - Last Update: *(time)*

**On Windows tray you should get:** Mac Connected: **Yes (1)** and status **Connected**.

---

**Step 3 – Access entire Windows (Mac) — no folder share needed**

On the **Mac** tray menu, click **Access Windows**.

**You should get:** A Remote Desktop session opens (Windows App or Microsoft Remote Desktop). You see the **full Windows desktop** and can use the whole PC from your Mac. Log in with your Windows user if prompted. No folder sharing required.

*(Requires Windows Pro/Enterprise for RDP hosting. If you see an error, your Windows edition may not support it.)*

---

**Step 4 – Resume Workspace / Open Project (Mac) — optional**

If you also use a shared folder:

- **Open Project Folder**  
  **You should get:** macOS may ask once to connect to the Windows share (SMB). After you approve, **Finder** opens the shared project folder.
- Or click **Resume Workspace**  
  **You should get:** Same SMB prompt if first time, then Finder opens the project folder and can open recent files.

---

**Step 5 – Pause / Resume (Mac)**

On the **Mac** tray:

- Click **Pause**.  
  **You should get:** Status changes to **Paused**; on Windows tray, Mac Connected goes back to **No**.
- Click **Resume**.  
  **You should get:** Status goes back to **Connected**; Windows tray shows Mac Connected: Yes again.

---

**Step 6 – Pause / Resume (Windows)**

On the **Windows** tray:

- Click **Pause Bridge**.  
  **You should get:** Windows status → **Paused**; on the **Mac** tray, status goes to **Disconnected** (or Reconnecting).
- On Windows, click **Resume Bridge**.  
  **You should get:** Windows → **Hosting**; Mac reconnects and shows **Connected** again.

---

## Quick reference: what you get

| Where        | What you get |
|-------------|----------------|
| **Mac tray** | Status (Discovering / Connected / Paused / Disconnected), Host name, Project name, Last update. Actions: Resume Workspace, Open Project Folder, **Access Windows** (full PC via RDP), Pause/Resume, Reconnect, Quit. |
| **Windows tray** | Status (Hosting / Connected / Paused), Project name, Mac Connected (Yes/No). Actions: Pause/Resume Bridge, Restart Host, Open Project Folder, Quit. |
| **Same icons** | Green = Connected/Hosting, Yellow = Reconnecting, Pause = Paused, Red = Disconnected. |

---

## If something doesn’t work

- **Mac never shows “Connected”**  
  - Same Wi‑Fi/LAN as Windows.  
  - Firewall on Windows allows port **47831** and mDNS.  
  - If mDNS is blocked, run `npm run setup:mac` again and enter the Windows PC’s IP (find it with `ipconfig` on Windows).

- **“Open Project Folder” or “Resume Workspace” doesn’t open the folder**  
  - Approve the macOS SMB connection prompt.  
  - On Windows, ensure the shared folder path from setup is correct and the share is still there.

- **Build errors**  
  - Run `npm install` and `npm run build` again from the Bridge root folder.
