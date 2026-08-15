[CmdletBinding()]
param(
  [string]$ExecutablePath = "",
  [switch]$CleanupOnly
)

$ErrorActionPreference = "Stop"
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

function Remove-LabSuiteMusicTestProfile([string]$ProfilePath) {
  $resolved = [System.IO.Path]::GetFullPath($ProfilePath)
  $name = Split-Path $resolved -Leaf
  if (
    -not $resolved.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $name -notmatch '^labsuite-music-runtime-[a-f0-9]{32}$'
  ) {
    throw "Refusing to remove an unexpected runtime-test profile path."
  }
  if (Test-Path -LiteralPath $resolved) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}

if ($CleanupOnly) {
  Get-ChildItem -LiteralPath $tempRoot -Directory -Filter "labsuite-music-runtime-*" | ForEach-Object {
    Remove-LabSuiteMusicTestProfile $_.FullName
  }
  Write-Output "Removed YTmusic temporary runtime-test profiles."
  exit 0
}

$labSuiteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $ExecutablePath) {
  $ExecutablePath = Join-Path $labSuiteRoot "bin\LabSuiteMusic\labsuite-music.exe"
}
$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
  throw "YTmusic executable not found at $executable"
}

$testProfile = Join-Path $tempRoot ("labsuite-music-runtime-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testProfile -Force | Out-Null
$process = Start-Process -FilePath $executable -ArgumentList "--user-data-dir=$testProfile" -PassThru -WindowStyle Hidden

try {
  $metadata = $null
  for ($attempt = 0; $attempt -lt 60 -and -not $metadata; $attempt++) {
    try {
      $metadata = Invoke-RestMethod -Uri "http://127.0.0.1:9863/metadata" -TimeoutSec 1
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $metadata) { throw "YTmusic did not start within 15 seconds." }
  if ($metadata.product -ne "YTmusic" -or $metadata.securityProfile -ne "labsuite-hardened-v1" -or $metadata.transport -ne "loopback-only") {
    throw "The companion returned an unexpected security profile."
  }
  Write-Output ("METADATA " + ($metadata | ConvertTo-Json -Compress))

  $listeners = Get-NetTCPConnection -LocalPort 9863 -State Listen -ErrorAction Stop
  $listeners | Select-Object LocalAddress, LocalPort, State, OwningProcess
  if ($listeners.LocalAddress | Where-Object { $_ -ne "127.0.0.1" }) {
    throw "Companion exposed a non-loopback listener."
  }

  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9863/metadata" -Headers @{ Origin = "https://evil.example" } -TimeoutSec 3 | Out-Null
    throw "Browser Origin request unexpectedly succeeded."
  } catch {
    $originStatus = [int]$_.Exception.Response.StatusCode
    Write-Output "ORIGIN_STATUS $originStatus"
    if ($originStatus -ne 403) { throw }
  }

  try {
    Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9863/api/v1/state" -TimeoutSec 3 | Out-Null
    throw "Unauthenticated state request unexpectedly succeeded."
  } catch {
    $authStatus = [int]$_.Exception.Response.StatusCode
    Write-Output "UNAUTHENTICATED_STATUS $authStatus"
    if ($authStatus -ne 401) { throw }
  }
} finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 750
  Remove-LabSuiteMusicTestProfile $testProfile
}

Write-Output "YTmusic runtime security checks passed."
