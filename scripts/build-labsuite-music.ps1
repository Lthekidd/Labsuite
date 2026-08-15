[CmdletBinding()]
param(
  [string]$SourcePath = "",
  [string]$ExpectedCommit = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$labSuiteRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
if (-not $SourcePath) {
  $SourcePath = Join-Path (Split-Path $labSuiteRoot -Parent) "LabSuiteMusic"
}
$sourceRoot = [System.IO.Path]::GetFullPath($SourcePath)
$sourcePackage = Join-Path $sourceRoot "package.json"
if (-not (Test-Path -LiteralPath $sourcePackage -PathType Leaf)) {
  throw "LabSuite Music source was not found at $sourceRoot"
}

$package = Get-Content -LiteralPath $sourcePackage -Raw | ConvertFrom-Json
if ($package.name -ne "labsuite-music" -or $package.license -ne "GPL-3.0-only") {
  throw "The selected source is not the LabSuite Music GPL companion."
}

$sourceCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[a-f0-9]{40}$') {
  throw "Could not resolve the LabSuite Music source commit."
}
if ($ExpectedCommit -and $sourceCommit -ne $ExpectedCommit.ToLowerInvariant()) {
  throw "LabSuite Music source commit $sourceCommit does not match pinned commit $ExpectedCommit."
}

if (-not $SkipBuild) {
  Push-Location $sourceRoot
  try {
    # Corepack selects packageManager from the current directory. Enter the
    # fork first so CI uses its pinned Yarn 4 release rather than Yarn Classic.
    & corepack yarn install --immutable
    if ($LASTEXITCODE -ne 0) { throw "LabSuite Music dependency installation failed." }
    & corepack yarn verify:security
    if ($LASTEXITCODE -ne 0) { throw "LabSuite Music security verification failed." }
    & corepack yarn lint
    if ($LASTEXITCODE -ne 0) { throw "LabSuite Music lint failed." }
    & corepack yarn package --platform win32 --arch x64
    if ($LASTEXITCODE -ne 0) { throw "LabSuite Music packaging failed." }
  } finally {
    Pop-Location
  }
}

$packageRoot = Join-Path $sourceRoot "out\LabSuite Music-win32-x64"
$sourceExecutable = Join-Path $packageRoot "labsuite-music.exe"
if (-not (Test-Path -LiteralPath $sourceExecutable -PathType Leaf)) {
  throw "The packaged LabSuite Music executable was not found at $sourceExecutable"
}

$binRoot = [System.IO.Path]::GetFullPath((Join-Path $labSuiteRoot "bin"))
$destination = [System.IO.Path]::GetFullPath((Join-Path $binRoot "LabSuiteMusic"))
if (-not $destination.StartsWith($binRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to replace a destination outside LabSuite's bin directory."
}

if (Test-Path -LiteralPath $destination) {
  Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -Path (Join-Path $packageRoot "*") -Destination $destination -Recurse -Force

# Ship the exact corresponding GPL source used for this binary. `git ls-files`
# includes modified tracked files and new, non-ignored files while excluding
# node_modules, build output, and repository metadata.
$sourceDestination = Join-Path $destination "source"
New-Item -ItemType Directory -Path $sourceDestination -Force | Out-Null
$sourceFiles = & git -C $sourceRoot ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0 -or -not $sourceFiles) { throw "Could not enumerate LabSuite Music corresponding source." }
foreach ($relativeFile in $sourceFiles) {
  $sourceFile = Join-Path $sourceRoot $relativeFile
  if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { continue }
  $targetFile = Join-Path $sourceDestination $relativeFile
  $targetDirectory = Split-Path $targetFile -Parent
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
}

$manifest = [ordered]@{
  product = "LabSuite Music"
  version = $package.version
  securityProfile = "labsuite-hardened-v1"
  sourceCommit = $sourceCommit
  correspondingSource = "source"
  executableSha256 = (Get-FileHash -LiteralPath (Join-Path $destination "labsuite-music.exe") -Algorithm SHA256).Hash
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination "labsuite-music.manifest.json") -Encoding UTF8

Write-Output "LabSuite Music staged at $destination"
Write-Output "SHA256 $($manifest.executableSha256)"
