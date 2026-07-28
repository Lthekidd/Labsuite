const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULT_ROUTER_ORIGIN = 'http://192.168.100.1';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ROUTER_CREDENTIAL_SERVICE = 'LabSuite.RouterInternet';
const PUBLIC_IP_ENDPOINTS = [
  'https://api.ipify.org?format=json',
  'https://checkip.amazonaws.com/'
];

class RouterInternetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouterInternetError';
    this.code = code;
  }
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function isPrivateIpv6(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

function isPublicIpAddress(value) {
  const normalized = String(value || '').trim();
  const version = net.isIP(normalized);
  if (version === 4) return !isPrivateIpv4(normalized) && !normalized.startsWith('0.');
  if (version === 6) return !isPrivateIpv6(normalized) && normalized !== '::';
  return false;
}

function normalizeRouterOrigin(value = DEFAULT_ROUTER_ORIGIN) {
  const rawValue = String(value || '').trim() || DEFAULT_ROUTER_ORIGIN;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue)
    ? rawValue
    : `http://${rawValue}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch (_) {
    throw new RouterInternetError('INVALID_ROUTER_ADDRESS', 'Enter a valid local router address, such as 192.168.100.1.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search
    || parsed.hash) {
    throw new RouterInternetError('INVALID_ROUTER_ADDRESS', 'Enter only the local HTTP or HTTPS address of the router.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = net.isIP(hostname);
  const isLocalHostname = hostname === 'localhost' || hostname.endsWith('.local');
  if ((ipVersion === 4 && !isPrivateIpv4(hostname))
    || (ipVersion === 6 && !isPrivateIpv6(hostname))
    || (ipVersion === 0 && !isLocalHostname)) {
    throw new RouterInternetError('INVALID_ROUTER_ADDRESS', 'The router address must be on the local/private network.');
  }

  parsed.pathname = '';
  return parsed.origin;
}

function getRouterCredentialAccount(origin) {
  const normalized = normalizeRouterOrigin(origin);
  return `router-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  set(name, value) {
    this.cookies.set(String(name), String(value));
  }

  absorb(setCookieHeaders) {
    for (const header of setCookieHeaders || []) {
      const pair = String(header || '').split(';', 1)[0];
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      this.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  toHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function requestRouter(targetUrl, options = {}, redirectCount = 0) {
  const target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  const transport = target.protocol === 'https:' ? https : http;
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body === undefined || options.body === null ? null : String(options.body);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LabSuite/RouterInternet',
    Accept: 'text/html,application/xhtml+xml,application/javascript,*/*;q=0.8',
    Connection: 'close',
    ...options.headers
  };
  if (options.cookieJar) {
    const cookieHeader = options.cookieJar.toHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;
  }
  if (body !== null) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers,
      rejectUnauthorized: false
    }, response => {
      if (options.cookieJar) options.cookieJar.absorb(response.headers['set-cookie']);

      const chunks = [];
      let receivedBytes = 0;
      response.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_RESPONSE_BYTES) {
          request.destroy(new RouterInternetError('ROUTER_RESPONSE_TOO_LARGE', 'The router returned an unexpectedly large response.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', async () => {
        const statusCode = Number(response.statusCode) || 0;
        const location = response.headers.location;
        if (location && [301, 302, 303, 307, 308].includes(statusCode) && redirectCount < MAX_REDIRECTS) {
          try {
            const redirectTarget = new URL(location, target);
            if (options.allowedOrigin && redirectTarget.origin !== options.allowedOrigin) {
              throw new RouterInternetError('ROUTER_REDIRECT_BLOCKED', 'The router redirected its login to an unexpected address.');
            }
            const redirected = await requestRouter(redirectTarget, {
              ...options,
              method: statusCode === 307 || statusCode === 308 ? method : 'GET',
              body: statusCode === 307 || statusCode === 308 ? body : null
            }, redirectCount + 1);
            resolve(redirected);
          } catch (error) {
            reject(error);
          }
          return;
        }
        resolve({
          statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''),
          url: target.toString()
        });
      });
    });

    request.setTimeout(Number(options.timeoutMs) || REQUEST_TIMEOUT_MS, () => {
      request.destroy(new RouterInternetError('ROUTER_TIMEOUT', 'The router did not respond in time.'));
    });
    request.on('error', error => {
      if (error instanceof RouterInternetError) {
        reject(error);
        return;
      }
      reject(new RouterInternetError(
        'ROUTER_UNREACHABLE',
        `Could not reach the router at ${target.origin}. Check the address and make sure this PC is connected to that network.`
      ));
    });
    if (body !== null) request.write(body);
    request.end();
  });
}

