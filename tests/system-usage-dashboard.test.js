// "02 / PEMAKAIAN SISTEM" on the overview page: the route that answers it, who may ask, how often
// Discord and the hosting panel are bothered for it, and what the page writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { JSDOM } from 'jsdom';
import { createDashboardRouter } from '../src/dashboard/router.js';
import { createSystemUsageApi, PANEL_REFRESH_MS } from '../src/dashboard/systemUsageApi.js';

const MB = 1024 * 1024;
const home = '123456789012345678', owner = '234567890123456789', admin = '334567890123456789';
const panelEnv = { HOSTING_PANEL_URL: 'https://panel.example', HOSTING_SERVER_ID: 'server123', HOSTING_API_KEY: 'panel-secret-key' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const sampleOf = (more = {}) => ({
    sampledAt: 1_800_000_000_000, scope: 'container',
    cpu: { percent: 12.5, limitPercent: 100, cores: 4 },
    memory: { usedBytes: 240 * MB, totalBytes: 512 * MB, limited: true, processBytes: 90 * MB },
    network: { inBytes: 5_000_000, outBytes: 700_000, inBytesPerSecond: 2048, outBytesPerSecond: 512 },
    disk: { usedBytes: 420 * MB, limitBytes: 1024 * MB, measuredAt: 1_799_999_990_000, complete: true, source: 'folder' },
    ...more,
});

// ---------------------------------------------------------------------------------------------
// The route on its own
// ---------------------------------------------------------------------------------------------

async function route(t, { env = {}, sample = async () => sampleOf(), panel } = {}) {
    const clock = { now: 1_800_000_000_000 };
    const state = { samples: 0, asked: [] };
    const usage = { sample: async () => { state.samples += 1; return sample(); } };
    const fetchImpl = async (url, options) => { state.asked.push({ url, options }); return panel(); };
    const auth = (req, res, next) => { req.session = { user: { id: req.get('x-user') } }; next(); };
    const app = express();
    app.use('/api', createSystemUsageApi({ auth, env: { OWNER_IDS: owner, ...env }, usage, fetchImpl, now: () => clock.now }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const get = (user = owner) => fetch(`http://127.0.0.1:${server.address().port}/api/system-usage`, { headers: { 'x-user': user } });
    return { get, clock, state };
}
const panelSays = (attributes) => async () => ({ ok: true, json: async () => ({ object: 'stats', attributes }) });

test('only the bot owner is answered; anyone else is refused before anything is measured', async (t) => {
    const { get, state } = await route(t, { env: panelEnv, panel: panelSays({ current_state: 'running', resources: { disk_bytes: 1 } }) });
    for (const who of [admin, '', 'not-an-id']) {
        const refused = await get(who);
        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), { error: 'Pemakaian sistem hanya untuk owner bot.' });
    }
    assert.equal(state.samples, 0);
    assert.equal(state.asked.length, 0);

    const noOwners = await route(t, { env: { OWNER_IDS: '' } });
    assert.equal((await noOwners.get(owner)).status, 403, 'no owner configured: nobody');
});

test('without a panel connection the answer is what the bot measured itself', async (t) => {
    const { get, state } = await route(t, { panel: async () => { throw new Error('must not be asked'); } });
    const response = await get();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...sampleOf(), panel: { configured: false, state: null } });
    assert.equal(state.asked.length, 0);

    const half = await route(t, { env: { ...panelEnv, HOSTING_API_KEY: '' }, panel: async () => { throw new Error('must not be asked'); } });
    assert.deepEqual((await (await half.get()).json()).panel, { configured: false, state: null });
    assert.equal(half.state.asked.length, 0, 'two of three settings is not a connection');
});

