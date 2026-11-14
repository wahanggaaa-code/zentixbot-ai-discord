// Login to the dashboard with DASHBOARD_TOKEN: a form, one secret from the environment, and the
// account in OWNER_IDS as the one the dashboard acts for. No Discord login is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { mountDashboard } from '../src/dashboard/router.js';
import http from 'node:http';
import { linkToken, loginFormPage, tokenLoginStatus, tokenMatches, tokenOffMessage, TOKEN_MIN_LENGTH, TOKEN_SESSION_MS } from '../src/dashboard/tokenLogin.js';
import { dashboardLoginStatus } from '../src/dashboard/origin.js';
import { describeDashboard } from '../src/utils/startupReport.js';
import { createWebRateLimit, webRateLimitBucket } from '../src/utils/webRateLimit.js';
import { logger } from '../src/utils/logger.js';

const home = '123456789012345678';
const ownerId = '323456789012345678';
const TOKEN = 'correct-horse-battery';
const TOKEN_ENV = { DASHBOARD_TOKEN: TOKEN, OWNER_IDS: ownerId };
const DISCORD_ENV = { CLIENT_ID: '456789012345678901', DISCORD_CLIENT_SECRET: 'secret', DASHBOARD_URL: 'https://bot.example.com' };

/** The web server as src/app.js builds it, with a Discord client whose server has the given members. */
async function site(t, { env = TOKEN_ENV, members = { [ownerId]: { admin: false } }, ready = true, serverOwner = '999999999999999999' } = {}) {
    const fetched = [];
    const guild = {
        id: home, name: 'Home', ownerId: serverOwner,
        members: {
            fetch: async ({ user }) => {
                fetched.push(user);
                if (!members[user]) throw new Error('Unknown Member');
                return { id: user, user: { id: user, username: 'operator', globalName: members[user].name ?? null }, permissions: { has: (flag) => members[user].admin && flag === PermissionFlagsBits.Administrator } };
            },
        },
    };
    const client = { homeGuildId: home, isReady: () => ready, guilds: { cache: new Map([[home, guild]]) } };
    const discordCalls = [];
    const fetchImpl = async (url) => { discordCalls.push(String(url)); return { ok: true, json: async () => (String(url).endsWith('/token') ? { access_token: 'mock', expires_in: 3600 } : { id: ownerId, username: 'tester' }) }; };
    const warnings = [], infos = [];
    t.mock.method(logger, 'warn', (message) => { warnings.push(String(message)); });
    t.mock.method(logger, 'info', (message) => { infos.push(String(message)); });
    const app = express();
    app.use(createWebRateLimit());
    mountDashboard(app, client, { fetchImpl, env });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    const submit = (token, headers = { origin: base }) => req('/dashboard/login', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ token }),
    });
    const login = async () => {
        const response = await submit(TOKEN);
        assert.equal(response.status, 303);
        return response.headers.getSetCookie().find((line) => line.startsWith('zx_session=')).split(';')[0];
    };
    return { req, submit, login, base, warnings, infos, fetched, discordCalls, members };
}

// ---------------------------------------------------------------------------------------------
// When the token login is on
// ---------------------------------------------------------------------------------------------

