import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { resolveWebPort, DEFAULT_WEB_PORT, WEB_PORT_VARIABLES } from '../src/utils/webPort.js';
import { resolveDashboardOrigin, httpAllowed } from '../src/dashboard/origin.js';
import { createDashboardRouter } from '../src/dashboard/router.js';
import { logger } from '../src/utils/logger.js';

// ---- port -------------------------------------------------------------------

test('the web port is the first usable one of WEB_PORT, PORT and SERVER_PORT', () => {
    assert.deepEqual([...WEB_PORT_VARIABLES], ['WEB_PORT', 'PORT', 'SERVER_PORT']);
    const port = (env) => resolveWebPort(env);

    assert.deepEqual(port({}), { port: DEFAULT_WEB_PORT, source: null, ignored: [] });
    assert.equal(DEFAULT_WEB_PORT, 3000);
    // What a Pterodactyl-style panel sets by itself is enough.
    assert.deepEqual(port({ SERVER_PORT: '16954' }), { port: 16954, source: 'SERVER_PORT', ignored: [] });
    assert.deepEqual(port({ PORT: '8080', SERVER_PORT: '16954' }), { port: 8080, source: 'PORT', ignored: [] });
    assert.deepEqual(port({ WEB_PORT: '7000', PORT: '8080', SERVER_PORT: '16954' }), { port: 7000, source: 'WEB_PORT', ignored: [] });
    assert.deepEqual(port({ PORT: ' 8080 ' }), { port: 8080, source: 'PORT', ignored: [] });
    assert.deepEqual(port({ PORT: '1' }).port, 1);
    assert.deepEqual(port({ PORT: '65535' }).port, 65535);
});

test('empty and 0 mean "not set"; anything else that is not a port is skipped and named', () => {
    assert.deepEqual(resolveWebPort({ WEB_PORT: '', PORT: '0', SERVER_PORT: '16954' }), { port: 16954, source: 'SERVER_PORT', ignored: [] });
    assert.deepEqual(resolveWebPort({ PORT: 'abc', SERVER_PORT: '16954' }), { port: 16954, source: 'SERVER_PORT', ignored: ['PORT'] });
    for (const bad of ['65536', '99999', '-1', '80.5', '1e3', '0x50', '80 80', '123456']) {
        assert.deepEqual(resolveWebPort({ PORT: bad }), { port: 3000, source: null, ignored: ['PORT'] }, bad);
    }
    assert.deepEqual(resolveWebPort({ WEB_PORT: 'x', PORT: 'y', SERVER_PORT: 'z' }).ignored, ['WEB_PORT', 'PORT', 'SERVER_PORT']);
    assert.deepEqual(resolveWebPort(undefined).port > 0, true);
});

