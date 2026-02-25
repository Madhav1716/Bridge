# Start Windows agent in background, then run tray (foreground).
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
Set-Location $repoRoot

$agentJob = Start-Job -ScriptBlock {
  Set-Location $using:repoRoot
  npm run start:windows 2>&1
}

try {
  npm run start:tray
} finally {
  Stop-Job $agentJob -ErrorAction SilentlyContinue
  Remove-Job $agentJob -Force -ErrorAction SilentlyContinue
}