test('the token login needs a token of at least 12 characters and a Discord user ID in OWNER_IDS', () => {
    assert.equal(TOKEN_MIN_LENGTH, 12);
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: '123456789012', OWNER_IDS: ownerId }), { enabled: true, reason: null, ownerId });
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: '  123456789012  ', OWNER_IDS: ` abc, ${ownerId} ,423456789012345678` }), { enabled: true, reason: null, ownerId }, 'the first ID that is one');
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: '12345678901', OWNER_IDS: ownerId }), { enabled: false, reason: 'too_short', ownerId });
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: '   12345678901   ', OWNER_IDS: ownerId }), { enabled: false, reason: 'too_short', ownerId }, 'spaces around it do not count');
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: TOKEN }), { enabled: false, reason: 'no_owner', ownerId: null });
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: TOKEN, OWNER_IDS: 'your_discord_id_here (optional)' }), { enabled: false, reason: 'no_owner', ownerId: null });
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: TOKEN, OWNER_IDS: '1234567890123456' }), { enabled: false, reason: 'no_owner', ownerId: null }, '16 digits are not an ID');
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: '', OWNER_IDS: ownerId }), { enabled: false, reason: 'missing', ownerId });
    assert.deepEqual(tokenLoginStatus({ DASHBOARD_TOKEN: '   ' }), { enabled: false, reason: 'missing', ownerId: null });
    assert.deepEqual(tokenLoginStatus({}), { enabled: false, reason: 'missing', ownerId: null });
    assert.deepEqual(tokenLoginStatus(undefined), { enabled: false, reason: 'missing', ownerId: null });
    assert.equal(JSON.stringify(tokenLoginStatus(TOKEN_ENV)).includes(TOKEN), false, 'the status can be logged');
});

test('only the exact token matches', () => {
    assert.equal(tokenMatches(TOKEN, TOKEN_ENV), true);
    assert.equal(tokenMatches(`  ${TOKEN}\n`, TOKEN_ENV), true, 'spaces from copying are ignored');
    assert.equal(tokenMatches(TOKEN, { DASHBOARD_TOKEN: ` ${TOKEN} ` }), true);
    for (const wrong of [TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), '', ' ', undefined, null, 42, [TOKEN], { token: TOKEN }]) {
        assert.equal(tokenMatches(wrong, TOKEN_ENV), false, JSON.stringify(wrong));
    }
    assert.equal(tokenMatches('short', { DASHBOARD_TOKEN: 'short' }), false, 'a token too short to be accepted matches nothing');
    assert.equal(tokenMatches('', { DASHBOARD_TOKEN: '' }), false);
    assert.equal(tokenMatches('', {}), false);
    assert.equal(tokenMatches(TOKEN, undefined), false);
});