test('the application config and the web server both take the port from that rule', async () => {
    const saved = Object.fromEntries(WEB_PORT_VARIABLES.map((name) => [name, process.env[name]]));
    try {
        delete process.env.WEB_PORT;
        delete process.env.PORT;
        process.env.SERVER_PORT = '16954';
        const { default: config } = await import(`../src/config/application.js?port=${Date.now()}`);
        assert.equal(config.api.port, 16954);
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
    const { readFile } = await import('node:fs/promises');
    const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
    assert.match(app, /port: configuredPort[^\n]*= resolveWebPort\(process\.env\)/);
    assert.doesNotMatch(app, /process\.env\.PORT\b/);
});

// ---- dashboard address --------------------------------------------------------

const PUBLIC_HTTP = 'http://203.0.113.5:16954';

test('plain HTTP on a public address needs the explicit switch', () => {
    const read = (env) => resolveDashboardOrigin(env);
    assert.deepEqual(read({ DASHBOARD_URL: 'https://bot.example.com' }), { origin: 'https://bot.example.com', insecure: false, reason: null });
    assert.deepEqual(read({ DASHBOARD_URL: 'http://localhost:3000' }), { origin: 'http://localhost:3000', insecure: false, reason: null });
    assert.deepEqual(read({ DASHBOARD_URL: 'http://127.0.0.1:3000/' }), { origin: 'http://127.0.0.1:3000', insecure: false, reason: null });

    assert.deepEqual(read({ DASHBOARD_URL: PUBLIC_HTTP }), { origin: null, insecure: false, reason: 'http_not_allowed' });
    for (const off of [undefined, '', 'false', '0', 'yes', 'on', 'truee']) {
        assert.equal(read({ DASHBOARD_URL: PUBLIC_HTTP, DASHBOARD_ALLOW_HTTP: off }).origin, null, String(off));
        assert.equal(httpAllowed({ DASHBOARD_ALLOW_HTTP: off }), false);
    }
    for (const on of ['true', 'TRUE', ' true ', '1']) {
        assert.deepEqual(read({ DASHBOARD_URL: PUBLIC_HTTP, DASHBOARD_ALLOW_HTTP: on }), { origin: PUBLIC_HTTP, insecure: true, reason: null }, on);
    }
    // The switch does not make an encrypted or local address "insecure".
    assert.equal(read({ DASHBOARD_URL: 'https://bot.example.com', DASHBOARD_ALLOW_HTTP: 'true' }).insecure, false);
    assert.equal(read({ DASHBOARD_URL: 'http://localhost:3000', DASHBOARD_ALLOW_HTTP: 'true' }).insecure, false);
});

test('the switch accepts an address only: no path, query, credentials or other scheme', () => {
    const env = (url) => ({ DASHBOARD_URL: url, DASHBOARD_ALLOW_HTTP: 'true' });
    assert.deepEqual(resolveDashboardOrigin({}), { origin: null, insecure: false, reason: 'missing' });
    assert.deepEqual(resolveDashboardOrigin({ DASHBOARD_URL: '   ' }), { origin: null, insecure: false, reason: 'missing' });
    for (const bad of [
        '203.0.113.5:16954', 'not a url', `${PUBLIC_HTTP}/dashboard`, `${PUBLIC_HTTP}/?x=1`, `${PUBLIC_HTTP}/#x`,
        'http://user:pass@203.0.113.5:16954', 'ftp://203.0.113.5', 'javascript:alert(1)', 'https://bot.example.com/panel',
    ]) {
        assert.deepEqual(resolveDashboardOrigin(env(bad)), { origin: null, insecure: false, reason: 'malformed' }, bad);
    }
});

// ---- login over HTTP ----------------------------------------------------------

const home = '123456789012345678';
const userId = '323456789012345678';
const clientId = '456789012345678901';

async function dashboard(t, env) {
    const warnings = [];
    t.mock.method(logger, 'warn', (message) => warnings.push(String(message)));
    const guild = {
        id: home, name: 'Home', ownerId: '999999999999999999',
        members: { fetch: async () => ({ permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator } }) },
    };
    const client = { homeGuildId: home, isReady: () => true, guilds: { cache: new Map([[home, guild]]) } };
    const exchanged = [];
    const fetchImpl = async (url, options = {}) => {
        if (String(url).endsWith('/token')) exchanged.push(Object.fromEntries(options.body));
        return { ok: true, json: async () => (String(url).endsWith('/token') ? { access_token: 'mock', expires_in: 3600 } : { id: userId, username: 'tester' }) };
    };
    const app = express();
    app.use('/dashboard', createDashboardRouter(client, { fetchImpl, env: { CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: 'secret', ...env } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    const login = async () => {
        const start = await req('/dashboard/login');
        if (start.status !== 302) return { start };
        const stateCookie = start.headers.get('set-cookie');
        const authorize = new URL(start.headers.get('location'));
        const callback = await req(`/dashboard/callback?code=mock&state=${authorize.searchParams.get('state')}`, { headers: { cookie: stateCookie.split(';')[0] } });
        const sessionCookie = callback.headers.getSetCookie().find((line) => line.startsWith('zx_session=')) ?? null;
        return { start, stateCookie, authorize, callback, sessionCookie, session: sessionCookie?.split(';')[0] };
    };
    return { req, login, warnings, exchanged };
}

test('without the switch a public http address has no login, and the page says why', async (t) => {
    const site = await dashboard(t, { DASHBOARD_URL: PUBLIC_HTTP });
    for (const path of ['/dashboard/login', '/dashboard/']) {
        const response = await site.req(path);
        assert.equal(response.status, 503, path);
        const body = await response.text();
        assert.match(body, /DASHBOARD_URL memakai http:\/\/ pada alamat publik/);
        assert.match(body, /DASHBOARD_ALLOW_HTTP=true/);
        assert.match(body, /tidak terenkripsi/);
    }
    assert.equal((await site.req('/dashboard/api/me')).status, 401);
    assert.deepEqual(site.warnings, []);
});

test('other configuration faults get their own explanation', async (t) => {
    const malformed = await dashboard(t, { DASHBOARD_URL: `${PUBLIC_HTTP}/dashboard`, DASHBOARD_ALLOW_HTTP: 'true' });
    assert.match(await (await malformed.req('/dashboard/login')).text(), /harus berupa alamat saja/);
    const missing = await dashboard(t, {});
    assert.match(await (await missing.req('/dashboard/login')).text(), /Atur CLIENT_ID, DISCORD_CLIENT_SECRET, DASHBOARD_URL dan GUILD_ID/);
    // A usable address with another setting missing is not blamed on the address.
    const noSecret = await dashboard(t, { DASHBOARD_URL: PUBLIC_HTTP, DASHBOARD_ALLOW_HTTP: 'true', DISCORD_CLIENT_SECRET: '' });
    const response = await noSecret.req('/dashboard/login');
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Atur CLIENT_ID, DISCORD_CLIENT_SECRET, DASHBOARD_URL dan GUILD_ID/);
});

test('with the switch, Discord login works at http://ip:port and the risk is logged', async (t) => {
    const site = await dashboard(t, { DASHBOARD_URL: PUBLIC_HTTP, DASHBOARD_ALLOW_HTTP: 'true' });
    assert.equal(site.warnings.length, 1);
    assert.match(site.warnings[0], /plain HTTP at http:\/\/203\.0\.113\.5:16954 \(DASHBOARD_ALLOW_HTTP\)\. Login sessions are not encrypted/);

    const { start, stateCookie, authorize, callback, sessionCookie, session } = await site.login();
    assert.equal(start.status, 302);
    assert.equal(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC_HTTP}/dashboard/callback`);
    assert.equal(authorize.searchParams.get('scope'), 'identify');
    assert.equal(callback.status, 302);
    assert.deepEqual(site.exchanged.map((body) => body.redirect_uri), [`${PUBLIC_HTTP}/dashboard/callback`]);

    // A browser drops Secure cookies on http, so they must not be marked Secure here; the rest stays.
    for (const line of [stateCookie, sessionCookie]) {
        assert.doesNotMatch(line, /;\s*Secure/i);
        assert.match(line, /;\s*HttpOnly/i);
        assert.match(line, /;\s*SameSite=Lax/i);
        assert.match(line, /;\s*Path=\/dashboard/i);
    }

    assert.equal((await site.req('/dashboard/', { headers: { cookie: session } })).status, 200);
    const me = await (await site.req('/dashboard/api/me', { headers: { cookie: session } })).json();
    const logout = (origin, token = me.csrf) => site.req('/dashboard/api/logout', { method: 'POST', headers: { cookie: session, origin, 'x-csrf-token': token } });
    // Requests are still tied to this exact address and to the session's token.
    assert.equal((await logout('http://203.0.113.5:9999')).status, 403);
    assert.equal((await logout('https://203.0.113.5:16954')).status, 403);
    assert.equal((await logout(PUBLIC_HTTP, 'wrong')).status, 403);
    assert.equal((await logout(PUBLIC_HTTP)).status, 200);
    assert.equal((await site.req('/dashboard/api/me', { headers: { cookie: session } })).status, 401);
});

test('an https address keeps Secure cookies and logs no warning, switch or not', async (t) => {
    for (const extra of [{}, { DASHBOARD_ALLOW_HTTP: 'true' }]) {
        const site = await dashboard(t, { DASHBOARD_URL: 'https://bot.example.com', ...extra });
        const { stateCookie, sessionCookie, authorize } = await site.login();
        assert.equal(authorize.searchParams.get('redirect_uri'), 'https://bot.example.com/dashboard/callback');
        for (const line of [stateCookie, sessionCookie]) assert.match(line, /;\s*Secure/i);
        assert.deepEqual(site.warnings, []);
    }
});
