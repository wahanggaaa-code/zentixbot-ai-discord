/**
 * What the dashboard says about itself: on the logged-in dashboard no mock form may be rendered and no connected page
 * may be labelled as simulation; on the static preview every page must be labelled as one and must not call the API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { JSDOM } from 'jsdom';
import { createDashboardRouter } from '../src/dashboard/router.js';

const dir = 'dashboard-preview/';
const raw = fs.readFileSync(dir + 'index.html', 'utf8');
const allScripts = [...raw.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = raw.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

const MOCK = '[data-form],[data-ai-form],[data-sim-action],[data-ai-action]';
const SIMULATION = /SIMULASI|CONTOH|PREVIEW/i;
const NOT_OWNER = /BUKAN OWNER BOT/;

const FEATURE_TABS = {
    welcome: ['welcome', 'goodbye', 'verification'],
    moderation: ['cases', 'actions'],
    ticket: ['setup', 'inbox'],
    economy: ['leveling', 'economy', 'leaderboard'],
    music: ['player'],
    logging: ['setup', 'history'],
    birthday: ['settings'],
    core: ['commands'],
    giveaway: ['list'],
    'join-to-create': ['inventory'],
    'server-stats': ['counters'],
    'reaction-roles': ['panels'],
};
const AI_TABS = {
    greeting: ['welcome', 'goodbye'],
    activities: ['settings', 'preview'],
    agent: ['channel'],
    knowledge: ['library', 'test'],
    tools: ['summary', 'search'],
    image: ['create', 'edit'],
    builder: ['design'],
};

/**
 * `me` is the /api/me answer. Every other request is answered by `api(path)`; the default refuses, which leaves each
 * live module in its error state. That is enough here: the tests look at the page chrome, not at loaded data.
 */
function open(t, { url = 'http://localhost/dashboard/', me = {}, skip = [], api = () => ({ status: 503, body: { error: 'tidak tersedia' } }) } = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    w.confirm = () => false;
    const calls = [];
    w.fetch = async (target) => {
        const path = String(target);
        calls.push(path);
        const answer = path.endsWith('/api/me')
            ? { status: 200, body: { user: { username: 'Tester' }, guild: { name: 'Home' }, csrf: 'c', ...me } }
            : api(path);
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body, text: async () => JSON.stringify(answer.body) };
    };
    // Live modules that receive a refusal reject in the background; that is expected here and must not end the run.
    const swallow = () => {};
    process.on('unhandledRejection', swallow);
    t.after(() => { process.off('unhandledRejection', swallow); w.close(); });
    for (const name of allScripts) if (!skip.includes(name)) w.eval(fs.readFileSync(dir + name, 'utf8'));
    const main = w.document.querySelector('main');
    const go = async (hash) => { w.location.hash = hash; await tick(); };
    const tabs = (attr) => [...main.querySelectorAll(`.f-tabs [${attr}]`)].map((b) => b.getAttribute(attr));
    const banner = () => main.querySelector('.f-demo-warning')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    return { w, main, calls, go, tabs, banner };
}

/** Visits every tab of every group and returns one record per tab. */
async function walk(page, { features = true, ai = true } = {}) {
    const seen = [];
    const visit = async (prefix, attr, id) => {
        await page.go(`#${prefix}/${id}`);
        const list = page.tabs(attr);
        for (const [index, tab] of (list.length ? list : [null]).entries()) {
            if (index > 0) { page.main.querySelector(`.f-tabs [${attr}="${tab}"]`).click(); await tick(); }
            seen.push({
                where: `${prefix}/${id}/${tab ?? '-'}`,
                group: id,
                tab,
                banner: page.banner(),
                mock: page.main.querySelectorAll(MOCK).length,
                // What the tab puts on the page before any data arrives: its containers and its headings.
                view: [
                    ...[...page.main.querySelectorAll('.f-content [id]')].map((el) => el.id + (el.dataset.kind ? ':' + el.dataset.kind : '')),
                    ...[...page.main.querySelectorAll('.f-content h2')].map((el) => el.textContent.trim()),
                ].join(','),
            });
        }
    };
    if (features) for (const id of Object.keys(FEATURE_TABS)) await visit('features', 'data-tab', id);
    if (ai) for (const id of [...Object.keys(AI_TABS), 'providers']) await visit('ai', 'data-ai-tab', id);
    return seen;
}

