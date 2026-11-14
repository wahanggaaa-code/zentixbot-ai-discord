import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { JSDOM } from 'jsdom';
import { PermissionFlagsBits } from 'discord.js';
import { createSettingsApi, hostingConfigured } from '../src/dashboard/settingsApi.js';
import { createDashboardRouter } from '../src/dashboard/router.js';

const guildId = '123456789012345678';
const ownerId = '223456789012345678';
const adminId = '323456789012345678';
const botId = '523456789012345678';
const clientId = '456789012345678901';
const SECRET = 'ptlc_do-not-leak';

const permissionSet = (...names) => {
    const granted = new Set(names.map((name) => PermissionFlagsBits[name]));
    return { has: (flag) => granted.has(flag) };
};
const role = (id, name, position, permissions = permissionSet(), managed = false) => ({
    id, name, position, permissions, managed,
});

/** Fake bot client and guild; `options` change what Discord and the database report. */
function createFixture(options = {}) {
    const roles = options.roles ?? [
        role('600000000000000001', 'Founder', 9, permissionSet('Administrator')),
        role('600000000000000002', '<b>Staff</b>', 5, permissionSet('Administrator')),
        role('600000000000000003', 'ZentixBot', 4, permissionSet('Administrator'), true),
        role('600000000000000004', 'Member', 1),
    ];
    const botPermissions = options.botPermissions ?? permissionSet(
        'ViewChannel', 'SendMessages', 'EmbedLinks', 'ManageChannels', 'MoveMembers', 'Connect',
    );
    const guild = {
        id: guildId,
        name: 'Home <i>Server</i>',
        memberCount: 1234,
        ownerId,
        roles: { cache: new Map(roles.map((r) => [r.id, r])) },
        members: {
            me: options.noBotMember ? null : { permissions: botPermissions, roles: { highest: roles[2] ?? null } },
            fetch: async ({ user }) => ({
                id: user,
                permissions: permissionSet(...(user === adminId ? ['Administrator'] : [])),
            }),
        },
    };
    const database = options.database ?? { connectionType: 'postgresql', isDegraded: false, available: true };
    const client = {
        homeGuildId: guildId,
        user: { id: botId },
        uptime: 3 * 3_600_000 + 5 * 60_000,
        ws: { ping: 41.6 },
        isReady: () => options.ready ?? true,
        guilds: { cache: new Map([[guildId, guild]]) },
        db: {
            getStatus: () => ({ connectionType: database.connectionType, isDegraded: database.isDegraded }),
            isAvailable: () => database.available,
        },
    };
    return { client, guild };
}

