param([switch]$Quick)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = [Security.Principal.WindowsPrincipal]::new($id)
  $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
  if (-not (Test-IsAdmin)) {
    throw "Run PowerShell as Administrator."
  }
}

function Ensure-Share {
  param(
    [string]$Name,
    [string]$Path
  )

  cmd /c "net share $Name /delete /y >nul 2>&1"
  cmd /c "net share $Name=$Path /grant:Everyone,FULL >nul"
}

function Get-FixedDrives {
  Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" |
    Select-Object -ExpandProperty DeviceID |
    Sort-Object
}

function Test-RdpHostSupport {
  try {
    $edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue).EditionID
    if ($edition -like 'Core*' -or $edition -eq 'Core') { return $false }
    return $true
  } catch { return $true }
}

function Enable-RemoteDesktop {
  Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 0 -Force -ErrorAction Stop
  & netsh advfirewall firewall set rule group="Remote Desktop" new enable=Yes > $null
}

Write-Host "Bridge — Windows one-time setup" -ForegroundColor Cyan
Write-Host ""

Assert-Admin

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir ".." )).Path

# --- Detect and share all fixed drives (no prompts) ---
$drives = @(Get-FixedDrives)

if ($drives.Count -eq 0) {
  throw "No fixed drives found."
}

Write-Host ("Detected drives: " + ($drives -join ", "))

$shareEntries = @()

foreach ($d in $drives) {
  $letter = $d.Substring(0,1)
  $shareName = "Bridge_$letter"
  $drivePath = "$d\"

  Write-Host "  Sharing $drivePath as $shareName ..."

  try {
    Ensure-Share -Name $shareName -Path $drivePath
    $shareEntries += "${letter}:${shareName}"
  }
  catch {
    Write-Host "  Warning: could not share $drivePath — skipping." -ForegroundColor Yellow
  }
}

if ($shareEntries.Count -eq 0) {
  throw "No drives could be shared."
}

# --- Firewall: file sharing ---
Write-Host "  Enabling file sharing firewall rules ..."
netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes > $null

# --- Firewall: mDNS (UDP 5353) so Mac can discover this PC ---
Write-Host "  Enabling mDNS firewall rule (UDP 5353) ..."
netsh advfirewall firewall delete rule name="Bridge mDNS" > $null 2>&1
netsh advfirewall firewall add rule name="Bridge mDNS" dir=in action=allow protocol=UDP localport=5353 > $null

# --- Firewall: Bridge WebSocket (TCP 47831) ---
Write-Host "  Enabling Bridge WebSocket firewall rule (TCP 47831) ..."
netsh advfirewall firewall delete rule name="Bridge WebSocket" > $null 2>&1
netsh advfirewall firewall add rule name="Bridge WebSocket" dir=in action=allow protocol=TCP localport=47831 > $null

# --- RDP ---
$rdpEnabled = $false
if (Test-RdpHostSupport) {
  try {
    Enable-RemoteDesktop
    $rdpEnabled = $true
    Write-Host "  Remote Desktop enabled." -ForegroundColor Green
  } catch {
    Write-Host "  Could not enable Remote Desktop (need Pro/Enterprise)." -ForegroundColor Yellow
  }
} else {
  Write-Host "  Windows Home: Remote Desktop hosting not available." -ForegroundColor Yellow
}

# --- Primary share = drive where user home lives ---
$homeDrive = (Split-Path -Qualifier $env:USERPROFILE).Substring(0,1)
$primaryShare = "Bridge_$homeDrive"
$projectPath = $env:USERPROFILE

# --- Write config ---
$config = @{
  projectPath          = $projectPath
  windowsProjectRoot   = "${homeDrive}:\"
  shareName            = $primaryShare
  shares               = ($shareEntries -join ",")
  hostId               = $env:COMPUTERNAME
  hostName             = $env:COMPUTERNAME
  discoveryType        = "bridgeworkspace"
  remoteControlEnabled = $rdpEnabled
  remoteProtocol       = "rdp"
  remotePort           = 3389
  remoteUsername        = ""
  allowedCommands      = @("npm","pnpm","yarn","node","npx","git","python","pytest","dotnet","cargo","go")
} | ConvertTo-Json -Depth 5

$configPath = Join-Path $repoRoot "bridge.windows.json"
Set-Content -Path $configPath -Value $config -Encoding UTF8

# --- Summary ---
$ip = $null
try {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -First 1).IPAddress
} catch { }

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Shared drives: $($shareEntries -join ', ')"
if ($ip) {
  foreach ($entry in $shareEntries) {
    $parts = $entry -split ":"
    Write-Host "  $($parts[0]):\ -> smb://$ip/$($parts[1])"
  }
}
if ($rdpEnabled) {
  Write-Host ""
  Write-Host "Full PC access: use 'Access Windows' in the Mac tray (RDP)." -ForegroundColor Green
}
Write-Host ""
Write-Host "Next: npm run start:windows" -ForegroundColor Cyan
Write-Host "  Or: npm run start:windows:all  (agent + tray)" -ForegroundColor Cyan
Write-Host ""
