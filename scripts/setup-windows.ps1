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

Write-Host "Bridge Windows setup" -ForegroundColor Cyan
Write-Host ""

Assert-Admin

$drives = @(Get-FixedDrives)

if ($drives.Count -eq 0) {
  throw "No fixed drives found."
}

Write-Host ("Detected drives: " + ($drives -join ", "))

$shares = @()

foreach ($d in $drives) {

  $letter = $d.Substring(0,1)
  $shareName = "Bridge_" + $letter
  $drivePath = $d + "\"

  Write-Host ("Sharing " + $drivePath + " as " + $shareName)

  try {
    Ensure-Share -Name $shareName -Path $drivePath
    $shares += ($letter + ":" + $shareName)
  }
  catch {
    Write-Host ("Failed to share " + $drivePath) -ForegroundColor Yellow
  }
}

if ($shares.Count -eq 0) {
  throw "No drives were shared."
}

netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes > $null

$config = @{
  shares = ($shares -join ",")
  host   = $env:COMPUTERNAME
} | ConvertTo-Json

$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) "bridge.windows.json"
Set-Content -Path $configPath -Value $config -Encoding UTF8

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ("Shared drives: " + ($shares -join ", "))
Write-Host ""
Write-Host "Start Bridge: npm run start:windows" -ForegroundColor Cyan
Write-Host ""