function requestPublicIpEndpoint(endpoint, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const request = https.get(endpoint, {
      headers: {
        'User-Agent': 'LabSuite/RouterInternet',
        Accept: 'application/json,text/plain;q=0.9'
      }
    }, response => {
      const statusCode = Number(response.statusCode) || 0;
      const chunks = [];
      let receivedBytes = 0;
      response.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > 4096) {
          request.destroy(new Error('Public IP response was unexpectedly large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Public IP service returned HTTP ${statusCode || 'error'}.`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Public IP lookup timed out.')));
    request.on('error', reject);
  });
}

function parsePublicIpPayload(payload) {
  const text = String(payload || '').trim();
  let candidate = text;
  if (text.startsWith('{')) {
    try {
      candidate = String(JSON.parse(text)?.ip || '').trim();
    } catch (_) {
      candidate = '';
    }
  }
  if (!isPublicIpAddress(candidate)) throw new Error('Public IP service returned an invalid address.');
  return candidate;
}

async function getPublicIp(options = {}) {
  const endpoints = Array.isArray(options.endpoints) && options.endpoints.length > 0
    ? options.endpoints
    : PUBLIC_IP_ENDPOINTS;
  const requester = options.request || requestPublicIpEndpoint;
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const ip = parsePublicIpPayload(await requester(endpoint));
      return {
        ip,
        version: net.isIP(ip),
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new RouterInternetError(
    'PUBLIC_IP_UNAVAILABLE',
    lastError
      ? 'Could not determine the public IP. Check the internet connection and try again.'
      : 'No public IP service is configured.'
  );
}

function assertSuccessfulResponse(response, message) {
  if (response.statusCode < 200 || response.statusCode >= 400) {
    throw new RouterInternetError('ROUTER_HTTP_ERROR', `${message} (HTTP ${response.statusCode || 'error'}).`);
  }
  return response;
}

function isLoginPage(source = '') {
  const text = String(source || '');
  return /LoginSubmit\s*\(/i.test(text)
    || (/\/login\.cgi/i.test(text) && /txt_(?:UserName|Username|Password)/i.test(text));
}

function cleanToken(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\s"'<>]/g, '')
    .slice(-128);
}

function parseHtmlAttributes(tag = '') {
  const attributes = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attributes;
}

function findHtmlInputValue(source, ids) {
  const wanted = new Set(ids.map(value => String(value).toLowerCase()));
  for (const match of String(source || '').matchAll(/<input\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(match[0]);
    if (wanted.has(String(attributes.id || '').toLowerCase())) return attributes.value || '';
  }
  return '';
}

function parseFunctionParameters(source, functionName) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(source || '').match(new RegExp(`function\\s+${escapedName}\\s*\\(([^)]*)\\)`, 'i'));
  if (!match) return [];
  return match[1].split(',').map(value => value.trim()).filter(Boolean);
}

function extractConstructorArguments(source, constructorName) {
  const text = String(source || '');
  const marker = `new ${constructorName}`;
  const results = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const markerIndex = text.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const openIndex = text.indexOf('(', markerIndex + marker.length);
    if (openIndex < 0) break;

    let quote = '';
    let escaped = false;
    let depth = 1;
    let current = '';
    const values = [];
    let cursor = openIndex + 1;

    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor];
      if (quote) {
        current += character;
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = '';
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        current += character;
        continue;
      }
      if (character === '(' || character === '[' || character === '{') {
        depth += 1;
        current += character;
        continue;
      }
      if (character === ')' || character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) {
          values.push(current.trim());
          break;
        }
        current += character;
        continue;
      }
      if (character === ',' && depth === 1) {
        values.push(current.trim());
        current = '';
        continue;
      }
      current += character;
    }

    if (depth === 0) results.push(values);
    searchFrom = Math.max(cursor + 1, markerIndex + marker.length);
  }
  return results;
}

function decodeJsString(value) {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\' || index === value.length - 1) {
      result += character;
      continue;
    }
    const next = value[index + 1];
    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(value.slice(index + 2, index + 4))) {
      result += String.fromCharCode(parseInt(value.slice(index + 2, index + 4), 16));
      index += 3;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) {
      result += String.fromCharCode(parseInt(value.slice(index + 2, index + 6), 16));
      index += 5;
    } else {
      const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };
      result += Object.prototype.hasOwnProperty.call(simpleEscapes, next) ? simpleEscapes[next] : next;
      index += 1;
    }
  }
  return result;
}

function decodeJsLiteral(token) {
  const trimmed = String(token || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return decodeJsString(trimmed.slice(1, -1));
  }
  if (trimmed === 'null' || trimmed === 'undefined') return '';
  return trimmed;
}

