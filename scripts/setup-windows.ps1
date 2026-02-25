param(
  [string]$ProjectPath = 'D:\Bridge\Bridge\agent-windows',
  [string]$WindowsProjectRoot = 'D:\Bridge\Bridge',
  [string]$ShareName = 'BridgeShare',
  [string]$HostName = $env:COMPUTERNAME,
  [string]$HostId = $env:COMPUTERNAME,
  [string]$BridgeUser = 'bridgeuser',
  [string]$BridgePassword = 'Bridge@12345',
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

function Write-WindowsConfig {
  param(
    [string]$TargetPath,
    [string]$Project,
    [string]$WindowsRoot,
    [string]$Share,
    [string]$Host,
    [string]$HostIdentifier
  )

  $config = [ordered]@{
    projectPath = $Project
    windowsProjectRoot = $WindowsRoot
    shareName = $Share
    hostId = $HostIdentifier
    hostName = $Host
    discoveryType = 'bridgeworkspace'
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

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')
$configPath = Join-Path $repoRoot 'bridge.windows.json'

Write-WindowsConfig `
  -TargetPath $configPath `
  -Project $ProjectPath `
  -WindowsRoot $WindowsProjectRoot `
  -Share $ShareName `
  -Host $HostName `
  -HostIdentifier $HostId

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

Write-Host ''
Write-Host 'Next start command:' -ForegroundColor Cyan
Write-Host '  npm run start:windows'