test('dashboard: no tab renders a mock form or calls itself a simulation', async (t) => {
    const page = open(t, { me: { botOwner: true } });
    await tick(30);
    const seen = await walk(page);

    assert.equal(seen.length, 19 + 12 + 1, 'feature tabs + AI tabs + providers');
    for (const entry of seen) {
        assert.equal(entry.mock, 0, `${entry.where} renders a mock control`);
        assert.doesNotMatch(entry.banner, SIMULATION, `${entry.where} is labelled as simulation: ${entry.banner}`);
        assert.doesNotMatch(entry.banner, /BELUM TERHUBUNG|BAGIAN LAIN/, `${entry.where} hedges about other parts: ${entry.banner}`);
        assert.match(entry.banner, /TERHUBUNG|POSTGRESQL/, `${entry.where} does not say it is connected: ${entry.banner}`);
    }
});

test('dashboard: each tab opens a view of its own', async (t) => {
    const page = open(t, { me: { botOwner: true } });
    await tick(30);
    const seen = await walk(page);

    const byGroup = {};
    for (const entry of seen) if (entry.tab) (byGroup[entry.group] ??= []).push(entry);
    for (const [group, expected] of Object.entries({ ...FEATURE_TABS, ...AI_TABS })) {
        assert.deepEqual(byGroup[group].map((entry) => entry.tab), expected, `tabs of ${group}`);
    }
    // Two tabs that render the same containers under the same headings are one page under two names.
    for (const [group, entries] of Object.entries(byGroup)) {
        const views = entries.map((entry) => entry.view);
        assert.equal(new Set(views).size, views.length, `${group} has tabs showing the same view: ${views.join(' | ')}`);
    }
    await page.go('#ai/image');
    page.main.querySelector('.f-tabs [data-ai-tab="create"]').click();
    await tick();
    assert.equal(page.main.querySelector('input[type=file]'), null);
    page.main.querySelector('.f-tabs [data-ai-tab="edit"]').click();
    await tick();
    assert.ok(page.main.querySelector('input[type=file]'), 'the edit tab differs from create by its image input');
});

test('dashboard: tab banners name what the tab does', async (t) => {
    const page = open(t, { me: { botOwner: true } });
    await tick(30);
    const seen = await walk(page, { ai: false });
    const banner = (where) => seen.find((entry) => entry.where === where).banner;

    for (const where of ['features/moderation/cases', 'features/economy/leaderboard', 'features/logging/history']) {
        assert.match(banner(where), /HANYA BACA/, where);
    }
    for (const where of ['features/moderation/actions', 'features/ticket/inbox', 'features/welcome/verification', 'features/ticket/setup', 'features/economy/leveling', 'features/welcome/welcome', 'features/giveaway/list']) {
        assert.match(banner(where), /DISCORD/, `${where} acts on Discord`);
        assert.doesNotMatch(banner(where), /HANYA BACA/, where);
    }
    assert.match(banner('features/music/player'), /LAVALINK/);
    assert.match(banner('features/join-to-create/inventory'), /PENGATURAN TRIGGER TERHUBUNG/);
});

