param(
  [switch]$Quick
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
  if (-not (Test-IsAdmin)) { throw 'Run this script as Administrator (right-click → Run as administrator).' }
}

function Assert-ExitCode { param([string]$Step) if ($LASTEXITCODE -ne 0) { throw "$Step failed." } }

function Ensure-Share { param([string]$Share, [string]$RootPath, [string]$Account)
  cmd /c "net share $Share /delete /y >nul 2>&1"
  cmd /c "net share $Share=`"$RootPath`" /grant:$Account,FULL >nul"
  Assert-ExitCode "Creating share $Share"
}

function Enable-FileSharingFirewall {
  & netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes > $null
  Assert-ExitCode 'Enabling firewall for file sharing'
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
  Assert-ExitCode 'Enabling Remote Desktop firewall rules'
}

function Get-FixedDrives {
  Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" | Select-Object -ExpandProperty DeviceID | Sort-Object
}

Write-Host 'Bridge — Windows one-time setup' -ForegroundColor Cyan
Write-Host ''

Assert-Admin

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path

# Auto-detect all fixed drives and share each one. No prompts.
$drives = @(Get-FixedDrives)
if ($drives.Count -eq 0) { throw 'No fixed drives found.' }

Write-Host "Detected drives: $($drives -join ', ')"

$shareEntries = @()

foreach ($drive in $drives) {
  $letter = $drive.Substring(0, 1)
  $shareName = "Bridge_$letter"
  $drivePath = "${drive}\"

  Write-Host "  Sharing $drivePath as $shareName ..."
  try {
    Ensure-Share -Share $shareName -RootPath $drivePath -Account 'Everyone'
    $shareEntries += "$letter`:$shareName"
  } catch {
    Write-Host "  Warning: could not share $drivePath — skipping." -ForegroundColor Yellow
  }
}

if ($shareEntries.Count -eq 0) { throw 'No drives could be shared.' }

Enable-FileSharingFirewall

$rdpEnabled = $false
if (Test-RdpHostSupport) {
  try {
    Enable-RemoteDesktop
    $rdpEnabled = $true
  } catch {
    Write-Host 'Could not enable Remote Desktop (need Pro/Enterprise for full PC access from Mac).' -ForegroundColor Yellow
  }
} else {
  Write-Host 'Windows Home edition: Remote Desktop hosting not available.' -ForegroundColor Yellow
}

# Primary drive = drive where user home lives
$homeDrive = (Split-Path -Qualifier $env:USERPROFILE).Substring(0, 1)
$primaryShare = "Bridge_$homeDrive"
$projectPath = $env:USERPROFILE

$config = @{
  projectPath        = $projectPath
  windowsProjectRoot = "${homeDrive}:\"
  shareName          = $primaryShare
  shares             = ($shareEntries -join ',')
  hostId             = $env:COMPUTERNAME
  hostName           = $env:COMPUTERNAME
  discoveryType      = 'bridgeworkspace'
  remoteControlEnabled = $rdpEnabled
  remoteProtocol     = 'rdp'
  remotePort         = 3389
  remoteUsername      = ''
  allowedCommands    = @('npm', 'pnpm', 'yarn', 'node', 'npx', 'git', 'python', 'pytest', 'dotnet', 'cargo', 'go')
} | ConvertTo-Json -Depth 5

$configPath = Join-Path $repoRoot 'bridge.windows.json'
Set-Content -Path $configPath -Value $config -Encoding UTF8

$ip = $null
try {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress
} catch { }

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host ''
Write-Host "Shared drives: $($shareEntries -join ', ')"
if ($ip) {
  foreach ($entry in $shareEntries) {
    $parts = $entry -split ':'
    Write-Host "  $($parts[0]):\ → smb://$ip/$($parts[1])"
  }
}
if ($rdpEnabled) {
  Write-Host ''
  Write-Host 'Full PC access: use "Access Windows" in the Mac tray (RDP).' -ForegroundColor Green
}
Write-Host ''
Write-Host 'Start Bridge:  npm run start:windows' -ForegroundColor Cyan
Write-Host ''
