param(
  [string]$ProjectPath = '',
  [string]$ShareName = 'BridgeShare',
  [switch]$Quick
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-WithDefault {
  param([string]$Prompt, [string]$DefaultValue)
  $inputValue = Read-Host "$Prompt [$DefaultValue]"
  if ([string]::IsNullOrWhiteSpace($inputValue)) { return $DefaultValue }
  return $inputValue.Trim()
}

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
  if (-not (Test-IsAdmin)) { throw 'Run this script as Administrator (right-click, Run as administrator).' }
}

function Assert-ExitCode { param([string]$Step) if ($LASTEXITCODE -ne 0) { throw "$Step failed." } }

function Ensure-Share { param([string]$Share, [string]$RootPath, [string]$Account)
  cmd /c "net share $Share /delete /y >nul 2>&1"
  cmd /c "net share $Share=`"$RootPath`" /grant:$Account,CHANGE >nul"
  Assert-ExitCode "Creating share $Share"
}

function Ensure-NtfsAccess { param([string]$RootPath, [string]$Account)
  & icacls $RootPath /grant "${Account}:(OI)(CI)M" /T /C > $null
  Assert-ExitCode "Setting permissions"
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

function Write-WindowsConfig { param([string]$TargetPath, [string]$Project, [string]$WindowsRoot, [string]$Share, [string]$HostName, [string]$HostId, [bool]$RemoteControlEnabled)
  $config = @{
    projectPath = $Project
    windowsProjectRoot = $WindowsRoot
    shareName = $Share
    hostId = $HostId
    hostName = $HostName
    discoveryType = 'bridgeworkspace'
    remoteControlEnabled = $RemoteControlEnabled
    remoteProtocol = 'rdp'
    remotePort = 3389
    remoteUsername = ''
    allowedCommands = @('npm', 'pnpm', 'yarn', 'node', 'npx', 'git', 'python', 'pytest', 'dotnet', 'cargo', 'go')
  } | ConvertTo-Json -Depth 5
  Set-Content -Path $TargetPath -Value $config -Encoding UTF8
}

Write-Host 'Bridge — Windows one-time setup' -ForegroundColor Cyan
Write-Host ''

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path

# One question: which folder to share. Default = current directory (or repo root when run from repo).
$defaultPath = $repoRoot
if ($Quick -or [string]::IsNullOrWhiteSpace($ProjectPath)) {
  if ($Quick) {
    $ProjectPath = $defaultPath
  } else {
    Write-Host 'Which folder should Bridge share with your Mac?'
    Write-Host '(This is usually your project or code folder.)'
    Write-Host ''
    $ProjectPath = Read-WithDefault 'Folder path' $defaultPath
  }
}

$ProjectPath = $ProjectPath.Trim().TrimEnd('\')
$WindowsProjectRoot = $ProjectPath
Assert-Admin

if (-not (Test-Path -LiteralPath $ProjectPath)) {
  throw "Folder does not exist: $ProjectPath"
}

Ensure-Share -Share $ShareName -RootPath $WindowsProjectRoot -Account 'Everyone'
Ensure-NtfsAccess -RootPath $WindowsProjectRoot -Account 'Everyone'
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
  Write-Host 'Windows Home edition: Remote Desktop hosting not available. Use folder share for file access.' -ForegroundColor Yellow
}

$configPath = Join-Path $repoRoot 'bridge.windows.json'
Write-WindowsConfig `
  -TargetPath $configPath `
  -Project $ProjectPath `
  -WindowsRoot $WindowsProjectRoot `
  -Share $ShareName `
  -HostName $env:COMPUTERNAME `
  -HostIdentifier $env:COMPUTERNAME `
  -RemoteControlEnabled $rdpEnabled

$ip = $null
try {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -First 1).IPAddress
} catch { }

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host ''
Write-Host "Shared folder: \\$env:COMPUTERNAME\$ShareName"
if ($ip) { Write-Host "From Mac: smb://$ip/$ShareName" }
if ($rdpEnabled) {
  Write-Host ''
  Write-Host 'Full PC access: From Mac tray, use "Access Windows" to open the full Windows desktop (RDP).' -ForegroundColor Green
  if ($ip) { Write-Host "RDP: ${ip}:3389" }
}
Write-Host ''
Write-Host 'Start Bridge:  npm run start:windows' -ForegroundColor Cyan
Write-Host ''