test('dashboard: index pages', async (t) => {
    const page = open(t, { me: { botOwner: true } });
    await tick(30);

    await page.go('#features');
    const cards = [...page.main.querySelectorAll('.f-index-bottom span:first-child')].map((el) => el.textContent);
    assert.deepEqual(cards, Array(12).fill('BUKA FITUR'));
    assert.match(page.main.querySelector('.f-index-bar').textContent, /12 FITUR TERHUBUNG KE BOT/);
    assert.doesNotMatch(page.main.querySelector('.f-index-bar').textContent, /SEBAGIAN|SIMULASI/);
    // Categories without a page: named as such, and not dressed up as links.
    const more = page.main.querySelector('.f-more');
    assert.equal(more.querySelectorAll('.f-chips span').length, 5);
    assert.doesNotMatch(more.querySelector('.f-chips').textContent, /Server Stats|Reaction Roles/, 'these have a page now');
    assert.equal(more.querySelectorAll('a, button').length, 0);
    assert.doesNotMatch(more.querySelector('.f-chips').textContent, /↗/);
    assert.match(more.textContent, /BELUM ADA HALAMAN/);
    assert.match(more.textContent, /perintah bot di Discord/);

    await page.go('#ai');
    const ai = [...page.main.querySelectorAll('.f-index-bottom span:first-child')].map((el) => el.textContent);
    assert.deepEqual(ai, [...Array(7).fill('BUKA FITUR'), 'PENGATURAN OWNER']);
    assert.match(page.main.querySelector('.ai-intro-foot').textContent, /FITUR AI TERHUBUNG · KHUSUS OWNER BOT/);
    assert.match(page.main.querySelector('.f-index-bar').textContent, /8 RUANG TERHUBUNG KE BOT/);
    assert.doesNotMatch(page.main.textContent, /masih simulasi/i);
});

test('dashboard: a room whose script did not load is shown as a preview, not as connected', async (t) => {
    const page = open(t, { me: { botOwner: true }, skip: ['ai-chat.js'] });
    await tick(30);

    await page.go('#ai');
    const cards = [...page.main.querySelectorAll('.f-index-card')].map((card) => [card.getAttribute('href'), card.querySelector('.f-index-bottom span').textContent]);
    assert.deepEqual(cards.find(([href]) => href === '#ai/agent'), ['#ai/agent', 'LIHAT PREVIEW']);
    assert.equal(cards.filter(([, label]) => label === 'BUKA FITUR').length, 6);
    assert.match(page.main.querySelector('.ai-intro-foot').textContent, /SEBAGIAN RUANG AI TIDAK TERMUAT/);
    assert.match(page.main.querySelector('.f-index-bar').textContent, /7 RUANG TERHUBUNG KE BOT/);

    await page.go('#ai/agent');
    assert.match(page.banner(), /SIMULASI/);
    assert.deepEqual(page.tabs('data-ai-tab'), ['channel', 'dm', 'persona'], 'the mock keeps its own tabs');
    assert.ok(page.main.querySelectorAll(MOCK).length > 0);
});

test('dashboard: an account that is not a bot owner is told so on every AI page', async (t) => {
    const page = open(t, { me: { botOwner: false } });
    await tick(30);

    await page.go('#ai');
    assert.match(page.main.querySelector('.ai-intro-foot').textContent, NOT_OWNER);
    const seen = await walk(page, { features: false });
    assert.equal(seen.length, 13);
    for (const entry of seen) assert.match(entry.banner, NOT_OWNER, `${entry.where}: ${entry.banner}`);

    // Feature pages are open to every administrator and say nothing about bot ownership.
    await page.go('#features/welcome');
    assert.doesNotMatch(page.banner(), NOT_OWNER);
});

test('dashboard: owners, and servers that do not report ownership, keep the normal labels', async (t) => {
    for (const me of [{ botOwner: true }, {}]) {
        const page = open(t, { me });
        await tick(30);
        await page.go('#ai');
        assert.doesNotMatch(page.main.querySelector('.ai-intro-foot').textContent, NOT_OWNER);
        for (const entry of await walk(page, { features: false })) assert.doesNotMatch(entry.banner, NOT_OWNER, entry.where);
    }
});

test('dashboard overview: the status line follows the bot instead of staying on the sample text', async (t) => {
    const failing = open(t);
    await tick(40);
    const line = () => failing.main.querySelector('.card-bottomline strong').textContent;
    assert.match(line(), /TIDAK TERSEDIA/);
    assert.doesNotMatch(failing.main.querySelector('.main-card').textContent, /BELUM TERHUBUNG|PREVIEW/);
    assert.doesNotMatch(failing.main.querySelector('.dashboard-left').textContent, /DATA CONTOH/);

    const answering = open(t, {
        api: (path) => (path.endsWith('/bot/overview')
            ? { status: 200, body: { guild: { id: '1', name: 'Home', memberCount: 12 }, online: true, ping: 40, uptime: 3_600_000, database: 'connected' } }
            : { status: 503, body: { error: 'tidak tersedia' } }),
    });
    await tick(40);
    assert.match(answering.main.querySelector('.card-bottomline strong').textContent, /ONLINE · DB TERHUBUNG/);
});