test('with a panel connection the panel gives the server state and the disk figure, at most every 15 seconds', async (t) => {
    assert.equal(PANEL_REFRESH_MS, 15000);
    const { get, clock, state } = await route(t, { env: panelEnv, panel: panelSays({ current_state: 'running', resources: { cpu_absolute: 77, memory_bytes: 1, disk_bytes: 900 * MB } }) });

    const first = await (await get()).json();
    assert.deepEqual(first.panel, { configured: true, state: null }, 'the answer does not wait for the panel');
    assert.deepEqual(first.disk, sampleOf().disk);
    await settle();
    assert.equal(state.asked.length, 1);
    assert.equal(state.asked[0].url, 'https://panel.example/api/client/servers/server123/resources');
    assert.equal(state.asked[0].options.headers.Authorization, 'Bearer panel-secret-key');
    assert.equal(state.asked[0].options.redirect, 'error', 'the key is not carried to another address');
    assert.ok(state.asked[0].options.signal instanceof AbortSignal);
    const answeredAt = clock.now;

    clock.now += 3000;
    const second = await get();
    const text = await second.text();
    const body = JSON.parse(text);
    assert.deepEqual(body.panel, { configured: true, state: 'running' });
    assert.deepEqual(body.disk, { usedBytes: 900 * MB, limitBytes: 1024 * MB, measuredAt: answeredAt, complete: true, source: 'panel' });
    assert.deepEqual(body.cpu, sampleOf().cpu, 'CPU, memory and network stay the bot\'s own reading');
    assert.deepEqual(body.memory, sampleOf().memory);
    assert.equal(text.includes('panel-secret-key'), false);
    assert.equal(text.includes('panel.example'), false);
    assert.equal(text.includes('server123'), false);

    clock.now = answeredAt + PANEL_REFRESH_MS - 1;
    await get(); await get(); await settle();
    assert.equal(state.asked.length, 1, 'polls every 3 seconds do not reach the panel each time');
    clock.now = answeredAt + PANEL_REFRESH_MS;
    await get(); await settle();
    assert.equal(state.asked.length, 2);
});

test('a panel that refuses, fails or answers nonsense changes nothing, and is not asked again at once', async (t) => {
    const answers = [
        async () => ({ ok: false, status: 403, json: async () => ({ attributes: { current_state: 'running', resources: { disk_bytes: 5 } } }) }), // a refusal is not read, whatever it carries
        async () => { throw new Error('ECONNREFUSED'); },
        async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } }),
        panelSays({ current_state: { evil: true }, resources: { disk_bytes: -5 } }),
        panelSays({ current_state: 'x'.repeat(500), resources: { disk_bytes: '900' } }),
        panelSays(undefined),
    ];
    let call = 0;
    const { get, clock, state } = await route(t, { env: panelEnv, panel: () => answers[call++]() });
    for (let round = 1; round <= answers.length; round += 1) {
        await get(); await settle();
        assert.equal(state.asked.length, round);
        clock.now += 3000;
        const body = await (await get()).json();
        assert.deepEqual(body.disk, sampleOf().disk, `round ${round}: the bot's own figure stays`);
        if (round === 5) assert.equal(body.panel.state, 'x'.repeat(32), 'a long word is cut');
        else assert.deepEqual(body.panel, { configured: true, state: null }, `round ${round}`);
        await settle();
        assert.equal(state.asked.length, round, 'a failure is remembered for the same 15 seconds');
        clock.now += PANEL_REFRESH_MS;
    }
});

test('a panel that never answers does not hold the page up and is asked only once', async (t) => {
    const { get, clock, state } = await route(t, { env: panelEnv, panel: () => new Promise(() => {}) });
    for (let i = 0; i < 4; i += 1) {
        const body = await (await get()).json();
        assert.deepEqual(body.panel, { configured: true, state: null });
        clock.now += PANEL_REFRESH_MS * 2;
    }
    assert.equal(state.asked.length, 1);
});

test('when the bot cannot measure, the route says so instead of failing', async (t) => {
    const { get } = await route(t, { sample: async () => { throw new Error('/proc is gone: EACCES /home/container'); } });
    const response = await get();
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'Pemakaian sistem tidak dapat dibaca.' });
    assert.equal(text.includes('container'), false, 'the reason stays in the bot');
});

