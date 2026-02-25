param(
  [string]$ProjectPath = 'D:\Bridge\Bridge\agent-windows',
  [string]$WindowsProjectRoot = 'D:\Bridge\Bridge',
  [string]$ShareName = 'BridgeShare',
  [string]$HostName = $env:COMPUTERNAME,
  [string]$HostId = $env:COMPUTERNAME,
  [string]$BridgeUser = 'bridgeuser',
  [string]$BridgePassword = 'Bridge@12345',
  [bool]$EnableRemoteDesktop = $true,
  [int]$RemotePort = 3389,
  [string]$RemoteProtocol = 'rdp',
  [string]$RemoteUsername = '',
  [switch]$UseEveryone,
  [switch]$NoPrompt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-WithDefault {
  param(
    [string]$Prompt,
    [string]$DefaultValue
  )

  $inputValue = Read-Host "$Prompt [$DefaultValue]"
  if ([string]::IsNullOrWhiteSpace($inputValue)) {
    return $DefaultValue
  }

  return $inputValue.Trim()
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    throw 'Run setup-windows.ps1 as Administrator.'
  }
}

function Assert-ExitCode {
  param([string]$Step)

  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

function Ensure-LocalUser {
  param(
    [string]$UserName,
    [string]$Password
  )

  cmd /c "net user $UserName >nul 2>&1"
  if ($LASTEXITCODE -eq 0) {
    cmd /c "net user $UserName $Password >nul"
    Assert-ExitCode "Updating local user password for $UserName"
    return
  }

  cmd /c "net user $UserName $Password /add >nul"
  Assert-ExitCode "Creating local user $UserName"
}

function Ensure-Share {
  param(
    [string]$Share,
    [string]$RootPath,
    [string]$Account
  )

  cmd /c "net share $Share /delete /y >nul 2>&1"
  cmd /c "net share $Share=`"$RootPath`" /grant:$Account,CHANGE >nul"
  Assert-ExitCode "Creating SMB share $Share"
}

function Ensure-NtfsAccess {
  param(
    [string]$RootPath,
    [string]$Account
  )

  & icacls $RootPath /grant "$Account:(OI)(CI)M" /T /C > $null
  Assert-ExitCode "Setting NTFS permissions for $Account"
}

function Enable-FileSharingFirewall {
  & netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes > $null
  Assert-ExitCode 'Enabling File and Printer Sharing firewall rules'
}

function Enable-RemoteDesktopAccess {
  Set-ItemProperty `
    -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
    -Name 'fDenyTSConnections' `
    -Value 0

  & netsh advfirewall firewall set rule group="Remote Desktop" new enable=Yes > $null
  Assert-ExitCode 'Enabling Remote Desktop firewall rules'
}

function Ensure-RemoteDesktopUser {
  param(
    [string]$Account
  )

  if ([string]::IsNullOrWhiteSpace($Account)) {
    return
  }

  try {
    Add-LocalGroupMember -Group 'Remote Desktop Users' -Member $Account -ErrorAction Stop
    return
  } catch {
    if ($_.Exception.Message -match 'already') {
      return
    }
  }

  cmd /c "net localgroup `"Remote Desktop Users`" `"$Account`" /add >nul 2>&1"
}

function Write-WindowsConfig {
  param(
    [string]$TargetPath,
    [string]$Project,
    [string]$WindowsRoot,
    [string]$Share,
    [string]$Host,
    [string]$HostIdentifier,
    [bool]$RemoteControlEnabled,
    [string]$RemoteControlProtocol,
    [int]$RemoteControlPort,
    [string]$RemoteControlUsername
  )

  $config = [ordered]@{
    projectPath = $Project
    windowsProjectRoot = $WindowsRoot
    shareName = $Share
    hostId = $HostIdentifier
    hostName = $Host
    discoveryType = 'bridgeworkspace'
    remoteControlEnabled = $RemoteControlEnabled
    remoteProtocol = $RemoteControlProtocol
    remotePort = $RemoteControlPort
    remoteUsername = $RemoteControlUsername
    allowedCommands = @('npm', 'pnpm', 'yarn', 'node', 'npx', 'git', 'python', 'pytest', 'dotnet', 'cargo', 'go')
  }

  $json = $config | ConvertTo-Json -Depth 5
  Set-Content -Path $TargetPath -Value $json -Encoding UTF8
}

function Try-GetIPv4 {
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object {
        $_.IPAddress -notlike '169.254*' -and
        $_.IPAddress -ne '127.0.0.1' -and
        $_.PrefixOrigin -ne 'WellKnown'
      } |
      Select-Object -First 1 -ExpandProperty IPAddress

    return $ip
  } catch {
    return $null
  }
}