test('static preview: every page is labelled as a simulation and nothing is requested', async (t) => {
    const page = open(t, { url: 'http://localhost/preview/' });
    await tick(30);
    assert.match(page.w.document.querySelector('.demo-strip').textContent, /SEMUA SIMULASI/);

    await page.go('#features');
    assert.match(page.main.querySelector('.f-index-bar').textContent, /UI SIMULASI/);
    assert.deepEqual([...page.main.querySelectorAll('.f-index-bottom span:first-child')].map((el) => el.textContent), Array(12).fill('LIHAT PREVIEW'));
    await page.go('#ai');
    assert.match(page.main.querySelector('.ai-intro-foot').textContent, /UI SIMULASI · TIDAK TERHUBUNG/);
    assert.deepEqual([...page.main.querySelectorAll('.f-index-bottom span:first-child')].map((el) => el.textContent), Array(8).fill('LIHAT PREVIEW'));
    assert.match(page.main.querySelector('.f-callout').textContent, /semua formulir AI adalah simulasi/);

    const seen = await walk(page);
    for (const entry of seen) assert.match(entry.banner, SIMULATION, `${entry.where}: ${entry.banner}`);
    // The mock keeps its full tab lists, including the tabs merged on the dashboard.
    const tabsOf = (group) => seen.filter((entry) => entry.group === group).map((entry) => entry.tab);
    assert.deepEqual(tabsOf('ticket'), ['setup', 'inbox', 'transcript']);
    assert.deepEqual(tabsOf('music'), ['player', 'settings']);
    assert.deepEqual(tabsOf('agent'), ['channel', 'dm', 'persona']);
    assert.deepEqual(tabsOf('tools'), ['summary', 'search', 'language']);
    assert.deepEqual(tabsOf('builder'), ['design', 'review']);
    assert.deepEqual(tabsOf('providers'), ['providers', 'limits', 'fallback']);
    assert.deepEqual(page.calls, [], 'the static preview must not call the API');
});

test('/api/me reports whether the account is a bot owner', async (t) => {
    const home = '123456789012345678', clientId = '234567890123456789', user = '345678901234567890';
    const guild = { id: home, name: 'Home', ownerId: '999999999999999999', members: { fetch: async () => ({ permissions: { has: (p) => p === PermissionFlagsBits.Administrator } }) } };
    const client = { homeGuildId: home, isReady: () => true, guilds: { cache: new Map([[home, guild]]) } };
    const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith('/token') ? { access_token: 'mock', expires_in: 3600 } : { id: user, username: 'tester' }) });

    async function me(ownerIds) {
        const env = { CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: 'secret', DASHBOARD_URL: 'http://localhost:9999' };
        if (ownerIds !== undefined) env.OWNER_IDS = ownerIds;
        const app = express();
        app.use('/dashboard', createDashboardRouter(client, { fetchImpl, env }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        t.after(() => new Promise((resolve) => server.close(resolve)));
        const req = (path, opts = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual', ...opts });
        const start = await req('/dashboard/login');
        const state = new URL(start.headers.get('location')).searchParams.get('state');
        const callback = await req(`/dashboard/callback?code=mock&state=${state}`, { headers: { cookie: start.headers.get('set-cookie').split(';')[0] } });
        const session = callback.headers.getSetCookie().find((x) => x.startsWith('zx_session=')).split(';')[0];
        const response = await req('/dashboard/api/me', { headers: { cookie: session } });
        assert.equal(response.status, 200);
        return response.json();
    }

    assert.equal((await me(user)).botOwner, true);
    assert.equal((await me(` 111111111111111111 , ${user} `)).botOwner, true);
    assert.equal((await me('111111111111111111')).botOwner, false);
    assert.equal((await me('')).botOwner, false);
    assert.equal((await me(undefined)).botOwner, false);
    const body = await me(user);
    assert.deepEqual(Object.keys(body).sort(), ['botOwner', 'botReady', 'csrf', 'guild', 'user']);
});