function parseWanPppEntries(infoSource, listSource) {
  const parameters = parseFunctionParameters(infoSource, 'WanPPP');
  if (parameters.length === 0) {
    throw new RouterInternetError('UNSUPPORTED_ROUTER_FIRMWARE', 'This Huawei firmware did not expose the expected WAN format.');
  }

  const calls = extractConstructorArguments(listSource, 'WanPPP');
  const entries = calls.map(values => {
    const entry = {};
    parameters.forEach((parameter, index) => {
      entry[parameter] = decodeJsLiteral(values[index]);
    });
    return entry;
  });
  return entries.filter(entry => Object.values(entry).some(value => String(value || '').trim()));
}

function getEntryValue(entry, ...names) {
  for (const name of names) {
    const key = Object.keys(entry).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    if (key) return String(entry[key] ?? '');
  }
  return '';
}

function selectInternetWan(entries) {
  const pppEntries = entries.filter(entry => {
    const domain = getEntryValue(entry, 'domain');
    const username = getEntryValue(entry, 'Username', 'UserName');
    return /WANPPPConnection\.\d+$/i.test(domain) && username;
  });
  const internetEntries = pppEntries.filter(entry => /INTERNET/i.test(getEntryValue(entry, 'ServiceList', 'X_HW_SERVICELIST')));
  const candidates = internetEntries.length > 0 ? internetEntries : pppEntries;
  if (candidates.length === 0) {
    throw new RouterInternetError('WAN_CONNECTION_NOT_FOUND', 'No editable PPP internet connection was found on this router.');
  }
  if (candidates.length > 1) {
    throw new RouterInternetError('MULTIPLE_WAN_CONNECTIONS', 'More than one PPP internet connection was found, so LabSuite did not change either one.');
  }

  const selected = candidates[0];
  const domain = getEntryValue(selected, 'domain');
  const username = getEntryValue(selected, 'Username', 'UserName');
  const password = getEntryValue(selected, 'Password');
  if (!password) {
    throw new RouterInternetError('WAN_PASSWORD_UNAVAILABLE', 'The router did not expose the existing WAN password token, so LabSuite cannot safely preserve it.');
  }
  return { domain, username, password };
}

function toggleWanUsername(username) {
  const current = String(username || '');
  if (!current) throw new RouterInternetError('WAN_USERNAME_UNAVAILABLE', 'The current WAN username is empty.');
  const next = current.endsWith('9') ? current.slice(0, -1) : `${current}9`;
  if (!next || next.length > 63) {
    throw new RouterInternetError('WAN_USERNAME_INVALID', 'The toggled WAN username would not be valid for this router.');
  }
  return {
    previous: current,
    next,
    action: current.endsWith('9') ? 'removed' : 'added'
  };
}

class HuaweiRouterClient {
  constructor(origin, options = {}) {
    this.origin = normalizeRouterOrigin(origin);
    this.cookieJar = new CookieJar();
    this.cookieJar.set('Cookie', 'body:Language:english:id=-1');
    this.request = options.request || requestRouter;
  }

  url(pathname) {
    return new URL(pathname, `${this.origin}/`);
  }

  async requestPath(pathname, options = {}) {
    return this.request(this.url(pathname), {
      ...options,
      allowedOrigin: this.origin,
      cookieJar: this.cookieJar
    });
  }

  async login(username, password) {
    const cleanUsername = String(username || '').trim();
    const cleanPassword = String(password || '');
    if (!cleanUsername || !cleanPassword) {
      throw new RouterInternetError('ROUTER_CREDENTIALS_REQUIRED', 'Enter the router username and password.');
    }

    const tokenResponse = assertSuccessfulResponse(
      await this.requestPath('/asp/GetRandCount.asp', { method: 'POST', body: '' }),
      'Could not request a login token from the router'
    );
    const token = cleanToken(tokenResponse.body);
    if (!token) {
      throw new RouterInternetError('ROUTER_TOKEN_MISSING', 'The router did not return a login token.');
    }

    const loginBody = new URLSearchParams({
      UserName: cleanUsername,
      PassWord: Buffer.from(cleanPassword, 'utf8').toString('base64'),
      Language: 'english',
      'x.X_HW_Token': token
    }).toString();
    assertSuccessfulResponse(
      await this.requestPath('/login.cgi', {
        method: 'POST',
        body: loginBody,
        headers: {
          Origin: this.origin,
          Referer: `${this.origin}/`
        }
      }),
      'The router login request failed'
    );

    const authCheck = await this.requestPath('/html/ssmp/common/refreshTime.asp');
    if (authCheck.statusCode >= 200 && authCheck.statusCode < 400 && authCheck.body.trim() === '1') {
      return true;
    }

    const wanPage = await this.requestPath('/html/bbsp/wan/wan.asp');
    if (wanPage.statusCode >= 200
      && wanPage.statusCode < 400
      && !isLoginPage(wanPage.body)
      && findHtmlInputValue(wanPage.body, ['hwonttoken', 'onttoken'])) {
      return true;
    }

    throw new RouterInternetError(
      'ROUTER_LOGIN_FAILED',
      'Router login failed. Check the username and password before trying again; this router can temporarily lock login after repeated failures.'
    );
  }

