$ErrorActionPreference = 'SilentlyContinue'
$projectRoot = $PSScriptRoot
$appPath = Join-Path $projectRoot 'app.py'

& py -3 $appPath --stop 2>$null | Out-Null
Start-Process -FilePath 'pyw.exe' -ArgumentList '-3', $appPath -WorkingDirectory $projectRoot -WindowStyle Hidden

$health = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 150
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/api/health' -TimeoutSec 1
    if ($health.ok) { break }
  } catch {}
}

$version = if ($null -ne $health.version) { [string]$health.version } else { 'latest' }
$launchId = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$url = "http://127.0.0.1:8765/?v=$version&launch=$launchId"
Start-Process $url