async function serve(t, fixture, { userId = adminId, env = {} } = {}) {
    const auth = (req, res, next) => {
        if (req.get('x-auth') !== 'yes') return res.sendStatus(401);
        req.guild = fixture.guild;
        req.session = { user: { id: userId, username: 'Rina' }, expires: 1_900_000_000_000 };
        req.member = { permissions: permissionSet(...(userId === adminId ? ['Administrator'] : [])) };
        next();
    };
    const app = express();
    app.use('/test', createSettingsApi(fixture.client, { auth, env }));
    const oauth = async (url) => ({
        ok: true,
        json: async () => (String(url).endsWith('/token')
            ? { access_token: 'mock', expires_in: 3600 }
            : { id: adminId, username: 'tester' }),
    });
    app.use('/dashboard', createDashboardRouter(fixture.client, {
        fetchImpl: oauth,
        env: { CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: 'fake', DASHBOARD_URL: 'http://localhost:9999', ...env },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const get = (path = '', headers = { 'x-auth': 'yes' }) => fetch(`${baseUrl}/test/control-center${path}`, { headers });
    return { baseUrl, get };
}

const hostingEnv = {
    HOSTING_PANEL_URL: 'https://panel.example.com',
    HOSTING_SERVER_ID: 'abc123',
    HOSTING_API_KEY: SECRET,
};

// ---- API --------------------------------------------------------------------

test('the control center reports Discord, storage and access as they are now', async (t) => {
    const fixture = createFixture();
    const { get } = await serve(t, fixture, { env: { DASHBOARD_URL: 'https://dash.example.com/', OWNER_IDS: ownerId } });
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();

    assert.deepEqual(data.discord.guild, { id: guildId, name: 'Home <i>Server</i>', memberCount: 1234, ownerId });
    assert.equal(data.discord.bot.ready, true);
    assert.equal(data.discord.bot.ping, 42);
    assert.equal(data.discord.bot.uptimeMs, 11_100_000);
    assert.deepEqual(data.discord.bot.highestRole, { id: '600000000000000003', name: 'ZentixBot', rolesAbove: 2 });

    const granted = Object.fromEntries(data.discord.bot.permissions.items.map((item) => [item.key, item.granted]));
    assert.equal(data.discord.bot.permissions.administrator, false);
    assert.equal(granted.ManageChannels, true);
    assert.equal(granted.ManageRoles, false);
    assert.equal(granted.BanMembers, false);
    assert.equal(Object.keys(granted).length, 14);

    assert.deepEqual(data.storage, { backend: 'postgresql', status: 'connected' });
    assert.deepEqual(data.access.user, { id: adminId, username: 'Rina' });
    assert.equal(data.access.isGuildOwner, false);
    assert.equal(data.access.isAdministrator, true);
    assert.equal(data.access.isBotOwner, false);
    assert.equal(data.access.sessionExpiresAt, 1_900_000_000_000);
    // Highest role first; the bot's own role is marked as not belonging to people.
    assert.deepEqual(data.access.adminRoles, [
        { id: '600000000000000001', name: 'Founder', managed: false },
        { id: '600000000000000002', name: '<b>Staff</b>', managed: false },
        { id: '600000000000000003', name: 'ZentixBot', managed: true },
    ]);
    assert.equal(data.access.adminRolesTruncated, false);
    assert.deepEqual(data.dashboard, { origin: 'https://dash.example.com', sessionStore: 'process', insecureHttp: false });
    assert.ok(Math.abs(data.readAt - Date.now()) < 5000);
});

test('the control center says when the dashboard is served over plain HTTP on a public address', async (t) => {
    const address = 'http://203.0.113.5:16954';
    const read = async (env) => (await (await (await serve(t, createFixture(), { env })).get()).json()).dashboard.insecureHttp;
    assert.equal(await read({ DASHBOARD_URL: address, DASHBOARD_ALLOW_HTTP: 'true' }), true);
    // Without the switch there is no login at that address at all, so nothing is served unencrypted.
    assert.equal(await read({ DASHBOARD_URL: address }), false);
    assert.equal(await read({ DASHBOARD_URL: 'http://localhost:9999', DASHBOARD_ALLOW_HTTP: 'true' }), false);
    assert.equal(await read({ DASHBOARD_URL: 'https://dash.example.com', DASHBOARD_ALLOW_HTTP: 'true' }), false);
});

test('without DASHBOARD_URL (token login) the request itself tells whether the dashboard is on plain HTTP', async (t) => {
    // The address the browser used arrives in the Host header; fetch cannot set it, node:http can.
    const read = async (env, host) => {
        const { baseUrl } = await serve(t, createFixture(), { env });
        const body = await new Promise((resolve, reject) => {
            http.get(`${baseUrl}/test/control-center`, { headers: { 'x-auth': 'yes', host } }, (res) => {
                let text = ''; res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve(text));
            }).on('error', reject);
        });
        return JSON.parse(body).dashboard;
    };
    assert.deepEqual(await read({}, '203.0.113.5:11991'), { origin: null, sessionStore: 'process', insecureHttp: true });
    assert.equal((await read({}, 'bot.example.com')).insecureHttp, true);
    assert.equal((await read({}, 'localhost:3000')).insecureHttp, false);
    assert.equal((await read({}, '127.0.0.1:3000')).insecureHttp, false);
    // An unusable DASHBOARD_URL counts as none; a usable one decides by itself.
    assert.equal((await read({ DASHBOARD_URL: 'http://203.0.113.5:11991' }, '203.0.113.5:11991')).insecureHttp, true);
    assert.equal((await read({ DASHBOARD_URL: 'https://dash.example.com' }, '203.0.113.5:11991')).insecureHttp, false);
});

test('an Administrator bot is reported as holding every checked permission', async (t) => {
    const { get } = await serve(t, createFixture({ botPermissions: permissionSet('Administrator') }));
    const { bot } = (await (await get()).json()).discord;
    assert.equal(bot.permissions.administrator, true);
    assert.equal(bot.permissions.items.every((item) => item.granted), true);
});

test('what cannot be read is reported as unknown, not as fine', async (t) => {
    const fixture = createFixture({ noBotMember: true, ready: false });
    fixture.client.ws.ping = -1;
    fixture.client.uptime = null;
    fixture.guild.memberCount = undefined;
    const { get } = await serve(t, fixture);
    const { discord } = await (await get()).json();
    assert.equal(discord.bot.ready, false);
    assert.equal(discord.bot.ping, null);
    assert.equal(discord.bot.uptimeMs, null);
    assert.equal(discord.bot.permissions, null);
    assert.equal(discord.bot.highestRole, null);
    assert.equal(discord.guild.memberCount, null);
});

test('storage status separates connected, fallback and unavailable', async (t) => {
    const cases = [
        [{ connectionType: 'postgresql', isDegraded: false, available: true }, { backend: 'postgresql', status: 'connected' }],
        [{ connectionType: 'postgresql', isDegraded: false, available: false }, { backend: 'postgresql', status: 'unavailable' }],
        [{ connectionType: 'memory', isDegraded: true, available: false }, { backend: 'memory', status: 'degraded' }],
        [{ connectionType: 'sqlite', isDegraded: false, available: true }, { backend: 'sqlite', status: 'connected' }],
        [{ connectionType: 'none', isDegraded: false, available: false }, { backend: 'none', status: 'unavailable' }],
        [{ connectionType: 'mystery', isDegraded: false, available: true }, { backend: 'unknown', status: 'connected' }],
    ];
    for (const [database, expected] of cases) {
        const { get } = await serve(t, createFixture({ database }));
        assert.deepEqual((await (await get()).json()).storage, expected, JSON.stringify(database));
    }
});

test('hosting configuration is owner-only and never exposes its values', async (t) => {
    const env = { ...hostingEnv, OWNER_IDS: `${ownerId}, not-an-id` };

    const asAdmin = await serve(t, createFixture(), { env });
    const adminText = await (await asAdmin.get()).text();
    assert.equal(JSON.parse(adminText).hosting.configured, null);
    assert.equal(JSON.parse(adminText).access.isBotOwner, false);

    const asOwner = await serve(t, createFixture(), { env, userId: ownerId });
    const ownerText = await (await asOwner.get()).text();
    const owner = JSON.parse(ownerText);
    assert.equal(owner.hosting.configured, true);
    assert.equal(owner.access.isBotOwner, true);
    assert.equal(owner.access.isGuildOwner, true);
    assert.equal(owner.access.isAdministrator, false);

    for (const body of [adminText, ownerText]) {
        assert.doesNotMatch(body, new RegExp(SECRET));
        assert.doesNotMatch(body, /panel\.example\.com|abc123/);
    }

    const unconfigured = await serve(t, createFixture(), { env: { OWNER_IDS: ownerId }, userId: ownerId });
    assert.equal((await (await unconfigured.get()).json()).hosting.configured, false);
});

test('hosting counts as configured only with a plain https panel, an ID and a key', () => {
    assert.equal(hostingConfigured(hostingEnv), true);
    const broken = [
        { ...hostingEnv, HOSTING_PANEL_URL: 'http://panel.example.com' },
        { ...hostingEnv, HOSTING_PANEL_URL: 'https://user:pw@panel.example.com' },
        { ...hostingEnv, HOSTING_PANEL_URL: 'https://panel.example.com/path' },
        { ...hostingEnv, HOSTING_PANEL_URL: 'not a url' },
        { ...hostingEnv, HOSTING_PANEL_URL: undefined },
        { ...hostingEnv, HOSTING_SERVER_ID: 'has space' },
        { ...hostingEnv, HOSTING_SERVER_ID: '' },
        { ...hostingEnv, HOSTING_API_KEY: '' },
    ];
    for (const env of broken) assert.equal(hostingConfigured(env), false, JSON.stringify(env));
});

test('long role lists are cut and say so; the endpoint is read-only and needs a login', async (t) => {
    const many = Array.from({ length: 60 }, (_, i) => role(
        String(600000000000000100n + BigInt(i)), `Admin ${i}`, 100 - i, permissionSet('Administrator'),
    ));
    const { get, baseUrl } = await serve(t, createFixture({ roles: many }));
    const { access } = await (await get()).json();
    assert.equal(access.adminRoles.length, 50);
    assert.equal(access.adminRolesTruncated, true);
    assert.equal(access.adminRoles[0].name, 'Admin 0');

    assert.equal((await get('?x=1')).status, 400);
    assert.equal((await get('', { 'x-auth': 'no' })).status, 401);
    for (const method of ['POST', 'PATCH', 'DELETE']) {
        const response = await fetch(`${baseUrl}/test/control-center`, { method, headers: { 'x-auth': 'yes' } });
        assert.equal(response.status, 404, method);
    }
    // Behind the real router: no session, no data.
    assert.equal((await fetch(`${baseUrl}/dashboard/api/bot/control-center`)).status, 401);
});

test('the real router serves the control center to a logged-in administrator', async (t) => {
    const { baseUrl } = await serve(t, createFixture());
    const request = (path, options = {}) => fetch(baseUrl + path, { redirect: 'manual', ...options });
    const start = await request('/dashboard/login');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/dashboard/callback?code=mock&state=${state}`, { headers: { cookie: stateCookie } });
    const cookie = callback.headers.getSetCookie().find((x) => x.startsWith('zx_session=')).split(';')[0];

    const response = await request('/dashboard/api/bot/control-center', { headers: { cookie } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.access.user.id, adminId);
    assert.equal(data.access.isAdministrator, true);
    assert.ok(data.access.sessionExpiresAt > Date.now());
    assert.equal(data.dashboard.origin, 'http://localhost:9999');
});

// ---- Page -------------------------------------------------------------------

const html = fs.readFileSync('dashboard-preview/index.html', 'utf8').replace(/<script src=".*?"><\/script>/g, '');
const scripts = [
    'session.js', 'live.js', 'goodbye-live.js', 'birthday-live.js', 'core-live.js', 'giveaway-live.js',
    'modules-live.js', 'operations-live.js', 'settings-live.js', 'features.js', 'ai-studio.js', 'app.js',
];
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
const ok = (data) => ({ ok: true, json: async () => data });
const failed = (error) => ({ ok: false, json: async () => ({ error }) });

const sample = (overrides = {}) => ({
    readAt: 1_800_000_000_000,
    discord: {
        guild: { id: guildId, name: '<img src=x onerror=1>', memberCount: 1234, ownerId },
        bot: {
            id: botId, ready: true, ping: 42, uptimeMs: 11_100_000,
            permissions: {
                administrator: false,
                items: [
                    { key: 'SendMessages', label: 'Mengirim pesan', usedBy: 'welcome', granted: true },
                    { key: 'ManageRoles', label: 'Mengelola peran', usedBy: 'autorole', granted: false },
                ],
            },
            highestRole: { id: '600000000000000003', name: 'ZentixBot', rolesAbove: 2 },
        },
    },
    storage: { backend: 'postgresql', status: 'connected' },
    access: {
        user: { id: adminId, username: '<b>Rina</b>' },
        isGuildOwner: false, isAdministrator: true, isBotOwner: false,
        sessionExpiresAt: 1_900_000_000_000,
        adminRoles: [{ id: '600000000000000002', name: '<u>Staff</u>', managed: false }],
        adminRolesTruncated: false,
    },
    hosting: { configured: null },
    dashboard: { origin: 'http://localhost:9999', sessionStore: 'process' },
    ...overrides,
});

async function open(t, state, url = 'http://localhost/dashboard/#settings') {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    state.calls = [];
    w.fetch = async (target, options = {}) => {
        target = String(target);
        state.calls.push([target, options.method || 'GET']);
        if (target.endsWith('/me')) return ok({ user: { username: 'Tester' }, guild: { name: 'Server' }, csrf: 'csrf' });
        if (target.endsWith('/control-center')) return state.center;
        if (target.endsWith('/hosting')) return state.hosting;
        return ok({});
    };
    for (const script of scripts) w.eval(fs.readFileSync(`dashboard-preview/${script}`, 'utf8'));
    await delay();
    const $ = (selector) => w.document.querySelector(selector);
    const click = async (selector) => {
        $(selector).click();
        await delay();
    };
    return { w, $, click };
}

test('the settings page shows live values as text and marks missing permissions', async (t) => {
    const state = { center: ok(sample()) };
    const page = await open(t, state);

    const discord = page.$('#settingsDiscord');
    assert.equal(discord.querySelector('img'), null);
    assert.match(discord.textContent, /<img src=x onerror=1>/);
    assert.match(discord.textContent, /1\.234/);
    assert.match(discord.textContent, /42 ms/);
    assert.match(discord.textContent, /3 jam 5 menit/);
    assert.match(discord.textContent, /2 peran berada di atasnya/);
    assert.match(page.$('#settingsPermissionSummary').textContent, /1 izin belum dimiliki bot/);
    assert.equal(page.$('[data-permission="ManageRoles"]').textContent, 'TIDAK ADA');
    assert.equal(page.$('[data-permission="SendMessages"]').textContent, 'ADA');

    assert.equal(page.$('#settingsStorageStatus').textContent, 'TERHUBUNG');
    const access = page.$('#settingsAccess');
    assert.equal(access.querySelector('b b'), null);
    assert.equal(access.querySelector('u'), null);
    assert.match(access.textContent, /<b>Rina<\/b>/);
    assert.equal(page.$('#settingsAccessBasis').textContent, 'Memiliki izin Administrator');
    assert.match(access.textContent, /<u>Staff<\/u>/);
    assert.match(page.$('#settingsSessionNote').textContent, /harus login lagi/);
    assert.equal(page.$('#settingsHttpNote'), null, 'no warning on an encrypted or local address');
    assert.match(page.$('#settingsHosting').textContent, /Hanya owner bot/);
    assert.match(page.$('#settingsReadAt').textContent, /Halaman tidak memperbarui diri/);

    // The page only reads.
    assert.equal(state.calls.every(([, method]) => method === 'GET'), true);
    assert.equal(page.w.document.querySelector('.placeholder-card'), null);
});

test('the settings page warns when it is opened over plain HTTP', async (t) => {
    const center = sample();
    center.dashboard = { origin: 'http://203.0.113.5:16954', sessionStore: 'process', insecureHttp: true };
    const page = await open(t, { center: ok(center) });
    assert.match(page.$('#settingsHttpNote').textContent, /Tanpa enkripsi\. Dashboard ini dibuka lewat HTTP biasa/);
    assert.match(page.$('#settingsHttpNote').textContent, /KELUAR/);
    // Anything but an explicit true shows no warning.
    center.dashboard.insecureHttp = 'true';
    const other = await open(t, { center: ok(center) });
    assert.equal(other.$('#settingsHttpNote'), null);
});

test('unknown values and a disconnected bot are shown as such', async (t) => {
    const data = sample();
    data.discord.guild.memberCount = null;
    data.discord.bot = { id: botId, ready: false, ping: null, uptimeMs: null, permissions: null, highestRole: null };
    data.storage = { backend: 'memory', status: 'degraded' };
    data.access.isAdministrator = false;
    data.access.isGuildOwner = true;
    data.access.adminRoles = [];
    const page = await open(t, { center: ok(data) });

    const discord = page.$('#settingsDiscord').textContent;
    assert.match(discord, /TIDAK TERHUBUNG/);
    assert.match(discord, /tidak tersedia/);
    assert.match(discord, /Izin bot tidak dapat dibaca/);
    assert.equal(page.$('#settingsStorageStatus').textContent, 'MODE CADANGAN');
    assert.match(page.$('#settingsStorage').textContent, /Memori \(tidak tersimpan\)/);
    assert.equal(page.$('#settingsAccessBasis').textContent, 'Owner server');
    assert.match(page.$('#settingsAccess').textContent, /Hanya owner server yang dapat masuk/);
});

test('a failed read leaves no stale values and can be retried', async (t) => {
    const state = { center: failed('Bot belum siap memverifikasi server.') };
    const page = await open(t, state);
    assert.match(page.$('#settingsDiscord').textContent, /Bot belum siap/);
    for (const id of ['#settingsStorage', '#settingsAccess', '#settingsHosting']) {
        assert.equal(page.$(id).textContent, 'Tidak dapat dimuat.');
    }
    assert.equal(page.$('#settingsReadAt').textContent, '');

    state.center = ok(sample());
    await page.click('#settingsReload');
    assert.equal(page.$('#settingsStorageStatus').textContent, 'TERHUBUNG');
    assert.equal(state.calls.filter(([target]) => target.endsWith('/control-center')).length, 2);
});

test('the bot owner can test the hosting connection; values are never shown', async (t) => {
    const state = {
        center: ok(sample({ hosting: { configured: true } })),
        hosting: failed('Tidak dapat mengambil data hosting.'),
    };
    const page = await open(t, state);
    assert.match(page.$('#settingsHosting').textContent, /Nilainya tidak ditampilkan/);
    assert.equal(state.calls.some(([target]) => target.endsWith('/hosting')), false, 'not contacted until asked');

    await page.click('#settingsHostingCheck');
    assert.match(page.$('#settingsHostingStatus').textContent, /Tidak dapat mengambil data hosting/);
    assert.equal(page.$('#settingsHostingCheck').disabled, false);

    state.hosting = ok({ status: 'running', cpuPercent: 3 });
    await page.click('#settingsHostingCheck');
    assert.match(page.$('#settingsHostingStatus').textContent, /Panel menjawab\. Status server: running/);

    const unconfigured = await open(t, { center: ok(sample({ hosting: { configured: false } })) });
    assert.match(unconfigured.$('#settingsHosting').textContent, /Belum dikonfigurasi/);
    assert.equal(unconfigured.$('#settingsHostingCheck'), null);
});

test('shortcuts open the feature pages and the offline preview stays a labelled placeholder', async (t) => {
    const page = await open(t, { center: ok(sample()) });
    const targets = [...page.w.document.querySelectorAll('#main [data-go]')].map((b) => b.dataset.go);
    assert.deepEqual(targets, [
        'features/core', 'features/welcome', 'features/logging', 'features/birthday',
        'features/giveaway', 'features/join-to-create', 'ai/providers',
    ]);
    await page.click('[data-go="features/core"]');
    assert.equal(page.w.location.hash, '#features/core');
    assert.equal(page.$('#settingsDiscord'), null);

    const state = { center: ok(sample()) };
    const offline = await open(t, state, 'http://localhost/preview/#settings');
    assert.equal(offline.$('#settingsDiscord'), null);
    assert.equal(offline.w.document.querySelectorAll('.placeholder-card').length, 4);
    assert.match(offline.$('#main').textContent, /Preview statis/);
    assert.deepEqual(state.calls, []);
});