// ---------------------------------------------------------------------------------------------
// The route in the dashboard: sessions, and how often Discord is asked
// ---------------------------------------------------------------------------------------------

async function dashboard(t, { ownerIds = owner, user = owner } = {}) {
    const state = { memberFetches: 0, administrator: true, samples: 0 };
    const guild = {
        id: home, name: 'Home', ownerId: '888888888888888888', memberCount: 3, channels: { cache: new Map() }, roles: { cache: new Map() },
        members: { fetch: async ({ user: id }) => { state.memberFetches += 1; return { id, user: { id, username: 'Tester' }, permissions: { has: (flag) => state.administrator && flag === PermissionFlagsBits.Administrator } }; } },
    };
    const client = { homeGuildId: home, isReady: () => true, uptime: 1000, ws: { ping: 30 }, guilds: { cache: new Map([[home, guild]]) } };
    const discord = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/token') ? { access_token: 'fake', expires_in: 3600 } : { id: user, username: 'Tester' }) });
    const systemUsage = { sample: async () => { state.samples += 1; return sampleOf(); } };
    const app = express();
    app.use('/dashboard', createDashboardRouter(client, { fetchImpl: discord, systemUsage, env: { CLIENT_ID: home, DISCORD_CLIENT_SECRET: 'secret', DASHBOARD_URL: 'http://localhost:9999', OWNER_IDS: ownerIds } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    const begin = await req('/dashboard/login');
    const login = new URL(begin.headers.get('location')).searchParams.get('state');
    const callback = await req(`/dashboard/callback?code=x&state=${login}`, { headers: { cookie: begin.headers.get('set-cookie').split(';')[0] } });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find((c) => c.startsWith('zx_session=')).split(';')[0];
    const get = (path) => req(`/dashboard/api/${path}`, { headers: { cookie } });
    return { get, req, state };
}

test('in the dashboard: no session is 401, an administrator who is not the bot owner is 403, the owner is answered', async (t) => {
    const mine = await dashboard(t);
    assert.equal((await mine.req('/dashboard/api/bot/system-usage')).status, 401);
    assert.equal((await mine.req('/dashboard/api/bot/system-usage', { headers: { cookie: 'zx_session=made-up' } })).status, 401);
    assert.equal(mine.state.samples, 0);
    const answered = await mine.get('bot/system-usage');
    assert.equal(answered.status, 200);
    assert.match(answered.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await answered.json(), { ...sampleOf(), panel: { configured: false, state: null } });

    const other = await dashboard(t, { user: admin });
    assert.equal((await other.get('me')).status, 200, 'an administrator of the server, logged in');
    assert.equal((await other.get('bot/system-usage')).status, 403);
    assert.equal(other.state.samples, 0);
});

test('polling does not ask Discord about the member every time, but a lost permission still ends it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { get, state } = await dashboard(t);
    const asked = () => state.memberFetches - atLogin;
    const atLogin = state.memberFetches;

    assert.equal((await get('bot/system-usage')).status, 200);
    assert.equal(asked(), 1, 'the first request of a session is checked');
    for (let i = 0; i < 10; i += 1) assert.equal((await get('bot/system-usage')).status, 200);
    assert.equal(asked(), 1, 'ten polls, no further question to Discord');
    assert.equal(state.samples, 11);

    assert.equal((await get('bot/overview')).status, 200);
    assert.equal(asked(), 2, 'every other route still checks on each request');

    t.mock.timers.tick(59_999);
    assert.equal((await get('bot/system-usage')).status, 200);
    assert.equal(asked(), 2);
    t.mock.timers.tick(1);
    assert.equal((await get('bot/system-usage')).status, 200);
    assert.equal(asked(), 3, 'after a minute the member is checked again');

    // The owner is no longer an administrator of the server.
    state.administrator = false;
    assert.equal((await get('bot/system-usage')).status, 200, 'within the minute the last check still stands');
    t.mock.timers.tick(60_000);
    assert.equal((await get('bot/system-usage')).status, 403);
    assert.equal((await get('bot/system-usage')).status, 403, 'and a refusal is not remembered as a pass');
    assert.equal(asked(), 5);

    // A refusal on any other route withdraws the trust at once.
    state.administrator = true;
    assert.equal((await get('bot/system-usage')).status, 200);
    state.administrator = false;
    assert.equal((await get('bot/overview')).status, 403);
    assert.equal((await get('bot/system-usage')).status, 403, 'no minute of grace after another route refused');
});

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

const dir = 'dashboard-preview/';
const rawHtml = fs.readFileSync(dir + 'index.html', 'utf8');
const scripts = [...rawHtml.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = rawHtml.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page in a browser stand-in. `usage()` gives the next answer of the usage route: `{ status, body }`. */
function page(t, { url = 'http://localhost/dashboard/', usage = () => ({ status: 200, body: sampleOf() }), visible = true } = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.scrollTo = () => {};
    let hidden = !visible;
    Object.defineProperty(w.document, 'hidden', { get: () => hidden });
    const calls = [];
    const timers = [];
    // Timers of the page are recorded and run by the test, so that "every 3 seconds" needs no waiting.
    const realSet = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...rest) => { if (ms >= 500) { const id = 1e6 + timers.length; timers.push({ id, fn, ms, cleared: false, ran: false }); return id; } return realSet(fn, ms, ...rest); };
    const realClear = w.clearTimeout.bind(w);
    w.clearTimeout = (id) => { const mine = timers.find((x) => x.id === id); if (mine) mine.cleared = true; else realClear(id); };
    w.fetch = async (target) => {
        const path = String(target);
        calls.push(path);
        const answer = path.endsWith('/api/me') ? { status: 200, body: { user: { username: 'Tester' }, guild: { name: 'Home' }, csrf: 'c', botOwner: true } }
            : path.endsWith('/system-usage') ? usage()
            : path.endsWith('/bot/overview') ? { status: 200, body: { guild: { id: '1', name: 'Home', memberCount: 12 }, online: true, ping: 40, uptime: 3_600_000, database: 'connected' } }
            : { status: 503, body: { error: 'tidak tersedia' } };
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    };
    const swallow = () => {};
    process.on('unhandledRejection', swallow);
    t.after(() => { process.off('unhandledRejection', swallow); w.close(); });
    for (const name of scripts) w.eval(fs.readFileSync(dir + name, 'utf8'));
    const box = () => w.document.querySelector('#systemUsage');
    const card = (name) => box().querySelector(`[data-usage="${name}"]`);
    return {
        w, box, card, calls, timers,
        polls: () => calls.filter((c) => c.endsWith('/system-usage')).length,
        text: (name) => card(name).textContent.replace(/\s+/g, ' ').trim(),
        bar: (name) => card(name).querySelector('.progress i').style.width,
        pending: () => timers.filter((x) => !x.cleared && !x.ran),
        runNext: async () => { const next = timers.find((x) => !x.cleared && !x.ran); assert.ok(next, 'a timer is waiting'); next.ran = true; next.fn(); await tick(); return next.ms; },
        setHidden: (value) => { hidden = value; w.document.dispatchEvent(new w.Event('visibilitychange')); },
        go: async (hash) => { w.location.hash = hash; await tick(); },
    };
}

test('the overview page has the usage block second and the quick links last; the old sections are gone', async (t) => {
    const p = page(t, { url: 'http://localhost/preview/' });
    await tick();
    const main = p.w.document.querySelector('main');
    const text = main.textContent;
    assert.match(main.querySelector('.dashboard-right .block-label').textContent, /02 \/ PEMAKAIAN SISTEM/);
    assert.equal(main.querySelector('.dashboard-right'), p.box());
    assert.deepEqual([...p.box().querySelectorAll('[data-usage]')].map((el) => el.dataset.usage), ['cpu', 'memory', 'network', 'disk']);
    assert.deepEqual([...p.box().querySelectorAll('.usage-label span:first-child')].map((el) => el.textContent), ['01 / CPU', '02 / RAM', '03 / JARINGAN', '04 / DISK']);

    assert.doesNotMatch(text, /Dibuat untuk/);
    assert.doesNotMatch(text, /03 \/ HOSTING|RESOURCE HOSTING/);
    assert.equal(main.querySelector('.resource-section, .collection, .collection-card, #stateToggle, [data-role]'), null);

    const last = main.lastElementChild;
    assert.equal(last.className, 'quick-section', 'the quick links close the page');
    assert.match(last.querySelector('h2').textContent, /Akses\s*cepat/);
    assert.match(last.textContent, /03 \/ AKSES CEPAT/);
    assert.deepEqual([...last.querySelectorAll('button.module-row')].map((b) => b.dataset.go), ['features', 'ai', 'settings']);
    assert.equal(p.box().querySelector('[data-go]'), null, 'no link is left in the usage block');
    assert.deepEqual([...main.querySelectorAll('[data-go]')].map((el) => el.closest('.quick-section') === last), [true, true, true, true], 'every link of the page is in that last section');
    assert.equal(last.querySelector('.bottom-note .round-arrow').dataset.go, 'features');

    last.querySelector('[data-go="settings"]').click();
    await tick();
    assert.equal(p.w.location.hash, '#settings', 'and they still lead somewhere');
});

test('static preview: the usage figures are marked as samples and nothing is asked', async (t) => {
    const p = page(t, { url: 'http://localhost/preview/' });
    await tick();
    assert.match(p.box().querySelector('.usage-state').textContent, /DATA CONTOH/);
    for (const name of ['cpu', 'memory', 'network', 'disk']) assert.match(p.text(name), /CONTOH/, name);
    assert.match(p.box().querySelector('.usage-foot').textContent, /CONTOH STATIS/);
    assert.equal(p.calls.length, 0);
    assert.equal(p.timers.length, 0);
});

test('logged in: the four figures are the bot\'s answer, with limits and bars, and no sample text is left', async (t) => {
    const p = page(t);
    await tick();
    assert.equal(p.polls(), 1);
    assert.equal(p.box().querySelector('.usage-state').textContent, '● LIVE');
    assert.equal(p.text('cpu'), '01 / CPU◉12.5%DARI 100%');
    assert.equal(p.bar('cpu'), '12.5%');
    assert.equal(p.text('memory'), '02 / RAM▦240 MBDARI 512 MB');
    assert.equal(p.bar('memory'), '46.875%');
    assert.equal(p.text('network'), '03 / JARINGAN⇅↓ MASUK2 KB/s↑ KELUAR512 B/sTOTAL ↓ 4.8 MB · ↑ 684 KB');
    assert.equal(p.text('disk'), '04 / DISK▱420 MBDARI 1 GB');
    assert.equal(p.bar('disk'), '41.015625%');
    assert.doesNotMatch(p.box().textContent, /CONTOH|MEMUAT|384/);
    assert.match(p.box().querySelector('.usage-foot').textContent, /DIUKUR DI DALAM KONTAINER BOT.*REFRESH \/ 3 DETIK · DISK \/ 5 MENIT/);
    assert.equal(p.box().querySelector('.usage-high'), null);
});

test('logged in: what is not known is a dash, never a zero, and each kind of host is described as it is', async (t) => {
    // The first answer of a bot on a VPS: no rates yet, no limits, the folder still being measured.
    let body = sampleOf({
        scope: 'process',
        cpu: { percent: null, limitPercent: null, cores: 8 },
        memory: { usedBytes: 150 * MB, totalBytes: 16384 * MB, limited: false, processBytes: 150 * MB },
        network: { inBytes: null, outBytes: null, inBytesPerSecond: null, outBytesPerSecond: null },
        disk: { usedBytes: null, limitBytes: null, measuredAt: null, complete: null, source: 'folder' },
    });
    const p = page(t, { usage: () => ({ status: 200, body }) });
    await tick();
    assert.equal(p.text('cpu'), '01 / CPU◉—8 INTI · TANPA BATAS');
    assert.equal(p.bar('cpu'), '0%');
    assert.equal(p.text('memory'), '02 / RAM▦150 MBRAM MESIN 16 GB');
    assert.equal(p.text('network'), '03 / JARINGAN⇅↓ MASUK—↑ KELUAR—TIDAK TERBACA');
    assert.equal(p.text('disk'), '04 / DISK▱—MENGHITUNG…');
    assert.equal(p.bar('disk'), '0%');
    assert.match(p.box().querySelector('.usage-foot').textContent, /DI LUAR KONTAINER: CPU & RAM MILIK PROSES BOT/);
    assert.equal(await p.runNext(), 1000, 'no CPU figure yet: ask again after a second');

    // No traffic and an idle CPU are zeros; a walk that was cut short says so; the panel names its state.
    body = sampleOf({
        cpu: { percent: 0, limitPercent: 200, cores: 8 },
        network: { inBytes: 10, outBytes: 0, inBytesPerSecond: 0, outBytesPerSecond: 0 },
        disk: { usedBytes: 5000 * MB, limitBytes: null, measuredAt: 1, complete: false, source: 'folder' },
        panel: { configured: true, state: 'running' },
    });
    assert.equal(await p.runNext(), 1000);
    assert.equal(p.text('cpu'), '01 / CPU◉0%DARI 200%');
    assert.equal(p.text('network'), '03 / JARINGAN⇅↓ MASUK0 B/s↑ KELUAR0 B/sTOTAL ↓ 10 B · ↑ 0 B');
    assert.equal(p.text('disk'), '04 / DISK▱4.9 GBLEBIH DARI INI · KUOTA BELUM DIISI');
    assert.equal(p.bar('disk'), '0%', 'no quota, no bar');
    assert.equal(p.box().querySelector('.usage-state').textContent, '● LIVE · RUNNING');

    // Nearly full: the card is marked. The disk figure of the panel is named as such.
    body = sampleOf({
        cpu: { percent: 197.3, limitPercent: 200, cores: 8 },
        memory: { usedBytes: 600 * MB, totalBytes: 512 * MB, limited: true, processBytes: 1 },
        disk: { usedBytes: 922 * MB, limitBytes: 1024 * MB, measuredAt: 1, complete: true, source: 'panel' },
    });
    assert.equal(await p.runNext(), 3000, 'with a CPU figure: every 3 seconds');
    assert.equal(p.text('cpu'), '01 / CPU◉197%DARI 200%');
    assert.equal(p.bar('memory'), '100%', 'a bar never leaves its track');
    assert.deepEqual(['cpu', 'memory', 'network', 'disk'].map((name) => p.card(name).classList.contains('usage-high')), [true, true, false, true]);
    assert.match(p.box().querySelector('.usage-foot').textContent, /DISK \/ PANEL/);

    body = sampleOf();
    await p.runNext();
    assert.equal(p.box().querySelector('.usage-high'), null, 'and the mark goes when the load does');

    // The CPU bar is the share of what the bot may use: its quota, or every core when there is none.
    body = sampleOf({ cpu: { percent: 150, limitPercent: 400, cores: 8 }, memory: { usedBytes: 90 * MB, totalBytes: 100 * MB, limited: true, processBytes: 1 }, disk: { usedBytes: 899 * MB, limitBytes: 1000 * MB, measuredAt: 1, complete: true, source: 'folder' } });
    await p.runNext();
    assert.equal(p.bar('cpu'), '37.5%');
    assert.deepEqual(['cpu', 'memory', 'disk'].map((name) => p.card(name).classList.contains('usage-high')), [false, true, false], 'the mark starts at exactly 90%');
    body = sampleOf({ cpu: { percent: 200, limitPercent: null, cores: 8 } });
    await p.runNext();
    assert.equal(p.bar('cpu'), '25%');
});

test('logged in: the figures are written as text, whatever the answer holds', async (t) => {
    const p = page(t, { usage: () => ({ status: 200, body: sampleOf({ panel: { configured: true, state: '<img src=x onerror=alert(1)>' } }) }) });
    await tick();
    assert.equal(p.box().querySelector('img'), null);
    assert.match(p.box().querySelector('.usage-state').textContent, /<IMG SRC=X/);

    const refused = page(t, { usage: () => ({ status: 503, body: { error: '<b>rusak</b>' } }) });
    await tick();
    assert.equal(refused.box().querySelector('b:not(.usage-net b)'), null);
    assert.match(refused.box().querySelector('.usage-foot').textContent, /<b>rusak<\/b>/);
});

test('logged in: a refusal is shown as one; the page asks again only when that can help', async (t) => {
    const notOwner = page(t, { usage: () => ({ status: 403, body: { error: 'Pemakaian sistem hanya untuk owner bot.' } }) });
    await tick();
    assert.match(notOwner.box().querySelector('.usage-state').textContent, /KHUSUS OWNER BOT/);
    for (const name of ['cpu', 'memory', 'disk']) assert.match(notOwner.text(name), /—KHUSUS OWNER$/, name);
    assert.match(notOwner.box().querySelector('.usage-foot').textContent, /hanya untuk owner bot/);
    assert.doesNotMatch(notOwner.box().textContent, /CONTOH|384|MENCOBA LAGI/);
    assert.equal(notOwner.pending().length, 0, 'an administrator who is not the owner is not asked for again');

    const loggedOut = page(t, { usage: () => ({ status: 401, body: { error: 'Silakan login.' } }) });
    await tick();
    assert.equal(loggedOut.pending().length, 0);

    let answer = { status: 503, body: { error: 'Pemakaian sistem tidak dapat dibaca.' } };
    const failing = page(t, { usage: () => answer });
    await tick();
    assert.match(failing.box().querySelector('.usage-state').textContent, /TIDAK TERSEDIA/);
    assert.match(failing.box().querySelector('.usage-foot').textContent, /tidak dapat dibaca.*MENCOBA LAGI \/ 15 DETIK/);
    assert.doesNotMatch(failing.box().textContent, /CONTOH|384/);
    answer = { status: 200, body: sampleOf() };
    assert.equal(await failing.runNext(), 15000, 'a failure is retried, slowly');
    assert.equal(failing.box().querySelector('.usage-state').textContent, '● LIVE');
});

test('logged in: nothing is asked while the tab is hidden or another page is shown', async (t) => {
    const p = page(t);
    await tick();
    assert.equal(p.polls(), 1);
    await p.runNext();
    assert.equal(p.polls(), 2);

    p.setHidden(true);
    await p.runNext();
    assert.equal(p.polls(), 2, 'hidden: the due poll is skipped');
    assert.equal(p.pending().length, 0, 'and no timer keeps running behind a hidden tab');
    p.setHidden(false);
    await tick();
    assert.equal(p.polls(), 3, 'back in view: asked at once');
    assert.equal(p.pending().length, 1);
    p.setHidden(false);
    await tick();
    assert.equal(p.pending().length, 1, 'a second wake-up does not start a second loop');

    await p.go('#settings');
    assert.equal(p.box(), null);
    const before = p.polls();
    for (const timer of p.pending()) { timer.ran = true; timer.fn(); }
    p.setHidden(true); p.setHidden(false);
    await tick();
    assert.equal(p.polls(), before, 'on another page: nothing');

    await p.go('#overview');
    assert.equal(p.polls(), before + 1, 'and back on the overview it starts again');
    assert.equal(p.pending().length, 1);
    await p.go('#overview/');
    p.setHidden(true); p.setHidden(false);
    await tick();
    assert.ok(p.pending().length <= 1, 'one loop, however often the page is drawn');

    const hiddenFromStart = page(t, { visible: false });
    await tick();
    assert.equal(hiddenFromStart.polls(), 0, 'a tab opened in the background waits');
    assert.match(hiddenFromStart.box().querySelector('.usage-state').textContent, /MEMUAT/);
    hiddenFromStart.setHidden(false);
    await tick();
    assert.equal(hiddenFromStart.polls(), 1);
});