test('the login page has one password field, and offers Discord only when that login is configured', () => {
    const page = loginFormPage();
    assert.match(page, /<form method="post" action="\/dashboard\/login">/);
    assert.match(page, /<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>/);
    assert.equal(page.includes('role="alert"'), false);
    assert.equal(page.includes('via=discord'), false);
    assert.match(loginFormPage({ discord: true }), /<a href="\/dashboard\/login\?via=discord">Masuk dengan akun Discord<\/a>/);
    assert.match(loginFormPage({ error: 'Token salah.' }), /<p class="error" role="alert">Token salah\.<\/p>/);
    assert.match(loginFormPage({ error: '<script>alert(1)</script>' }), /<p class="error" role="alert">&#60;script&#62;alert\(1\)&#60;\/script&#62;<\/p>/);

    assert.match(tokenOffMessage('too_short'), /DASHBOARD_TOKEN harus minimal 12 karakter/);
    assert.match(tokenOffMessage('no_owner'), /isi OWNER_IDS dengan ID akun Discord kamu/);
    assert.match(tokenOffMessage('missing'), /isi DASHBOARD_TOKEN dan OWNER_IDS/);
});

test('the startup summary says which login the dashboard has', () => {
    const discord = (env) => dashboardLoginStatus(env, home);
    const on = { enabled: true, reason: null };
    assert.equal(describeDashboard(discord({}), on), '/dashboard/ on the web port, login with DASHBOARD_TOKEN');
    assert.equal(describeDashboard(discord({ DASHBOARD_URL: 'http://203.0.113.5:11991', DASHBOARD_ALLOW_HTTP: 'true' }), on), 'http://203.0.113.5:11991/dashboard/ (plain HTTP), login with DASHBOARD_TOKEN');
    assert.equal(describeDashboard(discord(DISCORD_ENV), on), 'https://bot.example.com/dashboard/, login with DASHBOARD_TOKEN or Discord');
    assert.equal(describeDashboard(discord(DISCORD_ENV), { enabled: false, reason: 'missing' }), 'https://bot.example.com/dashboard/');
    assert.equal(describeDashboard(discord(DISCORD_ENV), { enabled: false, reason: 'too_short' }), 'https://bot.example.com/dashboard/; token login off: DASHBOARD_TOKEN is shorter than 12 characters');
    assert.equal(describeDashboard(discord(DISCORD_ENV), { enabled: false, reason: 'no_owner' }), 'https://bot.example.com/dashboard/; token login off: DASHBOARD_TOKEN needs a Discord user ID in OWNER_IDS');
    assert.equal(describeDashboard(discord({}), { enabled: false, reason: 'no_owner' }), 'login off: DASHBOARD_TOKEN needs a Discord user ID in OWNER_IDS');
    assert.equal(describeDashboard(discord({}), { enabled: false, reason: 'too_short' }), 'login off: DASHBOARD_TOKEN is shorter than 12 characters');
    assert.equal(describeDashboard(discord({}), { enabled: false, reason: 'missing' }), 'login off: DASHBOARD_URL is not set');
});

// ---------------------------------------------------------------------------------------------
// Logging in
// ---------------------------------------------------------------------------------------------

test('with only DASHBOARD_TOKEN and OWNER_IDS set, the right token opens the dashboard', async (t) => {
    const { req, submit, base, warnings, infos, discordCalls } = await site(t, { members: { [ownerId]: { admin: false, name: 'Angga' } } });

    const bare = await req('/dashboard');
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get('location'), '/dashboard/');
    const closed = await req('/dashboard/');
    assert.equal(closed.status, 302);
    assert.equal(closed.headers.get('location'), '/dashboard/login', 'not back to /dashboard/ itself');
    assert.equal((await req('/dashboard/api/me')).status, 401);

    const page = await req('/dashboard/login');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /name="token" type="password"/);
    assert.equal(html.includes('via=discord'), false, 'Discord is not offered when it is not configured');
    assert.equal(html.includes(TOKEN), false);

    const response = await submit(TOKEN);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard/');
    const setCookie = response.headers.getSetCookie().find((line) => line.startsWith('zx_session='));
    assert.match(setCookie, /^zx_session=[0-9a-f]{64}; Max-Age=43200; Path=\/dashboard; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
    const cookie = setCookie.split(';')[0];

    // The page itself opens, at the address the login sends the browser to.
    const index = await req('/dashboard/', { headers: { cookie } });
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<script[^>]+src="session\.js"/);
    assert.equal((await req('/dashboard/index.html', { headers: { cookie } })).status, 200);
    assert.equal((await req('/dashboard/session.js', { headers: { cookie } })).status, 200);
    assert.equal((await req('/dashboard', { headers: { cookie } })).headers.get('location'), '/dashboard/');
    assert.equal((await req('/DASHBOARD', { headers: { cookie } })).headers.get('location'), '/dashboard/');

    // The session is the account in OWNER_IDS; it counts as the bot owner without being an administrator.
    const me = await (await req('/dashboard/api/me', { headers: { cookie } })).json();
    assert.deepEqual(me.user, { id: ownerId, username: 'Angga' });
    assert.deepEqual(me.guild, { id: home, name: 'Home' });
    assert.equal(me.botOwner, true);
    assert.match(me.csrf, /^[0-9a-f]{64}$/);

    assert.deepEqual(discordCalls, [], 'no request to Discord\'s OAuth endpoints');
    assert.deepEqual(infos.filter((line) => line.startsWith('Dashboard:')), [`Dashboard: token login from 127.0.0.1, acting as ${ownerId}`]);
    assert.deepEqual(warnings, ['Dashboard: token login is on without an https address in DASHBOARD_URL. Over plain HTTP the token and the login session are not encrypted in transit.']);
    assert.equal([...warnings, ...infos].join('\n').includes(TOKEN), false, 'the token is never logged');

    // Changes are accepted from the dashboard's own pages only, and logging out ends the session.
    const logout = (headers) => req('/dashboard/api/logout', { method: 'POST', headers: { cookie, ...headers } });
    assert.equal((await logout({ origin: 'http://evil.example', 'x-csrf-token': me.csrf })).status, 403);
    assert.equal((await logout({ 'x-csrf-token': me.csrf })).status, 403, 'no Origin header');
    assert.equal((await logout({ origin: 'not a url', 'x-csrf-token': me.csrf })).status, 403);
    assert.equal((await logout({ origin: base, 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await req('/dashboard/api/me', { headers: { cookie } })).status, 200, 'refused logouts leave the session');
    assert.equal((await logout({ origin: base, 'x-csrf-token': me.csrf })).status, 200);
    assert.equal((await req('/dashboard/api/me', { headers: { cookie } })).status, 401);
});

test('a token session lasts 12 hours', async (t) => {
    assert.equal(TOKEN_SESSION_MS, 12 * 60 * 60 * 1000);
    const { req, login } = await site(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const cookie = await login();
    t.mock.timers.tick(TOKEN_SESSION_MS - 1000);
    assert.equal((await req('/dashboard/api/me', { headers: { cookie } })).status, 200);
    t.mock.timers.tick(2000);
    assert.equal((await req('/dashboard/api/me', { headers: { cookie } })).status, 401);
    assert.equal((await req('/dashboard/', { headers: { cookie } })).status, 302);
});

test('a wrong token is refused, logged without its value, and leaves no session', async (t) => {
    const { req, submit, warnings, fetched } = await site(t);
    for (const wrong of ['wrong-token-value', TOKEN.slice(0, -1), `${TOKEN}x`, '']) {
        const response = await submit(wrong);
        assert.equal(response.status, 401, JSON.stringify(wrong));
        assert.equal(response.headers.getSetCookie().length, 0);
        const html = await response.text();
        assert.match(html, /<p class="error" role="alert">Token salah\.<\/p>/);
        assert.match(html, /name="token" type="password"/, 'the form is shown again');
        assert.equal(html.includes('wrong-token-value'), false);
    }
    const noField = await req('/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'other=1' });
    assert.equal(noField.status, 401);
    const json = await req('/dashboard/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(json.status, 401, 'only a form post is read');

    assert.deepEqual(fetched, [], 'Discord is not asked about the account before the token is right');
    assert.equal(warnings.filter((line) => line === 'Dashboard: token login refused for 127.0.0.1 (wrong token)').length, 6);
    assert.equal(warnings.join('\n').includes('wrong-token-value'), false);
});

test('repeated attempts run into the login limit', async (t) => {
    const { submit } = await site(t);
    const statuses = [];
    for (let attempt = 1; attempt <= 32; attempt += 1) statuses.push((await submit(`guess-number-${attempt}`)).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(401));
    assert.deepEqual(statuses.slice(30), [429, 429]);
    assert.equal((await submit(TOKEN)).status, 429, 'also the right token has to wait');
});

test('a login posted from another site is refused', async (t) => {
    const { submit, base } = await site(t);
    const foreign = await submit(TOKEN, { origin: 'http://evil.example' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.getSetCookie().length, 0);
    assert.match(await foreign.text(), /Permintaan tidak valid\. Buka halaman login ini langsung dari alamat dashboard\./);
    assert.equal((await submit(TOKEN, { origin: 'garbage' })).status, 403);
    assert.equal((await submit(TOKEN, { origin: base.replace('127.0.0.1', 'localhost') })).status, 403, 'another name for the same server is another site');
    assert.equal((await submit(TOKEN, {})).status, 303, 'a client that sends no Origin (curl) is let through; the token is the proof');
});

test('with DASHBOARD_URL set, logins and changes are accepted from that address only', async (t) => {
    const { submit, req, base } = await site(t, { env: { ...TOKEN_ENV, DASHBOARD_URL: 'http://203.0.113.5:11991', DASHBOARD_ALLOW_HTTP: 'true' } });
    const elsewhere = await submit(TOKEN, { origin: base });
    assert.equal(elsewhere.status, 403);
    assert.match(await elsewhere.text(), /Login hanya diterima dari http:\/\/203\.0\.113\.5:11991\/dashboard\/login\. Buka alamat itu, atau sesuaikan DASHBOARD_URL/);

    const response = await submit(TOKEN, { origin: 'http://203.0.113.5:11991' });
    assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith('zx_session=')).split(';')[0];
    const me = await (await req('/dashboard/api/me', { headers: { cookie } })).json();
    const logout = (origin) => req('/dashboard/api/logout', { method: 'POST', headers: { cookie, origin, 'x-csrf-token': me.csrf } });
    assert.equal((await logout(base)).status, 403, 'the address the request went to is not enough once DASHBOARD_URL is set');
    assert.equal((await logout('http://203.0.113.5:11991')).status, 200);
});

test('an https DASHBOARD_URL makes the session cookie Secure and silences the warning', async (t) => {
    const { submit, warnings } = await site(t, { env: { ...TOKEN_ENV, DASHBOARD_URL: 'https://bot.example.com' } });
    const response = await submit(TOKEN, { origin: 'https://bot.example.com' });
    assert.equal(response.status, 303);
    assert.match(response.headers.getSetCookie().find((line) => line.startsWith('zx_session=')), /; Secure; /);
    assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------------------------
// Login by link
// ---------------------------------------------------------------------------------------------

test('the token of a login link is everything after /masuk/', () => {
    assert.equal(linkToken('/my-token-123456'), 'my-token-123456');
    assert.equal(linkToken('/p%40ss%2Fw%20ord%2B12345'), 'p@ss/w ord+12345');
    assert.equal(linkToken('/part/after/slashes'), 'part/after/slashes');
    assert.equal(linkToken('/token/'), 'token/', 'a closing slash is part of what was sent');
    assert.equal(linkToken('/%ZZbroken'), '%ZZbroken', 'broken encoding is kept as it stands');
    for (const none of ['/', '', undefined, null]) assert.equal(linkToken(none), null, JSON.stringify(none));
});

test('login links are counted as login attempts, in both spellings', () => {
    for (const path of ['/masuk/abc', '/MASUK/abc', '/masuk', '/masuk/', '/dashboard/masuk/abc', '/Dashboard/Masuk/abc/def', '/dashboard/masuk']) {
        assert.equal(webRateLimitBucket(path), 'login', path);
    }
    assert.equal(webRateLimitBucket('/masukan'), 'general');
    assert.equal(webRateLimitBucket('/dashboard/masukan'), 'dashboard');
    assert.equal(webRateLimitBucket('/x/masuk/abc'), 'general');
});

test('opening /masuk/<token> or /dashboard/masuk/<token> logs in and goes on to the dashboard', async (t) => {
    const { req, infos, warnings } = await site(t);
    for (const path of [`/masuk/${TOKEN}`, `/dashboard/masuk/${TOKEN}`, `/MASUK/${TOKEN}`]) {
        const response = await req(path);
        assert.equal(response.status, 303, path);
        assert.equal(response.headers.get('location'), '/dashboard/');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        assert.equal((await response.text()).includes(TOKEN), false, 'the answer does not repeat the token');
        const setCookie = response.headers.getSetCookie().find((line) => line.startsWith('zx_session='));
        assert.match(setCookie, /^zx_session=[0-9a-f]{64}; Max-Age=43200; Path=\/dashboard; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
        const cookie = setCookie.split(';')[0];
        assert.equal((await req('/dashboard/', { headers: { cookie } })).status, 200);
        const me = await (await req('/dashboard/api/me', { headers: { cookie } })).json();
        assert.deepEqual(me.user, { id: ownerId, username: 'operator' });
        assert.equal(me.botOwner, true);
    }
    assert.deepEqual(infos.filter((line) => line.startsWith('Dashboard:')), Array(3).fill(`Dashboard: token login by link from 127.0.0.1, acting as ${ownerId}`));
    assert.equal([...infos, ...warnings].join('\n').includes(TOKEN), false, 'the token is never logged');
});

test('a link with a wrong token shows the login page and opens nothing', async (t) => {
    const { req, warnings, fetched } = await site(t);
    for (const path of ['/masuk/wrong-token-value', `/masuk/${TOKEN}x`, `/masuk/${TOKEN}/`, `/dashboard/masuk/${TOKEN.slice(0, -1)}`, '/masuk/%ZZ', `/masuk/${TOKEN}/extra`]) {
        const response = await req(path);
        assert.equal(response.status, 401, path);
        assert.equal(response.headers.getSetCookie().length, 0, path);
        const html = await response.text();
        assert.match(html, /<p class="error" role="alert">Token di tautan tidak cocok\. Periksa tautannya, atau ketik token di bawah ini\.<\/p>/);
        assert.match(html, /name="token" type="password"/);
        assert.equal(html.includes('wrong-token-value') || html.includes(TOKEN.slice(0, -1)), false, 'what was sent is not shown');
    }
    assert.deepEqual(fetched, []);
    assert.deepEqual(warnings.slice(1), Array(6).fill('Dashboard: token login refused for 127.0.0.1 (wrong token in a login link)'));

    // A link without a token leads to the login page; only opening a link logs in, posting to it does not.
    for (const path of ['/masuk', '/masuk/', '/dashboard/masuk', '/dashboard/masuk/']) {
        const response = await req(path);
        assert.equal(response.status, 302, path);
        assert.equal(response.headers.get('location'), '/dashboard/login');
    }
    const posted = await req(`/masuk/${TOKEN}`, { method: 'POST' });
    assert.equal(posted.status, 404);
    assert.equal(posted.headers.getSetCookie().length, 0);
});

test('a token with special characters works in a link when it is percent-encoded', async (t) => {
    const special = 'p@ss/w ord+12345?#&=';
    const { req } = await site(t, { env: { DASHBOARD_TOKEN: special, OWNER_IDS: ownerId } });
    assert.equal((await req(`/masuk/${encodeURIComponent(special)}`)).status, 303);
    assert.equal((await req(`/dashboard/masuk/${encodeURIComponent(special)}`)).status, 303);
    assert.equal((await req(`/masuk/${special}`)).status, 401, 'unencoded, the browser cuts the address at "?" and "#"');
});

test('links share the login limit with the form', async (t) => {
    const { req, submit } = await site(t);
    const statuses = [];
    for (let attempt = 1; attempt <= 10; attempt += 1) statuses.push((await req(`/masuk/guess-number-${attempt}`)).status);
    for (let attempt = 11; attempt <= 20; attempt += 1) statuses.push((await req(`/dashboard/masuk/guess-number-${attempt}`)).status);
    for (let attempt = 21; attempt <= 30; attempt += 1) statuses.push((await submit(`guess-number-${attempt}`)).status);
    assert.deepEqual(statuses, Array(30).fill(401));
    for (const path of [`/masuk/${TOKEN}`, `/dashboard/masuk/${TOKEN}`]) {
        const refused = await req(path);
        assert.equal(refused.status, 429, path);
        assert.equal(refused.headers.getSetCookie().length, 0);
        assert.match(await refused.text(), /^Terlalu banyak percobaan login dari alamat ini\./);
    }
});

test('a link does nothing while the token login is off, and follows DASHBOARD_URL when that is set', async (t) => {
    for (const [env, text] of [
        [DISCORD_ENV, /^Login dengan token belum aktif: isi DASHBOARD_TOKEN dan OWNER_IDS\.$/],
        [{ DASHBOARD_TOKEN: 'short', OWNER_IDS: ownerId }, /DASHBOARD_TOKEN harus minimal 12 karakter/],
        [{ DASHBOARD_TOKEN: TOKEN }, /isi OWNER_IDS dengan ID akun Discord kamu/],
    ]) {
        const { req } = await site(t, { env });
        for (const path of [`/masuk/${env.DASHBOARD_TOKEN ?? TOKEN}`, `/dashboard/masuk/${env.DASHBOARD_TOKEN ?? TOKEN}`]) {
            const response = await req(path);
            assert.equal(response.status, 503, path);
            assert.equal(response.headers.getSetCookie().length, 0);
            assert.match(await response.text(), text);
        }
    }

    // With DASHBOARD_URL set, the link has to be opened at that address. The address the browser
    // used arrives in the Host header; fetch cannot set it, node:http can.
    const { base } = await site(t, { env: { ...TOKEN_ENV, DASHBOARD_URL: 'http://203.0.113.5:11991', DASHBOARD_ALLOW_HTTP: 'true' } });
    const open = (host) => new Promise((resolve, reject) => {
        http.get(`${base}/masuk/${TOKEN}`, { headers: { host } }, (res) => {
            let body = ''; res.on('data', (chunk) => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, cookies: res.headers['set-cookie'] ?? [], body }));
        }).on('error', reject);
    });
    const elsewhere = await open(new URL(base).host);
    assert.equal(elsewhere.status, 403);
    assert.deepEqual(elsewhere.cookies, []);
    assert.match(elsewhere.body, /Login hanya diterima dari http:\/\/203\.0\.113\.5:11991\/dashboard\/login\./);
    assert.equal((await open('203.0.113.5:11992')).status, 403, 'another port is another address');
    const right = await open('203.0.113.5:11991');
    assert.equal(right.status, 303);
    assert.equal(right.cookies.length, 1);
});

test('through a link, too, the account in OWNER_IDS has to be a member of the server', async (t) => {
    const { req } = await site(t, { members: {} });
    const response = await req(`/masuk/${TOKEN}`);
    assert.equal(response.status, 403);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.match(await response.text(), new RegExp(`Akun di OWNER_IDS \\(${ownerId}\\) bukan anggota server yang dikonfigurasi`));
});

// ---------------------------------------------------------------------------------------------
// The account the dashboard acts for
// ---------------------------------------------------------------------------------------------

test('the account in OWNER_IDS has to be a member of the server, and the login page says so', async (t) => {
    const { submit, req, warnings, members } = await site(t, { members: {} });
    const response = await submit(TOKEN);
    assert.equal(response.status, 403);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.match(await response.text(), new RegExp(`Akun di OWNER_IDS \\(${ownerId}\\) bukan anggota server yang dikonfigurasi, atau keanggotaannya tidak dapat diperiksa\\.`));
    assert.ok(warnings.includes('Dashboard: token login could not be completed (Keanggotaan atau izin server tidak dapat diverifikasi.)'));

    // A session ends as soon as the account leaves the server.
    members[ownerId] = { admin: false };
    const ok = await submit(TOKEN);
    assert.equal(ok.status, 303);
    const cookie = ok.headers.getSetCookie().find((line) => line.startsWith('zx_session=')).split(';')[0];
    assert.equal((await req('/dashboard/api/me', { headers: { cookie } })).status, 200);
    delete members[ownerId];
    assert.equal((await req('/dashboard/api/me', { headers: { cookie } })).status, 403);
});

test('while the bot is not connected to Discord the login page says so', async (t) => {
    const { submit } = await site(t, { ready: false });
    const response = await submit(TOKEN);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /<p class="error" role="alert">Bot belum siap memverifikasi server\.<\/p>/);
});

// ---------------------------------------------------------------------------------------------
// Together with, and without, the Discord login
// ---------------------------------------------------------------------------------------------

test('with both logins configured the page offers Discord, and each way gives its own kind of session', async (t) => {
    // The Discord account here is the same person, but not an administrator.
    const { req, submit, discordCalls } = await site(t, { env: { ...TOKEN_ENV, ...DISCORD_ENV } });
    const page = await req('/dashboard/login');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<a href="\/dashboard\/login\?via=discord">/);

    const start = await req('/dashboard/login?via=discord');
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get('location'));
    assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://bot.example.com/dashboard/callback');
    const stateCookie = start.headers.getSetCookie()[0].split(';')[0];

    // Through Discord the account still has to be owner or administrator of the server.
    const callback = await req(`/dashboard/callback?code=mock&state=${authorize.searchParams.get('state')}`, { headers: { cookie: stateCookie } });
    assert.equal(callback.status, 403);
    assert.equal(await callback.text(), 'Akses hanya untuk owner atau administrator server.');
    assert.equal(discordCalls.length, 2);

    // Through the token the same account gets in.
    assert.equal((await submit(TOKEN, { origin: 'https://bot.example.com' })).status, 303);
});

test('without DASHBOARD_TOKEN nothing changes: the login goes to Discord and a posted token is refused', async (t) => {
    const { req, submit, warnings } = await site(t, { env: DISCORD_ENV });
    const start = await req('/dashboard/login');
    assert.equal(start.status, 302);
    assert.match(start.headers.get('location'), /^https:\/\/discord\.com\/oauth2\/authorize\?/);
    const response = await submit(TOKEN, { origin: 'https://bot.example.com' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.match(await response.text(), /^Login dengan token belum aktif: isi DASHBOARD_TOKEN dan OWNER_IDS\.$/);
    assert.equal((await submit('', { origin: 'https://bot.example.com' })).status, 503, 'an empty token does not match an unset one');
    assert.deepEqual(warnings, []);
});

test('a token that cannot be used keeps the login off and the page says what to fix', async (t) => {
    for (const [env, text, warning] of [
        [{ DASHBOARD_TOKEN: 'short' }, /^Login dengan token belum aktif: DASHBOARD_TOKEN harus minimal 12 karakter\.$/, 'Dashboard: DASHBOARD_TOKEN is set but the token login is off (the token is shorter than 12 characters).'],
        [{ DASHBOARD_TOKEN: 'short', OWNER_IDS: ownerId }, /^Login dengan token belum aktif: DASHBOARD_TOKEN harus minimal 12 karakter\.$/, 'Dashboard: DASHBOARD_TOKEN is set but the token login is off (the token is shorter than 12 characters).'],
        [{ DASHBOARD_TOKEN: TOKEN }, /^Login dengan token belum aktif: isi OWNER_IDS dengan ID akun Discord kamu/, 'Dashboard: DASHBOARD_TOKEN is set but the token login is off (OWNER_IDS holds no Discord user ID).'],
    ]) {
        const { req, submit, warnings } = await site(t, { env });
        for (const path of ['/dashboard/', '/dashboard/login']) {
            const response = await req(path);
            assert.equal(response.status, 503, path);
            assert.match(await response.text(), text, path);
        }
        const posted = await submit(env.DASHBOARD_TOKEN);
        assert.equal(posted.status, 503);
        assert.equal(posted.headers.getSetCookie().length, 0);
        assert.deepEqual(warnings, [warning]);
    }

    // With nothing set at all, the page points at the token login first.
    const { req } = await site(t, { env: {} });
    for (const path of ['/dashboard/', '/dashboard/login']) {
        const response = await req(path);
        assert.equal(response.status, 503);
        assert.match(await response.text(), /^Login belum dikonfigurasi\. Cara termudah: isi DASHBOARD_TOKEN \(minimal 12 karakter\) dan OWNER_IDS, lalu restart bot\./);
    }
});