  async loadWanConfiguration() {
    const [wanPage, infoSource, listSource] = await Promise.all([
      this.requestPath('/html/bbsp/wan/wan.asp'),
      this.requestPath('/html/bbsp/common/wan_list_info.asp'),
      this.requestPath('/html/bbsp/common/wan_list.asp')
    ]);
    assertSuccessfulResponse(wanPage, 'Could not open the router WAN page');
    assertSuccessfulResponse(infoSource, 'Could not read the router WAN format');
    assertSuccessfulResponse(listSource, 'Could not read the router WAN connection');
    if (isLoginPage(wanPage.body) || isLoginPage(listSource.body)) {
      throw new RouterInternetError('ROUTER_SESSION_EXPIRED', 'The router session expired before the WAN connection could be changed.');
    }

    let token = findHtmlInputValue(wanPage.body, ['hwonttoken', 'onttoken']);
    if (!token) {
      const indexPage = await this.requestPath('/index.asp');
      token = findHtmlInputValue(indexPage.body, ['hwonttoken', 'onttoken']);
    }
    token = cleanToken(token);
    if (!token) {
      throw new RouterInternetError('ROUTER_TOKEN_MISSING', 'The WAN page did not provide an update token.');
    }

    const entries = parseWanPppEntries(infoSource.body, listSource.body);
    return {
      token,
      selected: selectInternetWan(entries)
    };
  }

  async restartInternet() {
    const configuration = await this.loadWanConfiguration();
    const toggle = toggleWanUsername(configuration.selected.username);
    const domain = configuration.selected.domain;
    if (!/^InternetGatewayDevice\.WANDevice\.\d+\.WANConnectionDevice\.\d+\.WANPPPConnection\.\d+$/i.test(domain)) {
      throw new RouterInternetError('WAN_CONNECTION_INVALID', 'The router returned an invalid WAN connection path.');
    }

    const requestPath = `/html/bbsp/wan/complex.cgi?${new URLSearchParams({
      y: domain,
      RequestFile: 'html/bbsp/wan/confirmwancfginfo.html'
    }).toString()}`;
    const body = new URLSearchParams({
      'y.Username': toggle.next,
      'y.Password': configuration.selected.password,
      'x.X_HW_Token': configuration.token
    }).toString();
    const response = await this.requestPath(requestPath, {
      method: 'POST',
      body,
      headers: {
        Origin: this.origin,
        Referer: `${this.origin}/html/bbsp/wan/wan.asp`
      }
    });
    if (isLoginPage(response.body)) {
      throw new RouterInternetError('ROUTER_SESSION_EXPIRED', 'The router session expired while applying the WAN update.');
    }

    let selectedAfterUpdate;
    try {
      const updatedList = assertSuccessfulResponse(
        await this.requestPath('/html/bbsp/common/wan_list.asp'),
        'Could not verify the WAN update'
      );
      const infoSource = assertSuccessfulResponse(
        await this.requestPath('/html/bbsp/common/wan_list_info.asp'),
        'Could not verify the WAN format'
      );
      selectedAfterUpdate = selectInternetWan(parseWanPppEntries(infoSource.body, updatedList.body));
    } catch (verificationError) {
      if (response.statusCode < 200 || response.statusCode >= 400) {
        throw new RouterInternetError(
          'WAN_UPDATE_UNVERIFIED',
          `The router returned HTTP ${response.statusCode || 'error'} and LabSuite could not verify whether the WAN username changed.`
        );
      }
      throw verificationError;
    }

    if (selectedAfterUpdate.username !== toggle.next) {
      if (response.statusCode < 200 || response.statusCode >= 400) {
        throw new RouterInternetError(
          'ROUTER_HTTP_ERROR',
          `The router rejected the WAN update (HTTP ${response.statusCode || 'error'}).`
        );
      }
      throw new RouterInternetError('WAN_UPDATE_NOT_APPLIED', 'The router responded, but the WAN username did not change.');
    }

    return {
      success: true,
      action: toggle.action,
      reconnecting: true
    };
  }
}

async function restartInternet({ routerUrl, username, password }) {
  const client = new HuaweiRouterClient(routerUrl);
  await client.login(username, password);
  return client.restartInternet();
}

module.exports = {
  DEFAULT_ROUTER_ORIGIN,
  ROUTER_CREDENTIAL_SERVICE,
  RouterInternetError,
  HuaweiRouterClient,
  normalizeRouterOrigin,
  getRouterCredentialAccount,
  parseWanPppEntries,
  selectInternetWan,
  toggleWanUsername,
  parsePublicIpPayload,
  getPublicIp,
  restartInternet
};
