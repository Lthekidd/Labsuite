const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const fsp = fs.promises;

const DEFAULT_PROCESS_TIMEOUT_MS = 4000;
const DEFAULT_REGISTRY_TIMEOUT_MS = 1500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_SCAN_LIMITS = Object.freeze({
  maxDepth: 4,
  maxDirectories: 400,
  maxVms: 250,
  concurrency: 12
});

function unique(values = [], keyFn = value => String(value || '').toLowerCase()) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function decodeVmwareValue(value = '') {
  return decodeXmlEntities(String(value || ''))
    .replace(/\|([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function expandEnvironmentVariables(value = '', env = process.env) {
  return String(value || '').replace(/%([^%]+)%/g, (match, name) => {
    const exact = env[name];
    if (exact !== undefined) return exact;
    const key = Object.keys(env).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? env[key] : match;
  });
}

function normalizeVmxPath(value = '', options = {}) {
  let candidate = decodeVmwareValue(value).replace(/\0/g, '').trim();
  const env = options.env || process.env;

  candidate = candidate.replace(/^["']+|["']+$/g, '').trim();
  candidate = expandEnvironmentVariables(candidate, env);

  if (/^file:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      const decodedPath = decodeURIComponent(url.pathname || '').replace(/\//g, '\\');
      candidate = url.hostname
        ? `\\\\${url.hostname}${decodedPath}`
        : decodedPath.replace(/^\\(?=[A-Za-z]:\\)/, '');
    } catch (_error) {
      candidate = decodeURIComponent(candidate.replace(/^file:\/{2,3}/i, ''));
    }
  }

  candidate = candidate.replace(/\//g, '\\').trim();
  if (!/\.vmx$/i.test(candidate)) return '';

  if (!path.win32.isAbsolute(candidate) && options.baseDir) {
    candidate = path.win32.join(options.baseDir, candidate);
  }

  return path.win32.normalize(candidate);
}

function canonicalVmPath(value = '') {
  const normalized = normalizeVmxPath(value);
  return normalized ? normalized.replace(/\\+$/g, '').toLowerCase() : '';
}

function stableVmId(vmxPath = '', vmwareUuid = '') {
  const normalizedUuid = String(vmwareUuid || '').trim().toLowerCase().replace(/[{}\s-]/g, '');
  const canonical = canonicalVmPath(vmxPath);
  const identity = normalizedUuid ? `uuid:${normalizedUuid}` : canonical ? `path:${canonical}` : '';
  if (!identity) return '';
  return `vm_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function parseVmwareAssignments(text = '') {
  const assignments = [];
  const linePattern = /^\s*([^#;][^=]*?)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|(.+?))\s*$/gm;
  let match;
  while ((match = linePattern.exec(String(text || ''))) !== null) {
    const key = String(match[1] || '').trim();
    const rawValue = match[2] !== undefined
      ? match[2]
      : match[3] !== undefined
        ? match[3]
        : match[4];
    if (!key) continue;
    assignments.push({ key, value: decodeVmwareValue(String(rawValue || '').trim()) });
  }
  return assignments;
}

function parseVmxMetadata(text = '') {
  const values = new Map();
  for (const assignment of parseVmwareAssignments(text)) {
    values.set(assignment.key.toLowerCase(), assignment.value);
  }
  return {
    displayName: values.get('displayname') || '',
    guestOS: values.get('guestos') || '',
    vmwareUuid: values.get('uuid.bios') || values.get('vc.uuid') || values.get('uuid.location') || ''
  };
}

function parseInventoryText(text = '', options = {}) {
  const sourcePath = options.sourcePath || '';
  const baseDir = sourcePath ? path.win32.dirname(sourcePath) : options.baseDir;
  const env = options.env || process.env;
  const assignments = parseVmwareAssignments(text);
  const valuesByKey = new Map(assignments.map(item => [item.key.toLowerCase(), item.value]));
  const candidates = [];

  for (const assignment of assignments) {
    if (!/\.vmx(?:["']?)$/i.test(assignment.value.trim())) continue;
    const vmxPath = normalizeVmxPath(assignment.value, { baseDir, env });
    if (!vmxPath) continue;

    const key = assignment.key.toLowerCase();
    const prefix = key.replace(/\.(?:config|filename|vmxpath|path)$/i, '');
    const name = valuesByKey.get(`${prefix}.displayname`) ||
      valuesByKey.get(`${prefix}.name`) || '';
    candidates.push({ vmxPath, name, source: 'inventory', sourceDetail: sourcePath });
  }

  // Some legacy inventory XML files do not use VMware-style key/value lines.
  const genericPatterns = [
    /file:\/{2,3}[^<>"'\r\n]*?\.vmx/gi,
    /[A-Za-z]:[\\/][^<>"'\r\n]*?\.vmx/gi,
    /\\\\[^<>"'\r\n]*?\.vmx/gi
  ];
  for (const pattern of genericPatterns) {
    let match;
    while ((match = pattern.exec(String(text || ''))) !== null) {
      const vmxPath = normalizeVmxPath(match[0], { baseDir, env });
      if (vmxPath) candidates.push({ vmxPath, source: 'inventory', sourceDetail: sourcePath });
    }
  }

  return normalizeVmCandidates(candidates).map(vm => ({
    vmxPath: vm.vmxPath,
    name: vm.name,
    source: 'inventory',
    sourceDetail: sourcePath
  }));
}

function extractVmxPathsFromCommandLine(commandLine = '') {
  let value = String(commandLine || '').trim();
  if (!value) return [];

  const quoted = [];
  const quotedPattern = /["']([^"'\r\n]+?\.vmx)["']/gi;
  let match;
  while ((match = quotedPattern.exec(value)) !== null) quoted.push(match[1]);
  if (quoted.length) return unique(quoted.map(item => normalizeVmxPath(item)).filter(Boolean), canonicalVmPath);

  // The VMX argument is normally the final argument. Remove the executable first,
  // then use the last absolute path marker so spaces in an unquoted VM path survive.
  value = value
    .replace(/^\s*"[^"]*?vmware-vmx\.exe"\s*/i, '')
    .replace(/^\s*[A-Za-z]:\\.*?vmware-vmx\.exe\s*/i, '')
    .trim();
  const endMatch = /\.vmx\b/i.exec(value);
  if (!endMatch) return [];
  const end = value.toLowerCase().lastIndexOf('.vmx') + 4;
  const throughVmx = value.slice(0, end);
  const starts = [];
  const drivePattern = /[A-Za-z]:\\/g;
  while ((match = drivePattern.exec(throughVmx)) !== null) starts.push(match.index);
  const uncPattern = /\\\\[^\s\\]+\\/g;
  while ((match = uncPattern.exec(throughVmx)) !== null) starts.push(match.index);
  if (!starts.length) return [];

  const start = Math.max(...starts);
  const vmxPath = normalizeVmxPath(throughVmx.slice(start).replace(/^[;\s]+/, '').trim());
  return vmxPath ? [vmxPath] : [];
}

function parsePowerShellProcessOutput(output = '') {
  return parsePowerShellProcessSnapshot(output).paths;
}

function parsePowerShellProcessSnapshot(output = '') {
  const trimmed = String(output || '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return { paths: [], processCount: 0 };
  const parsed = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const paths = [];
  for (const row of rows) {
    const commandLine = row && (row.CommandLine || row.commandLine || row.commandline);
    paths.push(...extractVmxPathsFromCommandLine(commandLine));
  }
  return {
    paths: unique(paths, canonicalVmPath),
    processCount: rows.filter(Boolean).length
  };
}

function parseVmrunListOutput(output = '') {
  const paths = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^["']|["']$/g, '');
    if (/\.vmx$/i.test(line)) paths.push(normalizeVmxPath(line));
  }
  return unique(paths.filter(Boolean), canonicalVmPath);
}

function sourcePriority(source = '') {
  if (source === 'running') return 3;
  if (source === 'inventory') return 2;
  return 1;
}

function normalizeVmCandidates(candidates = []) {
  const byPath = new Map();
  for (const candidate of candidates) {
    const vmxPath = normalizeVmxPath(candidate && candidate.vmxPath);
    const canonical = canonicalVmPath(vmxPath);
    if (!canonical) continue;

    const source = candidate.source || (candidate.running ? 'running' : 'scan');
    let current = byPath.get(canonical);
    if (!current) {
      current = {
        id: stableVmId(vmxPath),
        name: '',
        vmxPath,
        running: false,
        source: source,
        sources: [],
        guestOS: ''
      };
      Object.defineProperty(current, '_sourcePriority', { value: 0, writable: true, enumerable: false });
      byPath.set(canonical, current);
    }

    if (candidate.running || source === 'running') current.running = true;
    if (!current.sources.includes(source)) current.sources.push(source);
    if (sourcePriority(source) > current._sourcePriority) {
      current.source = source;
      current._sourcePriority = sourcePriority(source);
    }
    if (candidate.name && (!current.name || source === 'inventory')) current.name = String(candidate.name).trim();
    if (candidate.guestOS && !current.guestOS) current.guestOS = String(candidate.guestOS).trim();
  }

  return Array.from(byPath.values())
    .map(vm => ({
      ...vm,
      name: vm.name || path.win32.basename(vm.vmxPath, path.win32.extname(vm.vmxPath)),
      sources: vm.sources.sort((a, b) => sourcePriority(b) - sourcePriority(a))
    }))
    .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

function getStandardVmrunCandidates(env = process.env) {
  const programFiles = unique([
    env.ProgramFiles,
    env.PROGRAMFILES,
    env['ProgramFiles(x86)'],
    env.PROGRAMFILES_X86,
    env.ProgramW6432
  ]);
  const candidates = [];
  for (const root of programFiles) {
    candidates.push(
      path.win32.join(root, 'VMware', 'VMware Workstation', 'vmrun.exe'),
      path.win32.join(root, 'VMware', 'VMware Player', 'vmrun.exe'),
      path.win32.join(root, 'VMware', 'VMware VIX', 'vmrun.exe')
    );
  }
  return unique(candidates, value => value.toLowerCase());
}

function getPathVmrunCandidates(env = process.env) {
  const pathValue = env.PATH || env.Path || env.path || '';
  return unique(String(pathValue).split(';')
    .map(folder => folder.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
    .map(folder => path.win32.join(folder, 'vmrun.exe')),
  value => value.toLowerCase());
}

function parseRegistryInstallPath(output = '') {
  const values = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:InstallPath|InstallDir|Path)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i);
    if (match && match[1]) values.push(match[1].trim());
  }
  return unique(values, value => value.toLowerCase());
}

function getVmwareRegistryKeys() {
  const products = ['VMware Workstation', 'VMware Player', 'VMware VIX'];
  const roots = [
    'HKLM\\SOFTWARE\\VMware, Inc.',
    'HKLM\\SOFTWARE\\WOW6432Node\\VMware, Inc.'
  ];
  return roots.flatMap(root => products.map(product => `${root}\\${product}`));
}

function execFileAsync(file, args = [], options = {}) {
  return new Promise(resolve => {
    execFile(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || DEFAULT_PROCESS_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || 1024 * 1024,
      shell: false
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: error && error.code,
        timedOut: !!(error && (error.killed || error.signal === 'SIGTERM')),
        message: error ? error.message : ''
      });
    });
  });
}

async function isFile(filePath) {
  try {
    return (await fsp.stat(filePath)).isFile();
  } catch (_error) {
    return false;
  }
}

async function hasVmxRuntimeLock(vmxPath) {
  const normalized = normalizeVmxPath(vmxPath);
  if (!normalized) return false;
  try {
    await fsp.stat(`${normalized}.lck`);
    return true;
  } catch (_error) {
    return false;
  }
}

async function queryRegistryVmrunCandidates(options = {}) {
  const runner = options.runner || execFileAsync;
  const keys = options.registryKeys || getVmwareRegistryKeys();
  const results = await Promise.all(keys.map(key => runner('reg.exe', ['query', key, '/v', 'InstallPath'], {
    timeoutMs: options.timeoutMs || DEFAULT_REGISTRY_TIMEOUT_MS
  })));
  const installs = results
    .flatMap(result => result.ok ? parseRegistryInstallPath(result.stdout) : [])
    .map(install => expandEnvironmentVariables(install, options.env || process.env));
  const candidates = [];
  for (const install of installs) {
    if (/vmrun\.exe$/i.test(install)) {
      candidates.push(install);
    } else if (/\.exe$/i.test(install)) {
      candidates.push(path.win32.join(path.win32.dirname(install), 'vmrun.exe'));
    } else {
      candidates.push(path.win32.join(install, 'vmrun.exe'), path.win32.join(install, 'bin', 'vmrun.exe'));
    }
  }
  return unique(candidates, value => value.toLowerCase());
}

async function findVmrun(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { path: null, source: null, searched: 0 };

  const env = options.env || process.env;
  const exists = options.isFile || isFile;
  const pathCandidates = options.pathCandidates || getPathVmrunCandidates(env);
  const standardCandidates = options.standardPaths !== undefined
    ? options.standardPaths
    : getStandardVmrunCandidates(env);
  const initial = unique([...pathCandidates, ...standardCandidates], value => value.toLowerCase());

  for (const candidate of initial) {
    if (await exists(candidate)) {
      return {
        path: path.win32.normalize(candidate),
        source: pathCandidates.includes(candidate) ? 'path' : 'standard-install',
        searched: initial.length
      };
    }
  }

  if (options.queryRegistry === false) return { path: null, source: null, searched: initial.length };
  const registryCandidates = options.registryCandidates || await queryRegistryVmrunCandidates(options);
  for (const candidate of registryCandidates) {
    if (await exists(candidate)) {
      return {
        path: path.win32.normalize(candidate),
        source: 'registry',
        searched: initial.length + registryCandidates.length
      };
    }
  }
  return { path: null, source: null, searched: initial.length + registryCandidates.length };
}

function getInventoryFileCandidates(env = process.env) {
  const appData = env.APPDATA || (env.USERPROFILE && path.win32.join(env.USERPROFILE, 'AppData', 'Roaming'));
  const localAppData = env.LOCALAPPDATA || (env.USERPROFILE && path.win32.join(env.USERPROFILE, 'AppData', 'Local'));
  const programData = env.PROGRAMDATA || env.ProgramData;
  const files = [];
  if (appData) {
    files.push(
      path.win32.join(appData, 'VMware', 'inventory.vmls'),
      path.win32.join(appData, 'VMware', 'preferences.ini'),
      path.win32.join(appData, 'VMware', 'preferences')
    );
  }
  if (localAppData) files.push(path.win32.join(localAppData, 'VMware', 'inventory.vmls'));
  if (programData) files.push(path.win32.join(programData, 'VMware', 'hostd', 'vmInventory.xml'));
  return unique(files, value => value.toLowerCase());
}

function getCommonVmRoots(env = process.env) {
  const profile = env.USERPROFILE || (env.HOMEDRIVE && env.HOMEPATH && `${env.HOMEDRIVE}${env.HOMEPATH}`);
  const publicProfile = env.PUBLIC;
  const roots = [];
  if (profile) {
    roots.push(
      path.win32.join(profile, 'Documents', 'Virtual Machines'),
      path.win32.join(profile, 'OneDrive', 'Documents', 'Virtual Machines'),
      path.win32.join(profile, 'Virtual Machines')
    );
  }
  if (publicProfile) roots.push(path.win32.join(publicProfile, 'Documents', 'Shared Virtual Machines'));
  return unique(roots, value => value.toLowerCase());
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

async function readFilePrefix(filePath, maxBytes = DEFAULT_MAX_FILE_BYTES) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return decodeTextBuffer(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function compactError(stage, error, fallbackCode = 'DISCOVERY_FAILED') {
  const rawMessage = error && (error.message || error.stderr) || String(error || 'Unknown error');
  return {
    stage,
    code: String(error && error.code || fallbackCode),
    message: rawMessage.replace(/\s+/g, ' ').trim().slice(0, 500)
  };
}

async function loadInventoryFiles(files = [], options = {}) {
  const candidates = [];
  const filesRead = [];
  const errors = [];
  for (const filePath of unique(files, value => value.toLowerCase())) {
    try {
      if (!(await isFile(filePath))) continue;
      const text = await readFilePrefix(filePath, options.maxFileBytes);
      candidates.push(...parseInventoryText(text, { sourcePath: filePath, env: options.env }));
      filesRead.push(filePath);
    } catch (error) {
      errors.push(compactError('inventory', error));
    }
  }
  return { candidates, filesRead, errors };
}

async function scanVmRoots(roots = [], options = {}) {
  const limits = {
    maxDepth: Number.isFinite(options.maxDepth) ? Math.max(0, options.maxDepth) : DEFAULT_SCAN_LIMITS.maxDepth,
    maxDirectories: Number.isFinite(options.maxDirectories) ? Math.max(1, options.maxDirectories) : DEFAULT_SCAN_LIMITS.maxDirectories,
    maxVms: Number.isFinite(options.maxVms) ? Math.max(1, options.maxVms) : DEFAULT_SCAN_LIMITS.maxVms,
    concurrency: Number.isFinite(options.concurrency) ? Math.max(1, options.concurrency) : DEFAULT_SCAN_LIMITS.concurrency
  };
  const uniqueRoots = unique(roots.map(root => path.win32.normalize(root)), value => value.toLowerCase());
  const queue = uniqueRoots.map(root => ({ dir: root, depth: 0, root }));
  const paths = [];
  const errors = [];
  const rootsScanned = new Set();
  let visitedDirectories = 0;
  let truncated = false;

  while (queue.length && visitedDirectories < limits.maxDirectories && paths.length < limits.maxVms) {
    const remaining = limits.maxDirectories - visitedDirectories;
    const batch = queue.splice(0, Math.min(limits.concurrency, remaining));
    visitedDirectories += batch.length;
    const results = await Promise.all(batch.map(async item => {
      try {
        const entries = await fsp.readdir(item.dir, { withFileTypes: true });
        return { item, entries };
      } catch (error) {
        return { item, error };
      }
    }));

    for (const result of results) {
      if (result.error) {
        if (result.item.depth > 0 || result.error.code !== 'ENOENT') {
          errors.push(compactError('scan', result.error));
        }
        continue;
      }
      rootsScanned.add(result.item.root);
      for (const entry of result.entries) {
        const fullPath = path.win32.join(result.item.dir, entry.name);
        if (entry.isFile() && /\.vmx$/i.test(entry.name)) {
          paths.push(fullPath);
          if (paths.length >= limits.maxVms) {
            truncated = true;
            break;
          }
        } else if (entry.isDirectory() && result.item.depth < limits.maxDepth) {
          queue.push({ dir: fullPath, depth: result.item.depth + 1, root: result.item.root });
        }
      }
      if (paths.length >= limits.maxVms) break;
    }
  }

  if (queue.length) truncated = true;
  return {
    paths: unique(paths, canonicalVmPath),
    rootsScanned: Array.from(rootsScanned),
    visitedDirectories,
    truncated,
    errors
  };
}

async function queryRunningVmProcesses(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32' || options.skip === true) {
    return { paths: [], processCount: 0, available: false, attempted: false, method: null, errors: [] };
  }

  if (options.output !== undefined) {
    try {
      const snapshot = parsePowerShellProcessSnapshot(options.output);
      return {
        ...snapshot,
        available: true,
        attempted: true,
        method: 'powershell-cim',
        errors: []
      };
    } catch (error) {
      return {
        paths: [], processCount: 0, available: false, attempted: true, method: 'powershell-cim',
        errors: [compactError('running-processes', error, 'INVALID_PROCESS_OUTPUT')]
      };
    }
  }

  const systemRoot = options.env && options.env.SystemRoot || process.env.SystemRoot;
  const powershell = options.powershellPath || (systemRoot
    ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name='vmware-vmx.exe'\" | Select-Object ProcessId, CommandLine)",
    'ConvertTo-Json -InputObject $items -Compress'
  ].join('; ');
  const runner = options.runner || execFileAsync;
  const result = await runner(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command
  ], { timeoutMs: options.timeoutMs || DEFAULT_PROCESS_TIMEOUT_MS });

  if (!result.ok) {
    return {
      paths: [], processCount: 0, available: false, attempted: true, method: 'powershell-cim',
      errors: [compactError('running-processes', result, result.timedOut ? 'TIMEOUT' : 'PROCESS_QUERY_FAILED')]
    };
  }
  try {
    const snapshot = parsePowerShellProcessSnapshot(result.stdout);
    return {
      ...snapshot,
      available: true,
      attempted: true,
      method: 'powershell-cim',
      errors: []
    };
  } catch (error) {
    return {
      paths: [], processCount: 0, available: false, attempted: true, method: 'powershell-cim',
      errors: [compactError('running-processes', error, 'INVALID_PROCESS_OUTPUT')]
    };
  }
}

async function queryVmrunList(vmrunPath, options = {}) {
  if (!vmrunPath || options.skip === true) {
    return { paths: [], available: false, attempted: false, method: null, errors: [] };
  }
  const runner = options.runner || execFileAsync;
  const vmwareTypes = unique(options.vmwareTypes || ['ws', 'player'], value => String(value).toLowerCase());
  const results = await Promise.all(vmwareTypes.map(async vmwareType => {
    const result = await runner(vmrunPath, ['-T', vmwareType, 'list'], {
      timeoutMs: options.timeoutMs || DEFAULT_PROCESS_TIMEOUT_MS
    });
    return { vmwareType, result };
  }));
  const successful = results.filter(item => item.result.ok);
  if (!successful.length) {
    const failure = results[0] && results[0].result || {};
    return {
      paths: [], available: false, attempted: true, method: 'vmrun',
      errors: [compactError('vmrun-list', failure, failure.timedOut ? 'TIMEOUT' : 'VMRUN_LIST_FAILED')]
    };
  }
  return {
    paths: unique(successful.flatMap(item => parseVmrunListOutput(item.result.stdout)), canonicalVmPath),
    available: true,
    attempted: true,
    method: 'vmrun',
    vmwareTypes: successful.map(item => item.vmwareType),
    errors: []
  };
}

async function mapLimit(items, concurrency, mapper) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, worker));
  return output;
}

async function hydrateVm(vm, options = {}) {
  let available = false;
  try {
    available = await isFile(vm.vmxPath);
    if (!available) return { ...vm, available: false };
    const metadata = parseVmxMetadata(await readFilePrefix(vm.vmxPath, options.maxFileBytes));
    return {
      ...vm,
      id: stableVmId(vm.vmxPath, metadata.vmwareUuid) || vm.id,
      name: metadata.displayName || vm.name,
      guestOS: metadata.guestOS || vm.guestOS,
      vmwareUuid: metadata.vmwareUuid || '',
      available: true
    };
  } catch (_error) {
    return { ...vm, available };
  }
}

function buildStatus(platform, vms, capabilities, errors) {
  if (platform !== 'win32') {
    return { code: 'unsupported', message: 'VM Protect discovery currently supports Windows hosts.' };
  }
  if (!vms.length) {
    return errors.length
      ? { code: 'partial', message: 'VM discovery finished with errors and did not find any VMware virtual machines.' }
      : { code: 'empty', message: 'No VMware virtual machines were found in the running list, VMware inventory, or common VM folders.' };
  }
  if (errors.length) {
    return { code: 'partial', message: `Found ${vms.length} virtual machine${vms.length === 1 ? '' : 's'}, but one or more discovery sources failed.` };
  }
  if (!capabilities.vmrunAvailable) {
    return {
      code: 'limited',
      message: `Found ${vms.length} virtual machine${vms.length === 1 ? '' : 's'}. Automatic guest-helper delivery needs VMware vmrun/VIX or a one-time manual copy.`
    };
  }
  return { code: 'ready', message: `Found ${vms.length} virtual machine${vms.length === 1 ? '' : 's'}.` };
}

async function discoverVMs(options = {}) {
  const startedAt = Date.now();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform !== 'win32') {
    const capabilities = {
      platform,
      supported: false,
      vmrunAvailable: false,
      vmrunPath: null,
      runningVmDetection: false,
      runningDetectionMethods: [],
      canAttemptGuestOperations: false,
      canAttemptDirectHelperPush: false,
      guestOperationsRequireCredentials: true,
      guestRequiresVmwareTools: true,
      directVmdkBrowsing: false,
      inventoryDiscovery: false,
      boundedCommonRootScan: false
    };
    return {
      status: buildStatus(platform, [], capabilities, []),
      capabilities,
      vms: [],
      sources: { inventoryFiles: [], scannedRoots: [], scanTruncated: false },
      errors: [],
      discoveredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt
    };
  }

  const inventoryFiles = options.inventoryFiles !== undefined
    ? options.inventoryFiles
    : getInventoryFileCandidates(env);
  const roots = options.scanCommonRoots === false
    ? []
    : options.commonRoots !== undefined
      ? options.commonRoots
      : getCommonVmRoots(env);

  const vmrunPromise = options.vmrunPath !== undefined
    ? Promise.resolve({ path: options.vmrunPath || null, source: options.vmrunPath ? 'provided' : null, searched: 0 })
    : findVmrun({ ...options, platform, env });
  const processPromise = options.runningVmxPaths !== undefined
    ? Promise.resolve({
      paths: options.runningVmxPaths.map(item => normalizeVmxPath(item)).filter(Boolean),
      processCount: options.runningVmxPaths.length,
      available: true,
      attempted: false,
      method: 'provided',
      errors: []
    })
    : queryRunningVmProcesses({
      platform,
      env,
      skip: options.skipRunningDetection,
      output: options.runningProcessOutput,
      runner: options.processRunner,
      powershellPath: options.powershellPath,
      timeoutMs: options.processTimeoutMs
    });
  const inventoryPromise = loadInventoryFiles(inventoryFiles, { env, maxFileBytes: options.maxFileBytes });
  const scanPromise = roots.length
    ? scanVmRoots(roots, options.scanLimits || {})
    : Promise.resolve({ paths: [], rootsScanned: [], visitedDirectories: 0, truncated: false, errors: [] });

  const [vmrun, processResult, inventoryResult, scanResult] = await Promise.all([
    vmrunPromise, processPromise, inventoryPromise, scanPromise
  ]);
  const vmrunResult = options.runningVmxPaths !== undefined
    ? { paths: [], available: false, attempted: false, method: null, errors: [] }
    : await queryVmrunList(vmrun.path, {
      skip: options.skipRunningDetection,
      runner: options.vmrunRunner,
      timeoutMs: options.processTimeoutMs
    });

  const runningPaths = unique([...processResult.paths, ...vmrunResult.paths], canonicalVmPath);
  const candidates = [
    ...runningPaths.map(vmxPath => ({ vmxPath, running: true, source: 'running' })),
    ...inventoryResult.candidates,
    ...scanResult.paths.map(vmxPath => ({ vmxPath, source: 'scan' }))
  ];
  const normalized = normalizeVmCandidates(candidates);
  const hiddenRunningProcesses = Math.max(0, Number(processResult.processCount || 0) - processResult.paths.length);
  let lockFallbackUsed = false;
  const vms = await mapLimit(normalized, options.metadataConcurrency || 12, async vm => {
    let resolved = vm;
    if (!vm.running && options.detectVmxLocks !== false && hiddenRunningProcesses > 0 && await hasVmxRuntimeLock(vm.vmxPath)) {
      lockFallbackUsed = true;
      resolved = {
        ...vm,
        running: true,
        source: 'running',
        sources: unique(['running', ...(vm.sources || [])])
      };
    }
    return hydrateVm(resolved, options);
  });
  const errors = [...processResult.errors, ...vmrunResult.errors, ...inventoryResult.errors, ...scanResult.errors];
  const runningDetectionMethods = unique([
    processResult.available && processResult.method,
    vmrunResult.available && vmrunResult.method,
    lockFallbackUsed && 'vmx-lock'
  ]);
  const capabilities = {
    platform,
    supported: true,
    vmrunAvailable: !!vmrun.path,
    vmrunPath: vmrun.path,
    vmrunSource: vmrun.source,
    runningVmDetection: runningDetectionMethods.length > 0,
    runningDetectionMethods,
    canAttemptGuestOperations: !!vmrun.path,
    canAttemptDirectHelperPush: !!vmrun.path,
    guestOperationsRequireCredentials: true,
    guestRequiresVmwareTools: true,
    directVmdkBrowsing: false,
    inventoryDiscovery: true,
    boundedCommonRootScan: roots.length > 0
  };

  return {
    status: buildStatus(platform, vms, capabilities, errors),
    capabilities,
    vms,
    sources: {
      inventoryFiles: inventoryResult.filesRead,
      scannedRoots: scanResult.rootsScanned,
      scannedDirectories: scanResult.visitedDirectories,
      scanTruncated: scanResult.truncated
    },
    errors,
    discoveredAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt
  };
}

module.exports = {
  discoverVMs,
  discoverVMwareVMs: discoverVMs,
  findVmrun,
  queryRunningVmProcesses,
  queryVmrunList,
  scanVmRoots,
  loadInventoryFiles,
  getInventoryFileCandidates,
  getCommonVmRoots,
  getPathVmrunCandidates,
  getStandardVmrunCandidates,
  getVmwareRegistryKeys,
  queryRegistryVmrunCandidates,
  parseRegistryInstallPath,
  parseVmwareAssignments,
  parseInventoryText,
  parseVmxMetadata,
  extractVmxPathsFromCommandLine,
  parsePowerShellProcessOutput,
  parsePowerShellProcessSnapshot,
  parseVmrunListOutput,
  hasVmxRuntimeLock,
  normalizeVmxPath,
  canonicalVmPath,
  stableVmId,
  normalizeVmCandidates,
  decodeTextBuffer,
  execFileAsync
};
