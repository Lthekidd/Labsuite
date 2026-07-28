const assert = require('assert');
const http = require('http');
const {
  HuaweiRouterClient,
  getPublicIp,
  normalizeRouterOrigin,
  parsePublicIpPayload,
  parseWanPppEntries,
  selectInternetWan,
  toggleWanUsername
} = require('../main/routerInternet');

const ROUTER_USERNAME = 'root';
const ROUTER_PASSWORD = 'router-secret';
const LOGIN_TOKEN = '7e00f0f1defa0bbc49472cfc5b5d7367';
const WAN_TOKEN = 'd74a6e97724542c39e867512aa9bfc34';
const WAN_PASSWORD_TOKEN = '4f8224e09511627bd85daa3dea225ed3fb3be608f8f103df4d061ae7bf508065';
const WAN_DOMAIN = 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1';

function readRequestBody(request) {
  return new Promise(resolve => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    ...headers
  });
  response.end(body);
}

async function run() {
  assert.strictEqual(normalizeRouterOrigin('192.168.100.1'), 'http://192.168.100.1');
  assert.throws(
    () => normalizeRouterOrigin('https://example.com'),
    error => error?.code === 'INVALID_ROUTER_ADDRESS'
  );
  assert.deepStrictEqual(toggleWanUsername('test2009'), {
    previous: 'test2009',
    next: 'test200',
    action: 'removed'
  });
  assert.deepStrictEqual(toggleWanUsername('test200'), {
    previous: 'test200',
    next: 'test2009',
    action: 'added'
  });
  assert.strictEqual(parsePublicIpPayload('{"ip":"203.0.113.10"}'), '203.0.113.10');
  assert.strictEqual(parsePublicIpPayload('2001:db8::1\n'), '2001:db8::1');
  assert.throws(() => parsePublicIpPayload('192.168.100.1'), /invalid address/i);
  let publicIpAttempts = 0;
  const publicIpResult = await getPublicIp({
    endpoints: ['first', 'second'],
    request: async endpoint => {
      publicIpAttempts += 1;
      if (endpoint === 'first') throw new Error('Provider unavailable');
      return '{"ip":"203.0.113.10"}';
    }
  });
  assert.strictEqual(publicIpAttempts, 2);
  assert.strictEqual(publicIpResult.ip, '203.0.113.10');
  assert.strictEqual(publicIpResult.version, 4);

  const infoSource = 'function WanPPP(domain,ConnectionTrigger,ServiceList,Username,Password) {}';
  const listSource = `var PPPWanList = new Array(new WanPPP("${WAN_DOMAIN}","AlwaysOn","TR069_INET\\x45RNET","test2009","${WAN_PASSWORD_TOKEN}"),null);`;
  const parsed = selectInternetWan(parseWanPppEntries(infoSource, listSource));
  assert.strictEqual(parsed.domain, WAN_DOMAIN);
  assert.strictEqual(parsed.username, 'test2009');
  assert.strictEqual(parsed.password, WAN_PASSWORD_TOKEN);

  let wanUsername = 'test2009';
  let loginRequests = 0;
  let updateRequests = 0;
  let passwordWasPreserved = true;

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    const cookie = String(request.headers.cookie || '');
    const isAuthenticated = cookie.includes('Cookie=session-ok');

    if (request.method === 'POST' && requestUrl.pathname === '/asp/GetRandCount.asp') {
      send(response, 200, `\uFEFF${LOGIN_TOKEN}`);
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/login.cgi') {
      loginRequests += 1;
      const params = new URLSearchParams(await readRequestBody(request));
      const password = Buffer.from(params.get('PassWord') || '', 'base64').toString('utf8');
      if (params.get('UserName') === ROUTER_USERNAME
        && password === ROUTER_PASSWORD
        && params.get('x.X_HW_Token') === LOGIN_TOKEN) {
        send(response, 200, '<html>authenticated</html>', {
          'Set-Cookie': 'Cookie=session-ok; Path=/; HttpOnly'
        });
      } else {
        send(response, 200, '<script>function LoginSubmit(){}</script><form action="/login.cgi"><input id="txt_Username"></form>');
      }
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/html/ssmp/common/refreshTime.asp') {
      send(response, 200, isAuthenticated ? '1' : '0');
      return;
    }

    if (!isAuthenticated) {
      send(response, 200, '<script>function LoginSubmit(){}</script><form action="/login.cgi"><input id="txt_Username"></form>');
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/html/bbsp/wan/wan.asp') {
      send(response, 200, `<input type="hidden" name="onttoken" id="hwonttoken" value="${WAN_TOKEN}">`);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/html/bbsp/common/wan_list_info.asp') {
      send(response, 200, infoSource);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/html/bbsp/common/wan_list.asp') {
      send(
        response,
        200,
        `var PPPWanList = new Array(new WanPPP("${WAN_DOMAIN}","AlwaysOn","TR069_INTERNET","${wanUsername}","${WAN_PASSWORD_TOKEN}"),null);`
      );
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/html/bbsp/wan/complex.cgi') {
      updateRequests += 1;
      const params = new URLSearchParams(await readRequestBody(request));
      assert.strictEqual(requestUrl.searchParams.get('y'), WAN_DOMAIN);
      assert.strictEqual(params.get('x.X_HW_Token'), WAN_TOKEN);
      if (params.get('y.Password') !== WAN_PASSWORD_TOKEN) passwordWasPreserved = false;
      wanUsername = params.get('y.Username');
      // This HG8245H5 firmware applies the update and then returns HTTP 404
      // because its configured confirmation page is absent.
      send(response, 404, '<html>Confirmation page not found</html>');
      return;
    }

    send(response, 404, 'Not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const routerUrl = `http://127.0.0.1:${address.port}`;
    const client = new HuaweiRouterClient(routerUrl);
    await client.login(ROUTER_USERNAME, ROUTER_PASSWORD);

    const first = await client.restartInternet();
    assert.strictEqual(first.action, 'removed');
    assert.strictEqual(wanUsername, 'test200');

    const second = await client.restartInternet();
    assert.strictEqual(second.action, 'added');
    assert.strictEqual(wanUsername, 'test2009');

    const invalidClient = new HuaweiRouterClient(routerUrl);
    await assert.rejects(
      () => invalidClient.login(ROUTER_USERNAME, 'wrong-password'),
      error => error?.code === 'ROUTER_LOGIN_FAILED'
    );

    assert.strictEqual(loginRequests, 2);
    assert.strictEqual(updateRequests, 2);
    assert.strictEqual(passwordWasPreserved, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('Router internet verification passed (login, password preservation, and alternating WAN username).');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
