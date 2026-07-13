const POWER_SHELL_V2_TEMPLATE = String.raw`# LabSuite VM Protect v2 portable agent
# This agent keeps file state inside the VM and sends encrypted-in-transit batches to the
# LabSuite host. It never receives cloud credentials, vault passwords, or encryption keys.
[CmdletBinding()]
param(
  [string[]]$Paths,
  [string[]]$Exclude,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Pair,
  [switch]$RunAgent,
  [switch]$Diagnostics,
  [switch]$Repair,
  [switch]$Status,
  [switch]$UploadLarge,
  [string]$BatchId,
  [string]$EntryBase64,
  [int64]$StartOffset,
  [switch]$NoPicker,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$StateDir = Join-Path $env:LOCALAPPDATA 'LabSuiteVMProtect'
$StatePath = Join-Path $StateDir 'state-v2.json'
$RunLogPath = Join-Path $StateDir 'agent.log'
$DiagnosticPath = Join-Path $StateDir 'diagnostic.txt'
$InstalledScript = Join-Path $StateDir 'LabSuite-VM-Protect-Agent.ps1'
$script:PauseBeforeExit = -not $NoPause -and -not $RunAgent
$script:RequestedPaths = @($Paths)
$script:Bootstrap = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__LABSUITE_V2_BOOTSTRAP_BASE64__')) | ConvertFrom-Json
$script:EmptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security

function Write-RunLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    Add-Content -LiteralPath $RunLogPath -Value (([DateTime]::Now.ToString('s')) + ' ' + $Message) -Encoding UTF8
  } catch {}
}

function Wait-BeforeExit([string]$Prompt) {
  if (-not $script:PauseBeforeExit -or -not [Environment]::UserInteractive) { return }
  try { Read-Host $Prompt | Out-Null } catch {}
}

function Get-CertificateSha256([System.Security.Cryptography.X509Certificates.X509Certificate]$Certificate) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Certificate.GetRawCertData()))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

$script:ExpectedFingerprint = ([string]$script:Bootstrap.tlsFingerprint).Replace(':', '').ToLowerInvariant()
[Net.ServicePointManager]::ServerCertificateValidationCallback = {
  param($sender, $certificate, $chain, $sslPolicyErrors)
  if ($null -eq $certificate) { return $false }
  return (Get-CertificateSha256 $certificate) -eq $script:ExpectedFingerprint
}

function Protect-Token([string]$Token) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Token)
  $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Convert]::ToBase64String($protected)
}

function Unprotect-Token([string]$ProtectedToken) {
  $bytes = [Convert]::FromBase64String($ProtectedToken)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Text.Encoding]::UTF8.GetString($plain)
}

function Load-State {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json }
  catch { throw 'The VM Protect agent state is damaged. Run this agent with -Repair, or pair it again.' }
}

function Save-State($State) {
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  $temporary = $StatePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $State | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Get-UnixMilliseconds {
  return [int64](([DateTime]::UtcNow - [DateTime]'1970-01-01T00:00:00Z').TotalMilliseconds)
}

function New-Nonce {
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Get-ByteSha256([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-HmacHex([string]$Token, [string]$Canonical) {
  $hmac = New-Object Security.Cryptography.HMACSHA256
  try {
    $hmac.Key = [Text.Encoding]::UTF8.GetBytes($Token)
    return ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Canonical)))).Replace('-', '').ToLowerInvariant()
  } finally { $hmac.Dispose() }
}

function New-SignedHeaders($State, [string]$Method, [string]$PathAndQuery, [byte[]]$Body) {
  $timestamp = [string]((Get-UnixMilliseconds) + [int64]$State.clockOffsetMs)
  $nonce = New-Nonce
  $sha256 = Get-ByteSha256 $Body
  $lf = [string][char]10
  $canonical = $Method.ToUpperInvariant() + $lf + $PathAndQuery + $lf + $timestamp + $lf + $nonce + $lf + [string]$Body.Length + $lf + $sha256
  $token = Unprotect-Token ([string]$State.tokenProtected)
  return @{
    'x-labsuite-guest-id' = [string]$State.guestId
    'x-labsuite-timestamp' = $timestamp
    'x-labsuite-nonce' = $nonce
    'x-content-sha256' = $sha256
    'x-labsuite-signature' = Get-HmacHex $token $canonical
  }
}

function Get-WebFailureDetail($Failure) {
  $detail = $Failure.Exception.Message
  $response = $Failure.Exception.Response
  if ($null -eq $response) { return $detail }
  try {
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    try {
      $text = $reader.ReadToEnd()
      if (-not [string]::IsNullOrWhiteSpace($text)) {
        try {
          $payload = $text | ConvertFrom-Json
          if (-not [string]::IsNullOrWhiteSpace([string]$payload.error)) { return ($detail + ' Host reason: ' + [string]$payload.error) }
        } catch {}
        return ($detail + ' Host response: ' + $text)
      }
    } finally { $reader.Dispose() }
  } catch {} finally { try { $response.Dispose() } catch {} }
  return $detail
}

function Invoke-PinnedRaw([string]$Method, [string]$Uri, [byte[]]$Body, [string]$ContentType, [hashtable]$Headers) {
  $request = [Net.HttpWebRequest]::Create($Uri)
  $request.Method = $Method
  $request.ContentType = $ContentType
  $request.AllowWriteStreamBuffering = $false
  $request.Timeout = 120000
  $request.ReadWriteTimeout = 120000
  $request.ContentLength = $Body.Length
  foreach ($key in $Headers.Keys) { $request.Headers.Add($key, [string]$Headers[$key]) }
  if ($Body.Length -gt 0) {
    $stream = $request.GetRequestStream()
    try { $stream.Write($Body, 0, $Body.Length) } finally { $stream.Dispose() }
  }
  $response = $request.GetResponse()
  try {
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    try {
      $text = $reader.ReadToEnd()
      if ([string]::IsNullOrWhiteSpace($text)) { return [PSCustomObject]@{} }
      return $text | ConvertFrom-Json
    } finally { $reader.Dispose() }
  } finally { $response.Dispose() }
}

function Invoke-PinnedJson([string]$Method, [string]$Uri, $Body) {
  $bytes = if ($null -eq $Body) { [byte[]]@() } else { [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress)) }
  return Invoke-PinnedRaw $Method $Uri $bytes 'application/json' @{}
}

function Invoke-SignedBytes($State, [string]$Method, [string]$PathAndQuery, [byte[]]$Body, [string]$ContentType, [hashtable]$ExtraHeaders) {
  $headers = New-SignedHeaders $State $Method $PathAndQuery $Body
  foreach ($key in $ExtraHeaders.Keys) { $headers[$key] = [string]$ExtraHeaders[$key] }
  return Invoke-PinnedRaw $Method (([string]$State.serverUrl).TrimEnd('/') + $PathAndQuery) $Body $ContentType $headers
}

function Invoke-SignedJson($State, [string]$Method, [string]$PathAndQuery, $Body) {
  $bytes = if ($null -eq $Body) { [byte[]]@() } else { [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 12 -Compress)) }
  return Invoke-SignedBytes $State $Method $PathAndQuery $bytes 'application/json' @{}
}

function Test-TcpEndpoint([Uri]$Endpoint) {
  $client = $null
  try {
    $client = New-Object Net.Sockets.TcpClient
    $pending = $client.BeginConnect($Endpoint.Host, $(if ($Endpoint.Port -gt 0) { $Endpoint.Port } else { 443 }), $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(1500, $false)) { return 'UNREACHABLE (timeout)' }
    $client.EndConnect($pending)
    return 'REACHABLE'
  } catch { return ('UNREACHABLE (' + $_.Exception.Message + ')') }
  finally { if ($null -ne $client) { $client.Dispose() } }
}

function New-DiagnosticReport($Failure, $State) {
  $lines = New-Object Collections.Generic.List[string]
  $lines.Add('LabSuite VM Protect v2 diagnostic')
  $lines.Add(('Generated: ' + [DateTime]::Now.ToString('s')))
  $lines.Add(('Computer: ' + [Environment]::MachineName))
  $lines.Add(('PowerShell: ' + [string]$PSVersionTable.PSVersion))
  try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop | ForEach-Object { [string]$_.InterfaceAlias + '=' + [string]$_.NetworkCategory })
    $lines.Add(('Network profiles: ' + $(if ($profiles.Count) { $profiles -join ', ' } else { 'none reported' })))
  } catch { $lines.Add(('Network profiles: unavailable (' + $_.Exception.Message + ')')) }
  $lines.Add(('Paired: ' + [string]($null -ne $State)))
  if ($null -ne $State) {
    $lines.Add(('Protected roots: ' + [string]@($State.roots).Count))
    $lines.Add(('Manifest files: ' + [string]@($State.manifest).Count))
    $lines.Add(('Pending batch: ' + [string]($null -ne $State.pendingBatch)))
    $lines.Add(('Last retry error: ' + [string]($State.retryJournal.lastError)))
  }
  $lines.Add('Receiver endpoints:')
  foreach ($server in @($script:Bootstrap.serverUrls)) {
    try { $endpoint = [Uri][string]$server; $lines.Add(('  ' + $endpoint.Host + ':' + $endpoint.Port + ' -> ' + (Test-TcpEndpoint $endpoint))) }
    catch { $lines.Add(('  invalid endpoint -> ' + $_.Exception.Message)) }
  }
  if ($null -ne $Failure) {
    $lines.Add('Failure:')
    $lines.Add(('  Message: ' + $Failure.Exception.Message))
    $lines.Add(('  Type: ' + $Failure.Exception.GetType().FullName))
    $lines.Add(('  Error ID: ' + [string]$Failure.FullyQualifiedErrorId))
    if (-not [string]::IsNullOrWhiteSpace([string]$Failure.ScriptStackTrace)) { $lines.Add(('  Stack: ' + ([string]$Failure.ScriptStackTrace).Replace([Environment]::NewLine, ' | '))) }
  } else { $lines.Add('Failure: none') }
  return ($lines -join [Environment]::NewLine)
}

function Save-AndCopyDiagnostics($Failure, $State) {
  $report = New-DiagnosticReport $Failure $State
  try { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null; Set-Content -LiteralPath $DiagnosticPath -Value $report -Encoding UTF8 } catch {}
  $copied = $false
  try {
    $clip = Join-Path $env:SystemRoot 'System32\clip.exe'
    if (Test-Path -LiteralPath $clip -PathType Leaf) { $report | & $clip; $copied = $LASTEXITCODE -eq 0 }
  } catch {}
  return [PSCustomObject]@{ Report = $report; Copied = $copied }
}

trap {
  Write-RunLog ('ERROR: ' + $_.Exception.Message)
  $diagnostic = Save-AndCopyDiagnostics $_ $script:CurrentState
  Write-Host ''
  Write-Host 'LabSuite VM Protect v2 could not finish.' -ForegroundColor Red
  Write-Host $diagnostic.Report -ForegroundColor Yellow
  if ($diagnostic.Copied) { Write-Host 'The diagnostic report was copied to your clipboard.' -ForegroundColor Green }
  Write-Host ('Diagnostic report: ' + $DiagnosticPath) -ForegroundColor DarkGray
  Write-Host ('Agent log: ' + $RunLogPath) -ForegroundColor DarkGray
  Wait-BeforeExit 'Press Enter to close'
  exit 1
}

function Get-RootId([string]$FullPath, [string]$Type) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($Type + ':' + $FullPath.ToLowerInvariant()))
  return 'root-' + (Get-ByteSha256 $bytes).Substring(0, 24)
}

function New-ProtectedRoot([string]$CandidatePath) {
  $fullPath = [IO.Path]::GetFullPath($CandidatePath)
  $item = Get-Item -LiteralPath $fullPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points and symlinks cannot be protected as a root.' }
  $type = if ($item.PSIsContainer) { 'folder' } else { 'file' }
  return [PSCustomObject]@{ id = (Get-RootId $fullPath $type); path = $fullPath; type = $type; recursive = $type -eq 'folder' }
}

function Merge-Roots($Existing, [string[]]$Additional) {
  $result = New-Object Collections.Generic.List[object]
  $seen = @{}
  foreach ($root in @($Existing)) {
    if ($null -eq $root -or [string]::IsNullOrWhiteSpace([string]$root.id) -or [string]::IsNullOrWhiteSpace([string]$root.path)) { continue }
    $seen[[string]$root.id] = $true
    $result.Add($root)
  }
  foreach ($candidate in @($Additional)) {
    if ([string]::IsNullOrWhiteSpace([string]$candidate) -or -not (Test-Path -LiteralPath $candidate)) { continue }
    $root = New-ProtectedRoot $candidate
    if (-not $seen.ContainsKey([string]$root.id)) { $seen[[string]$root.id] = $true; $result.Add($root) }
  }
  return $result.ToArray()
}

function Select-ProtectedRoots {
  Add-Type -AssemblyName System.Windows.Forms
  $paths = New-Object Collections.Generic.List[string]
  $folder = New-Object Windows.Forms.FolderBrowserDialog
  $folder.Description = 'Choose a folder to protect with LabSuite (Cancel to skip folders)'
  if ($folder.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $paths.Add($folder.SelectedPath) }
  $files = New-Object Windows.Forms.OpenFileDialog
  $files.Title = 'Choose one or more files to protect with LabSuite (Cancel to finish)'
  $files.Multiselect = $true
  $files.CheckFileExists = $true
  if ($files.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { foreach ($file in @($files.FileNames)) { $paths.Add($file) } }
  return $paths.ToArray()
}

function Connect-LabSuite($Roots) {
  $deadline = [DateTime]::Parse([string]$script:Bootstrap.expiresAt).ToUniversalTime()
  if ([bool]$script:Bootstrap.autoApprove) { $deadline = [DateTime]::UtcNow.AddSeconds(45) }
  $lastError = $null
  $announced = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($server in @($script:Bootstrap.serverUrls)) {
      try {
        $response = Invoke-PinnedJson 'POST' ($server.TrimEnd('/') + '/agent/v2/pair') @{
          enrollmentId = [string]$script:Bootstrap.enrollmentId
          secret = [string]$script:Bootstrap.secret
          name = [string]$script:Bootstrap.name
          machineName = [Environment]::MachineName
          roots = @($Roots)
        }
        if ($response.pending) {
          if (-not $announced) { Write-Host ('Approve this VM in LabSuite. Confirmation code: ' + [string]$response.pairingCode) -ForegroundColor Cyan; $announced = $true }
          continue
        }
        if ($response.rejected) { throw 'The LabSuite host rejected this VM pairing request.' }
        if (-not $response.success) { throw [string]$response.error }
        $state = [PSCustomObject]@{
          protocolVersion = 2
          enrollmentId = [string]$script:Bootstrap.enrollmentId
          guestId = [string]$response.guestId
          tokenProtected = Protect-Token ([string]$response.token)
          serverUrl = $server.TrimEnd('/')
          tlsFingerprint = [string]$script:Bootstrap.tlsFingerprint
          clockOffsetMs = if ($null -ne $response.serverTimeMs) { [int64]$response.serverTimeMs - (Get-UnixMilliseconds) } else { [int64]0 }
          roots = @($Roots)
          excludePatterns = @()
          manifest = @()
          pendingBatch = $null
          generation = 0
          pollSeconds = 20
          maxFileBytes = [int64]$response.maxFileBytes
          smallFileBundleBytes = [int64]$response.smallFileBundleBytes
          chunkBytes = [int64]$response.chunkBytes
          maxParallelUploads = [int]$response.maxParallelUploads
          retryJournal = [PSCustomObject]@{ attempts = 0; lastError = ''; lastAttemptAt = '' }
          lastHeartbeatAt = ''
        }
        Save-State $state
        Write-RunLog 'Pairing completed with VM Protect v2.'
        return $state
      } catch { $lastError = Get-WebFailureDetail $_; Write-RunLog ('Pairing failed: ' + $lastError) }
    }
    Start-Sleep -Seconds 2
  }
  throw ('The LabSuite receiver did not complete VM Protect pairing. ' + $lastError)
}

function Test-Excluded([string]$RelativePath, $State) {
  foreach ($pattern in @($State.excludePatterns)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$pattern) -and $RelativePath -like [string]$pattern) { return $true }
  }
  return $false
}

function Get-PreviousManifestMap($State) {
  $map = @{}
  foreach ($entry in @($State.manifest)) {
    if ($null -ne $entry -and -not [string]::IsNullOrWhiteSpace([string]$entry.relativePath)) { $map[[string]$entry.relativePath.ToLowerInvariant()] = $entry }
  }
  return $map
}

function Get-FileEntry($Item, $Root, $RelativeWithinRoot, $Previous, $State) {
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
  if ([int64]$Item.Length -gt [int64]$State.maxFileBytes) { Write-RunLog ('Skipped over-size file: ' + $Item.FullName); return $null }
  $relativePath = ([string]$Root.id + '/' + $RelativeWithinRoot.Replace('\\', '/')).Replace('//', '/')
  if (Test-Excluded $relativePath $State) { return $null }
  $key = $relativePath.ToLowerInvariant()
  $mtimeUtc = $Item.LastWriteTimeUtc.ToString('o')
  $sha256 = ''
  if ($null -ne $Previous -and [int64]$Previous.size -eq [int64]$Item.Length -and [string]$Previous.mtimeUtc -eq $mtimeUtc) { $sha256 = [string]$Previous.sha256 }
  if ([string]::IsNullOrWhiteSpace($sha256)) { $sha256 = (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
  return [PSCustomObject]@{ relativePath = $relativePath; key = $key; sourcePath = $Item.FullName; size = [int64]$Item.Length; mtimeUtc = $mtimeUtc; sha256 = $sha256 }
}

function Get-CurrentManifestMap($State) {
  $previous = Get-PreviousManifestMap $State
  $current = @{}
  foreach ($root in @($State.roots)) {
    if ($null -eq $root -or -not (Test-Path -LiteralPath ([string]$root.path))) { continue }
    try {
      $rootItem = Get-Item -LiteralPath ([string]$root.path) -Force
      if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
      if ([string]$root.type -eq 'file') {
        $entry = Get-FileEntry $rootItem $root $rootItem.Name $previous[([string]$root.id + '/' + $rootItem.Name).ToLowerInvariant()] $State
        if ($null -ne $entry) { $current[$entry.key] = $entry }
      } else {
        $base = ([string]$rootItem.FullName).TrimEnd('\\')
        foreach ($item in @(Get-ChildItem -LiteralPath $base -File -Recurse -Force -ErrorAction SilentlyContinue)) {
          $relative = $item.FullName.Substring($base.Length).TrimStart('\\')
          $key = ([string]$root.id + '/' + $relative.Replace('\\', '/')).ToLowerInvariant()
          $entry = Get-FileEntry $item $root $relative $previous[$key] $State
          if ($null -ne $entry) { $current[$entry.key] = $entry }
        }
      }
    } catch { Write-RunLog ('Scan warning for ' + [string]$root.path + ': ' + $_.Exception.Message) }
  }
  return $current
}

function Get-EntryId([string]$Type, [string]$RelativePath, [string]$Sha256, [int64]$Generation) {
  return (Get-ByteSha256 ([Text.Encoding]::UTF8.GetBytes($Type + [char]10 + $RelativePath + [char]10 + $Sha256 + [char]10 + [string]$Generation))).Substring(0, 32)
}

function New-PendingBatch($State) {
  if ($null -ne $State.pendingBatch) { return $State.pendingBatch }
  $previous = Get-PreviousManifestMap $State
  $current = Get-CurrentManifestMap $State
  $generation = [int64]$State.generation + 1
  $entries = New-Object Collections.Generic.List[object]
  foreach ($key in $current.Keys) {
    $entry = $current[$key]
    $old = $previous[$key]
    if ($null -eq $old -or [string]$old.sha256 -ne [string]$entry.sha256 -or [int64]$old.size -ne [int64]$entry.size) {
      $entries.Add([PSCustomObject]@{ id = (Get-EntryId 'file' $entry.relativePath $entry.sha256 $generation); type = 'file'; relativePath = $entry.relativePath; sourcePath = $entry.sourcePath; size = $entry.size; mtimeUtc = $entry.mtimeUtc; sha256 = $entry.sha256 })
    }
  }
  foreach ($key in $previous.Keys) {
    if (-not $current.ContainsKey($key)) {
      $old = $previous[$key]
      $entries.Add([PSCustomObject]@{ id = (Get-EntryId 'tombstone' ([string]$old.relativePath) '' $generation); type = 'tombstone'; relativePath = [string]$old.relativePath })
    }
  }
  if ($entries.Count -eq 0) { return $null }
  $batch = [PSCustomObject]@{ batchId = [Guid]::NewGuid().ToString('N'); generation = $generation; roots = @($State.roots); entries = $entries.ToArray(); createdAt = [DateTime]::UtcNow.ToString('o') }
  $State.pendingBatch = $batch
  Save-State $State
  return $batch
}

function Compress-Gzip([byte[]]$Bytes) {
  $output = New-Object IO.MemoryStream
  try {
    $gzip = New-Object IO.Compression.GzipStream($output, [IO.Compression.CompressionMode]::Compress, $true)
    try { $gzip.Write($Bytes, 0, $Bytes.Length) } finally { $gzip.Dispose() }
    return $output.ToArray()
  } finally { $output.Dispose() }
}

function Send-SmallBundle($State, $Batch, $Entries) {
  $items = New-Object Collections.Generic.List[object]
  foreach ($entry in @($Entries)) {
    if (-not (Test-Path -LiteralPath ([string]$entry.sourcePath) -PathType Leaf)) { throw ('Protected file disappeared: ' + [string]$entry.sourcePath) }
    $bytes = [IO.File]::ReadAllBytes([string]$entry.sourcePath)
    if ($bytes.Length -ne [int64]$entry.size -or (Get-ByteSha256 $bytes) -ne [string]$entry.sha256) { throw ('Protected file changed while preparing a batch: ' + [string]$entry.sourcePath) }
    $items.Add([PSCustomObject]@{ id = [string]$entry.id; data = [Convert]::ToBase64String($bytes) })
  }
  $json = [Text.Encoding]::UTF8.GetBytes((@{ entries = $items.ToArray() } | ConvertTo-Json -Depth 6 -Compress))
  $compressed = Compress-Gzip $json
  Invoke-SignedBytes $State 'PUT' ('/agent/v2/batches/' + [string]$Batch.batchId + '/bundle') $compressed 'application/json' @{ 'content-encoding' = 'gzip' } | Out-Null
}

function Send-LargeFile($State, $Batch, $Entry, $StartOffset) {
  if (-not (Test-Path -LiteralPath ([string]$Entry.sourcePath) -PathType Leaf)) { throw ('Protected file disappeared: ' + [string]$Entry.sourcePath) }
  $item = Get-Item -LiteralPath ([string]$Entry.sourcePath)
  if ([int64]$item.Length -ne [int64]$Entry.size -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$Entry.sha256) {
    throw ('Protected file changed while preparing a batch: ' + $item.FullName)
  }
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
  try {
    $offset = [int64]$StartOffset
    $stream.Position = $offset
    $chunkBytes = [Math]::Max(65536, [int]$State.chunkBytes)
    while ($offset -lt [int64]$Entry.size) {
      $remaining = [int64]$Entry.size - $offset
      $buffer = New-Object byte[] ([int][Math]::Min($chunkBytes, $remaining))
      $read = $stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { throw 'Could not read the next protected file chunk.' }
      if ($read -lt $buffer.Length) { $buffer = $buffer[0..($read - 1)] }
      $response = Invoke-SignedBytes $State 'PUT' ('/agent/v2/batches/' + [string]$Batch.batchId + '/files/' + [string]$Entry.id + '/chunks/' + [string]$offset) $buffer 'application/octet-stream' @{}
      $next = [int64]$response.nextOffset
      if ($next -le $offset -or $next -gt [int64]$Entry.size) { throw 'The VM Protect receiver returned an invalid chunk offset.' }
      $offset = $next
    }
  } finally { $stream.Dispose() }
}

function Wait-LargeUpload($Process) {
  $Process.WaitForExit()
  if ($Process.ExitCode -ne 0) {
    throw ('A parallel VM Protect chunk worker exited with code ' + [string]$Process.ExitCode + '. Run the agent with -Diagnostics for its copied report.')
  }
}

function Send-LargeFilesParallel($State, $Batch, $Entries, $ChunkOffsets) {
  $scriptPath = $PSCommandPath
  if ([string]::IsNullOrWhiteSpace($scriptPath) -or -not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    foreach ($entry in @($Entries)) {
      $offset = 0
      if ($null -ne $ChunkOffsets -and $null -ne $ChunkOffsets.([string]$entry.id)) { $offset = [int64]$ChunkOffsets.([string]$entry.id) }
      Send-LargeFile $State $Batch $entry $offset
    }
    return
  }
  $limit = [Math]::Max(1, [Math]::Min(4, [int]$State.maxParallelUploads))
  $running = New-Object Collections.Generic.List[object]
  foreach ($entry in @($Entries)) {
    $offset = 0
    if ($null -ne $ChunkOffsets -and $null -ne $ChunkOffsets.([string]$entry.id)) { $offset = [int64]$ChunkOffsets.([string]$entry.id) }
    $entryJson = [Text.Encoding]::UTF8.GetBytes(($entry | ConvertTo-Json -Depth 6 -Compress))
    $entryBase64 = [Convert]::ToBase64String($entryJson)
    $quotedScript = '"' + $scriptPath.Replace('"', '""') + '"'
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ' + $quotedScript + ' -UploadLarge -BatchId ' + [string]$Batch.batchId + ' -EntryBase64 ' + $entryBase64 + ' -StartOffset ' + [string]$offset + ' -NoPause'
    $process = Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList $arguments -PassThru
    $running.Add($process)
    if ($running.Count -ge $limit) {
      $first = $running[0]
      $running.RemoveAt(0)
      Wait-LargeUpload $first
    }
  }
  foreach ($process in $running.ToArray()) { Wait-LargeUpload $process }
}

function Apply-CommittedBatch($State, $Batch, $Generation) {
  $map = Get-PreviousManifestMap $State
  foreach ($entry in @($Batch.entries)) {
    $key = ([string]$entry.relativePath).ToLowerInvariant()
    if ([string]$entry.type -eq 'tombstone') { $map.Remove($key); continue }
    $map[$key] = [PSCustomObject]@{ relativePath = [string]$entry.relativePath; size = [int64]$entry.size; mtimeUtc = [string]$entry.mtimeUtc; sha256 = [string]$entry.sha256 }
  }
  $State.manifest = @($map.Values | Sort-Object relativePath)
  $State.pendingBatch = $null
  $State.generation = [int64]$Generation
  $State.retryJournal = [PSCustomObject]@{ attempts = 0; lastError = ''; lastAttemptAt = '' }
  Save-State $State
}

function Sync-PendingBatch($State) {
  $batch = New-PendingBatch $State
  if ($null -eq $batch) { return $false }
  try {
    $plan = Invoke-SignedJson $State 'POST' '/agent/v2/batches/prepare' @{
      batchId = [string]$batch.batchId
      generation = [int64]$batch.generation
      roots = @($batch.roots)
      excludePatterns = @($State.excludePatterns)
      entries = @($batch.entries | ForEach-Object {
        if ([string]$_.type -eq 'tombstone') { [PSCustomObject]@{ id = $_.id; type = 'tombstone'; relativePath = $_.relativePath } }
        else { [PSCustomObject]@{ id = $_.id; type = 'file'; relativePath = $_.relativePath; size = $_.size; mtimeUtc = $_.mtimeUtc; sha256 = $_.sha256 } }
      })
    }
    if ($plan.committed) { Apply-CommittedBatch $State $batch ([int64]$batch.generation); return $true }
    $missing = @{}
    foreach ($id in @($plan.missing)) { $missing[[string]$id] = $true }
    $small = New-Object Collections.Generic.List[object]
    $large = New-Object Collections.Generic.List[object]
    $smallBytes = 0
    foreach ($entry in @($batch.entries)) {
      if ([string]$entry.type -ne 'file' -or -not $missing.ContainsKey([string]$entry.id)) { continue }
      if ([int64]$entry.size -le [int64]$State.smallFileBundleBytes) {
        if ($small.Count -gt 0 -and $smallBytes + [int64]$entry.size -gt 3MB) { Send-SmallBundle $State $batch $small.ToArray(); $small.Clear(); $smallBytes = 0 }
        $small.Add($entry); $smallBytes += [int64]$entry.size
      } else {
        $large.Add($entry)
      }
    }
    if ($small.Count -gt 0) { Send-SmallBundle $State $batch $small.ToArray() }
    if ($large.Count -gt 0) { Send-LargeFilesParallel $State $batch $large.ToArray() $plan.chunkOffsets }
    $result = Invoke-SignedJson $State 'POST' ('/agent/v2/batches/' + [string]$batch.batchId + '/commit') @{ generation = [int64]$batch.generation; excludePatterns = @($State.excludePatterns) }
    if (-not $result.success) { throw ([string]$result.error) }
    Apply-CommittedBatch $State $batch ([int64]$result.generation)
    Write-RunLog ('Committed batch ' + [string]$batch.batchId + ' with ' + [string]$result.changedCount + ' changed and ' + [string]$result.deletedCount + ' deleted file(s).')
    return $true
  } catch {
    $attempts = 1
    if ($null -ne $State.retryJournal) { $attempts = [int]$State.retryJournal.attempts + 1 }
    $State.retryJournal = [PSCustomObject]@{ attempts = $attempts; lastError = (Get-WebFailureDetail $_); lastAttemptAt = [DateTime]::UtcNow.ToString('o') }
    Save-State $State
    Write-RunLog ('Batch retry queued: ' + [string]$State.retryJournal.lastError)
    throw
  }
}

function Send-Heartbeat($State) {
  $pendingFiles = if ($null -eq $State.pendingBatch) { 0 } else { @($State.pendingBatch.entries).Count }
  $pendingBytes = if ($null -eq $State.pendingBatch) { 0 } else { (@($State.pendingBatch.entries | Where-Object { $_.type -eq 'file' } | Measure-Object -Property size -Sum).Sum) }
  $response = Invoke-SignedJson $State 'POST' '/agent/v2/heartbeat' @{ roots = @($State.roots); queue = @{ pendingFiles = $pendingFiles; pendingBytes = [int64]$pendingBytes } }
  if ($null -ne $response.serverTimeMs) { $State.clockOffsetMs = [int64]$response.serverTimeMs - (Get-UnixMilliseconds); $State.lastHeartbeatAt = [DateTime]::UtcNow.ToString('o'); Save-State $State }
}

function Install-Agent($State) {
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  $source = $MyInvocation.ScriptName
  if ([string]::IsNullOrWhiteSpace($source)) { throw 'Installing the VM Protect agent requires a saved .ps1 file.' }
  if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($InstalledScript)) { Copy-Item -LiteralPath $source -Destination $InstalledScript -Force }
  $quoted = '"' + $InstalledScript.Replace('"', '""') + '"'
  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $quoted + ' -RunAgent -NoPause'
  New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LabSuiteVMProtectV2' -Value $command -PropertyType String -Force | Out-Null
  Write-RunLog 'Installed per-user startup agent.'
}

function Uninstall-Agent {
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'LabSuiteVMProtectV2' -ErrorAction SilentlyContinue
  Write-RunLog 'Removed per-user startup agent.'
}

function Start-HiddenAgent([string]$ScriptPath) {
  $command = "& '" + $ScriptPath.Replace("'", "''") + "' -RunAgent -NoPause"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) | Out-Null
}

function New-FileWatchers($State) {
  $items = New-Object Collections.Generic.List[object]
  foreach ($root in @($State.roots)) {
    try {
      $watchPath = if ([string]$root.type -eq 'file') { Split-Path -Parent ([string]$root.path) } else { [string]$root.path }
      if (-not (Test-Path -LiteralPath $watchPath -PathType Container)) { continue }
      $watcher = New-Object IO.FileSystemWatcher $watchPath
      $watcher.IncludeSubdirectories = [string]$root.type -eq 'folder'
      $watcher.EnableRaisingEvents = $true
      $prefix = 'LabSuiteVMProtectV2-' + [Guid]::NewGuid().ToString('N')
      foreach ($eventName in @('Changed', 'Created', 'Deleted', 'Renamed')) { Register-ObjectEvent -InputObject $watcher -EventName $eventName -SourceIdentifier ($prefix + '-' + $eventName) | Out-Null }
      $items.Add([PSCustomObject]@{ watcher = $watcher; prefix = $prefix })
    } catch { Write-RunLog ('Could not watch root: ' + $_.Exception.Message) }
  }
  return $items.ToArray()
}

function Stop-FileWatchers($Watchers) {
  foreach ($item in @($Watchers)) {
    try { Get-EventSubscriber | Where-Object { $_.SourceIdentifier -like ($item.prefix + '*') } | Unregister-Event } catch {}
    try { $item.watcher.Dispose() } catch {}
  }
}

function Start-AgentLoop($State) {
  $created = $false
  $mutex = New-Object Threading.Mutex($true, ('Local\LabSuiteVMProtectV2-' + [string]$State.guestId), [ref]$created)
  if (-not $created) { return }
  $watchers = New-FileWatchers $State
  $lastReconcile = [DateTime]::MinValue
  $lastHeartbeat = [DateTime]::MinValue
  try {
    while ($true) {
      $event = Wait-Event -Timeout ([Math]::Max(10, [int]$State.pollSeconds))
      $changed = $null -ne $event
      if ($null -ne $event) { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1200 }
      if ($changed -or (([DateTime]::UtcNow - $lastReconcile).TotalMinutes -ge 5)) {
        try { Sync-PendingBatch $State | Out-Null } catch {}
        $lastReconcile = [DateTime]::UtcNow
      }
      if (([DateTime]::UtcNow - $lastHeartbeat).TotalSeconds -ge 60) { try { Send-Heartbeat $State } catch { Write-RunLog ('Heartbeat failed: ' + (Get-WebFailureDetail $_)) }; $lastHeartbeat = [DateTime]::UtcNow }
    }
  } finally { Stop-FileWatchers $watchers; $mutex.ReleaseMutex(); $mutex.Dispose() }
}

if ($Uninstall) {
  Uninstall-Agent
  Write-Host 'LabSuite VM Protect startup agent was removed.' -ForegroundColor Green
  Wait-BeforeExit 'Press Enter to close'
  exit 0
}

$script:CurrentState = Load-State
if ($Diagnostics) {
  $diagnostic = Save-AndCopyDiagnostics $null $script:CurrentState
  Write-Host $diagnostic.Report -ForegroundColor Cyan
  if ($diagnostic.Copied) { Write-Host 'The diagnostic report was copied to your clipboard.' -ForegroundColor Green }
  Wait-BeforeExit 'Diagnostics finished. Press Enter to close'
  exit 0
}

if ($UploadLarge) {
  if ($null -eq $script:CurrentState -or [string]::IsNullOrWhiteSpace($BatchId) -or [string]::IsNullOrWhiteSpace($EntryBase64)) {
    throw 'The parallel VM Protect chunk worker is missing its paired state or batch details.'
  }
  $script:ExpectedFingerprint = ([string]$script:CurrentState.tlsFingerprint).Replace(':', '').ToLowerInvariant()
  try { $entry = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EntryBase64)) | ConvertFrom-Json }
  catch { throw 'The parallel VM Protect chunk worker received invalid entry data.' }
  Send-LargeFile $script:CurrentState ([PSCustomObject]@{ batchId = $BatchId }) $entry $StartOffset
  exit 0
}

$requestedPaths = @($Paths)
if ($null -eq $script:CurrentState -or $Pair) {
  if ($requestedPaths.Count -eq 0 -and -not $NoPicker -and -not $RunAgent) { $requestedPaths = Select-ProtectedRoots }
  $roots = Merge-Roots @($script:Bootstrap.roots) $requestedPaths
  if ($roots.Count -eq 0) { throw 'No files or folders were selected. Run the agent again and choose at least one protected path.' }
  Write-Host 'Connecting this VM to the LabSuite Secure Receiver...' -ForegroundColor Cyan
  $script:CurrentState = Connect-LabSuite $roots
} else {
  $script:ExpectedFingerprint = ([string]$script:CurrentState.tlsFingerprint).Replace(':', '').ToLowerInvariant()
  if ($requestedPaths.Count -gt 0) { $script:CurrentState.roots = Merge-Roots @($script:CurrentState.roots) $requestedPaths }
  if ($Exclude.Count -gt 0) { $script:CurrentState.excludePatterns = @($script:CurrentState.excludePatterns) + @($Exclude | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) }
  if ($null -eq $script:CurrentState.manifest) { $script:CurrentState | Add-Member -NotePropertyName manifest -NotePropertyValue @() }
  if ($null -eq $script:CurrentState.retryJournal) { $script:CurrentState | Add-Member -NotePropertyName retryJournal -NotePropertyValue ([PSCustomObject]@{ attempts = 0; lastError = ''; lastAttemptAt = '' }) }
  Save-State $script:CurrentState
}

if ($Repair) { $script:CurrentState.pendingBatch = $null; $script:CurrentState.manifest = @(); Save-State $script:CurrentState; Write-RunLog 'Repair requested; local manifest will reconcile from scratch.' }
if ($Status) {
  Write-Host ('VM Protect v2: ' + @($script:CurrentState.roots).Count + ' root(s), ' + @($script:CurrentState.manifest).Count + ' file(s), pending batch: ' + ($null -ne $script:CurrentState.pendingBatch)) -ForegroundColor Cyan
  try { Send-Heartbeat $script:CurrentState; Write-Host 'Receiver is reachable.' -ForegroundColor Green } catch { Write-Host ('Receiver needs attention: ' + (Get-WebFailureDetail $_)) -ForegroundColor Yellow }
  Wait-BeforeExit 'Press Enter to close'
  exit 0
}

if ($RunAgent) { Start-AgentLoop $script:CurrentState; exit 0 }

Write-Host 'Reconciling protected files and folders...' -ForegroundColor Cyan
try { Sync-PendingBatch $script:CurrentState | Out-Null; Send-Heartbeat $script:CurrentState } catch { throw }
if ($Install -or -not $NoPause) {
  Install-Agent $script:CurrentState
  Start-HiddenAgent $InstalledScript
  Write-Host 'Always-on VM Protect is enabled. This VM will catch up whenever the host is available.' -ForegroundColor Green
} else { Write-Host 'VM Protect v2 reconciliation completed.' -ForegroundColor Green }
Write-Host ('Diagnostic log: ' + $RunLogPath) -ForegroundColor DarkGray
Wait-BeforeExit 'Setup finished. Press Enter to close'
`;

function buildPowerShellV2Agent(bootstrap) {
  const encoded = Buffer.from(JSON.stringify(bootstrap), 'utf8').toString('base64');
  return POWER_SHELL_V2_TEMPLATE.replace('__LABSUITE_V2_BOOTSTRAP_BASE64__', encoded);
}

module.exports = { buildPowerShellV2Agent };