function Test-RdpHostSupport {
  try {
    $edition = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID
    if ($edition -like 'Core*') {
      return $false
    }

    return $true
  } catch {
    return $true
  }
}

Write-Host 'Bridge Windows one-time setup' -ForegroundColor Cyan

if (-not $NoPrompt) {
  $WindowsProjectRoot = Read-WithDefault 'Windows shared project root' $WindowsProjectRoot
  $ProjectPath = Read-WithDefault 'Bridge active project path' $ProjectPath
  $ShareName = Read-WithDefault 'SMB share name' $ShareName
  $HostName = Read-WithDefault 'Host display name' $HostName
  $HostId = Read-WithDefault 'Host identifier' $HostId

  $permissionMode = Read-WithDefault 'Permission mode (user/everyone)' 'everyone'
  if ($permissionMode.ToLowerInvariant() -eq 'everyone') {
    $UseEveryone = $true
  } else {
    $UseEveryone = $false
    $BridgeUser = Read-WithDefault 'Bridge local user' $BridgeUser
    $BridgePassword = Read-WithDefault 'Bridge local user password' $BridgePassword
  }
}

Assert-Admin

if (-not (Test-Path -Path $WindowsProjectRoot)) {
  throw "Shared root does not exist: $WindowsProjectRoot"
}

if (-not (Test-Path -Path $ProjectPath)) {
  throw "Project path does not exist: $ProjectPath"
}

if ($EnableRemoteDesktop -and -not (Test-RdpHostSupport)) {
  throw 'This Windows edition does not support hosting Remote Desktop (RDP). Use Windows Pro/Enterprise for full remote control.'
}

$shareAccount = 'Everyone'
$ntfsAccount = 'Everyone'

if (-not $UseEveryone) {
  Ensure-LocalUser -UserName $BridgeUser -Password $BridgePassword
  $shareAccount = $BridgeUser
  $ntfsAccount = "$env:COMPUTERNAME\$BridgeUser"
}

Ensure-Share -Share $ShareName -RootPath $WindowsProjectRoot -Account $shareAccount
Ensure-NtfsAccess -RootPath $WindowsProjectRoot -Account $ntfsAccount
Enable-FileSharingFirewall

if ([string]::IsNullOrWhiteSpace($RemoteUsername)) {
  if (-not $UseEveryone) {
    $RemoteUsername = "$env:COMPUTERNAME\$BridgeUser"
  } else {
    $RemoteUsername = "$env:COMPUTERNAME\$env:USERNAME"
  }
}

if ($EnableRemoteDesktop) {
  Enable-RemoteDesktopAccess
  if (-not $UseEveryone) {
    Ensure-RemoteDesktopUser -Account $BridgeUser
  } else {
    Ensure-RemoteDesktopUser -Account $env:USERNAME
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
$configPath = Join-Path $repoRoot 'bridge.windows.json'

Write-WindowsConfig `
  -TargetPath $configPath `
  -Project $ProjectPath `
  -WindowsRoot $WindowsProjectRoot `
  -Share $ShareName `
  -Host $HostName `
  -HostIdentifier $HostId `
  -RemoteControlEnabled $EnableRemoteDesktop `
  -RemoteControlProtocol $RemoteProtocol `
  -RemoteControlPort $RemotePort `
  -RemoteControlUsername $RemoteUsername

$ipAddress = Try-GetIPv4

Write-Host ''
Write-Host "Wrote $configPath" -ForegroundColor Green
Write-Host "Share ready: \\$env:COMPUTERNAME\$ShareName" -ForegroundColor Green
if ($ipAddress) {
  Write-Host "Use from Mac: smb://$ipAddress/$ShareName" -ForegroundColor Green
} else {
  Write-Host "Use from Mac: smb://$env:COMPUTERNAME/$ShareName" -ForegroundColor Yellow
}

if (-not $UseEveryone) {
  Write-Host "SMB user: $env:COMPUTERNAME\$BridgeUser" -ForegroundColor Green
  Write-Host "SMB password: $BridgePassword" -ForegroundColor Green
}

if ($EnableRemoteDesktop) {
  if ($ipAddress) {
    Write-Host "Remote control target: $ipAddress`:$RemotePort (RDP)" -ForegroundColor Green
  } else {
    Write-Host "Remote control target: $env:COMPUTERNAME`:$RemotePort (RDP)" -ForegroundColor Green
  }
  Write-Host "Remote login user: $RemoteUsername" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Next start command:' -ForegroundColor Cyan
Write-Host '  npm run start:windows'
