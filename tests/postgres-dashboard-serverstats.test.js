import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { ChannelType } from 'discord.js';
import { createServerStatsFixture, guildId, missingPermissions } from './helpers/serverstats-fixture.js';
import { pgEnabled } from './helpers/leveling-postgres-fixture.js';
import { createServerStatsApi } from '../src/dashboard/serverStatsApi.js';
import { counterRefresher } from '../src/services/serverStats/refresh.js';

// The real router on the disposable PostgreSQL with an in-memory Discord; the page tests run the real page scripts
// in jsdom against that router.
const skip = !pgEnabled;
const dir = 'dashboard-preview/';
const raw = fs.readFileSync(dir + 'index.html', 'utf8');
const scripts = [...raw.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = raw.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const voice = (fx) => [...fx.channels.values()].filter((channel) => channel.type === ChannelType.GuildVoice);

async function api(t, options) {
    const fx = await createServerStatsFixture(t, options);
    fx.client.isReady = () => true;
    const req = await fx.startApi([createServerStatsApi]);
    const view = async () => (await req('/server-stats')).body;
    const make = (type = 'members', channelType = 'voice', categoryId = fx.category.id) => req('/server-stats/counters', 'POST', { confirmed: true, type, channelType, categoryId });
    return { fx, req, view, make };
}

// ---- API ------------------------------------------------------------------------

test('API read: counters, free types and categories; reading changes nothing', { skip }, async (t) => {
    const { fx, req, view } = await api(t, { humans: 3, bots: 1 });
    const locked = fx.makeChannel({ id: '810000000000000002', name: 'Staff', type: ChannelType.GuildCategory });
    fx.setBotPermissions(locked.id, ['ViewChannel']);
    await fx.store([{ id: '1', type: 'bots', channelId: '830000000000000001', guildId, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' }]);

    const response = await req('/server-stats');
    assert.equal(response.status, 200);
    const data = response.body;
    assert.match(data.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(data.types, [
        { id: 'members', label: 'Members + Bots', taken: false },
        { id: 'members_only', label: 'Members Only', taken: false },
        { id: 'bots', label: 'Bots Only', taken: true },
    ]);
    assert.deepEqual(data.categories, [
        { id: fx.category.id, name: 'Stats', usable: true },
        { id: locked.id, name: 'Staff', usable: false },
    ]);
    assert.deepEqual(data.limits, { counters: 3 });
    assert.equal(data.counters.length, 1);
    assert.deepEqual(
        { ...data.counters[0] },
        {
            id: '1', type: 'bots', known: true, enabled: true, channelId: '830000000000000001', channelName: null, channelType: null,
            count: 1, expectedName: 'Bots-1', current: false, botCanManage: null, nextRenameAt: null, createdAt: '2026-01-01T00:00:00.000Z',
        },
    );
    assert.equal((await fx.stored()).length, 1, 'a read does not remove the record of a channel the bot cannot see');
    assert.deepEqual([fx.calls.create.length, fx.calls.rename.length, fx.calls.delete.length, fx.calls.fetchChannel.length], [0, 0, 0, 0]);

    assert.equal((await req('/server-stats?x=1')).status, 400);
});

test('API create: makes the channel and the record; duplicates, bad input and missing CSRF are refused', { skip }, async (t) => {
    const { fx, req, view, make } = await api(t, { humans: 3, bots: 1 });

    const created = await make('members', 'voice');
    assert.equal(created.status, 200);
    assert.equal(created.body.channelName, 'Members & Bots-4');
    assert.equal(created.body.count, 4);
    const [stored] = await fx.stored();
    assert.equal(stored.id, created.body.id);
    assert.equal(stored.channelId, created.body.channelId);
    assert.match(fx.calls.create[0].reason, /^Server stats counter created by .* via dashboard$/);

    const data = await view();
    assert.equal(data.counters[0].current, true);
    assert.equal(data.counters[0].channelType, 'voice');
    assert.equal(data.counters[0].botCanManage, true);

    const again = await make('members', 'text');
    assert.equal(again.status, 409);
    assert.match(again.body.error, /sudah ada/);

    const bodies = [
        { type: 'members_only', channelType: 'voice', categoryId: fx.category.id },
        { confirmed: 'yes', type: 'members_only', channelType: 'voice', categoryId: fx.category.id },
        { confirmed: true, type: 'members_only', channelType: 'voice', categoryId: fx.category.id, name: 'x' },
        { confirmed: true, type: 'members_only', channelType: 'voice', categoryId: 'abc' },
        { confirmed: true, type: 'everyone', channelType: 'voice', categoryId: fx.category.id },
        { confirmed: true, type: 'members_only', channelType: 'stage', categoryId: fx.category.id },
        { confirmed: true, type: 'members_only', channelType: 'voice', categoryId: stored.channelId },
        { confirmed: true, type: ['members_only'], channelType: 'voice', categoryId: fx.category.id },
        [],
    ];
    for (const body of bodies) assert.equal((await req('/server-stats/counters', 'POST', body)).status, 400, JSON.stringify(body));
    assert.equal((await req('/server-stats/counters', 'POST', { confirmed: true, type: 'bots', channelType: 'voice', categoryId: fx.category.id }, { csrf: false })).status, 403);

    assert.equal(fx.calls.create.length, 1, 'none of the refused requests reached Discord');
    assert.equal((await fx.stored()).length, 1);
});

test('API create: bot not ready, bot without permission, Discord refusal and database failure leave nothing behind', { skip }, async (t) => {
    const { fx, make } = await api(t);

    fx.client.isReady = () => false;
    assert.equal((await make()).status, 503);
    fx.client.isReady = () => true;

    fx.setBotPermissions(fx.category.id, ['ViewChannel']);
    const denied = await make();
    assert.equal(denied.status, 409);
    assert.match(denied.body.error, /Manage Channels/);
    fx.setBotPermissions(fx.category.id, ['ViewChannel', 'ManageChannels']);

    fx.hooks.createChannel = () => { throw missingPermissions(); };
    const refused = await make();
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /Discord menolak/);
    fx.hooks.createChannel = null;
    assert.equal(fx.calls.create.length, 1);

    fx.control.failQuery = (sql) => /UPDATE .*counters/s.test(sql);
    const unsaved = await make();
    assert.equal(unsaved.status, 503);
    assert.equal(voice(fx).length, 0, 'the channel of the unsaved counter is removed again');

    fx.hooks.deleteChannel = () => { throw missingPermissions(); };
    const left = await make();
    fx.control.failQuery = null;
    fx.hooks.deleteChannel = null;
    assert.equal(left.status, 500);
    assert.match(left.body.error, /Hapus channel itu secara manual/);
    assert.equal(left.body.channelId, voice(fx)[0].id);

    assert.deepEqual(await fx.stored(), []);
    assert.doesNotMatch(JSON.stringify([denied.body, refused.body, unsaved.body, left.body]), /injected|Missing Permissions|UPDATE/, 'internal messages are not sent to the browser');
});

test('API change type: needs the current revision; reports what happened to the channel name', { skip }, async (t) => {
    const { fx, req, view, make } = await api(t, { humans: 3, bots: 1 });
    const { body: created } = await make('members');
    await make('bots');
    const { revision } = await view();
    const path = `/server-stats/counters/${created.id}`;

    assert.equal((await req(path, 'PATCH', { confirmed: true, type: 'members_only' })).status, 400);
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision: 'nope', type: 'members_only' })).status, 400);
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision: 'f'.repeat(64), type: 'members_only' })).status, 409);
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision, type: 'bots' })).status, 409);
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision, type: 'everyone' })).status, 400);
    assert.equal((await req('/server-stats/counters/12345', 'PATCH', { confirmed: true, revision, type: 'members_only' })).status, 404);
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision, type: 'members_only' }, { csrf: false })).status, 403);
    assert.equal((await fx.stored())[0].type, 'members');
    assert.equal(fx.calls.rename.length, 0);

    const changed = await req(path, 'PATCH', { confirmed: true, revision, type: 'members_only' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body, { ok: true, changed: true, refresh: { status: 'renamed', retryAt: null } });
    assert.equal(fx.channels.get(created.channelId).name, 'Members-3');

    // The old revision no longer matches; with the new one the name has to wait for Discord's limit.
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision, type: 'members' })).status, 409);
    const next = await req(path, 'PATCH', { confirmed: true, revision: (await view()).revision, type: 'members' });
    assert.equal(next.body.refresh.status, 'deferred');
    assert.ok(next.body.refresh.retryAt > Date.now());
    const after = await view();
    assert.equal(after.counters[0].type, 'members');
    assert.equal(after.counters[0].current, false);
    assert.equal(after.counters[0].nextRenameAt, next.body.refresh.retryAt);
    assert.equal(fx.channels.get(created.channelId).name, 'Members-3');
});

test('API delete: needs the current revision; a refused channel delete keeps the counter; success removes both', { skip }, async (t) => {
    const { fx, req, view, make } = await api(t);
    const { body: created } = await make('members');
    const { revision } = await view();
    const path = `/server-stats/counters/${created.id}`;

    assert.equal((await req(path, 'DELETE', { confirmed: true })).status, 400);
    assert.equal((await req(path, 'DELETE', { revision })).status, 400);
    assert.equal((await req(path, 'DELETE', { confirmed: true, revision: '0'.repeat(64) })).status, 409);
    assert.equal((await req('/server-stats/counters/12345', 'DELETE', { confirmed: true, revision })).status, 404);
    assert.equal((await req('/server-stats/counters/a%20b', 'DELETE', { confirmed: true, revision })).status, 400);
    assert.equal((await req(path, 'DELETE', { confirmed: true, revision }, { csrf: false })).status, 403);
    assert.equal(fx.calls.delete.length, 0);

    fx.hooks.deleteChannel = () => { throw missingPermissions(); };
    const refused = await req(path, 'DELETE', { confirmed: true, revision });
    assert.equal(refused.status, 502);
    assert.equal((await fx.stored()).length, 1);
    assert.equal(fx.channels.has(created.channelId), true);
    fx.hooks.deleteChannel = null;

    const removed = await req(path, 'DELETE', { confirmed: true, revision });
    assert.deepEqual(removed.body, { ok: true, channelDeleted: true, channelKept: false });
    assert.match(fx.calls.delete.at(-1).reason, /^Server stats counter deleted by .* via dashboard$/);
    assert.deepEqual(await fx.stored(), []);
    assert.equal(fx.channels.has(created.channelId), false);
});

test('API: a database failure is a 503 without details and reaches neither Discord nor the browser with its message', { skip }, async (t) => {
    const { fx, req } = await api(t);
    fx.control.failQuery = (sql) => /SELECT counters/.test(sql);
    const read = await req('/server-stats');
    assert.equal(read.status, 503);
    assert.deepEqual(read.body, { error: 'Counter tidak dapat dibaca dari database.' });
    const write = await req('/server-stats/counters', 'POST', { confirmed: true, type: 'members', channelType: 'voice', categoryId: fx.category.id });
    assert.equal(write.status, 503);
    assert.doesNotMatch(JSON.stringify(write.body), /injected/);
    assert.equal(fx.calls.create.length, 0);
    fx.control.failQuery = null;
});

test('API: malformed and oversized JSON are answered in the API format', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    fx.client.isReady = () => true;
    const app = (await import('express')).default();
    app.use('/api', createServerStatsApi(fx.client, { auth: (req, res, next) => { req.guild = fx.guild; next(); }, csrf: (req, res, next) => next() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const send = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/server-stats/counters`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

    const malformed = await send('{"confirmed":');
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Permintaan tidak valid.' });
    const large = await send(JSON.stringify({ confirmed: true, pad: 'x'.repeat(5000) }));
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), { error: 'Permintaan tidak valid.' });
    assert.equal(fx.calls.create.length, 0);
});

// ---- page ---------------------------------------------------------------------------

/** The dashboard page on the Server Stats room; its requests go to the real router. */
async function openPage(t, { confirm = true, url = 'http://localhost/dashboard/#features/server-stats', options } = {}) {
    const { fx, req } = await api(t, options);
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    const confirms = [];
    const calls = [];
    let inflight = 0;
    w.confirm = (message) => { confirms.push(message); return typeof confirm === 'function' ? confirm(message) : confirm; };
    w.fetch = async (target, init = {}) => {
        const path = String(target);
        const method = init.method || 'GET';
        if (path.endsWith('/api/me')) return { ok: true, status: 200, json: async () => ({ user: { username: 'Tester' }, guild: { name: 'Home' }, csrf: 'c', botOwner: true }) };
        if (!path.startsWith('/dashboard/api/bot/server-stats')) return { ok: false, status: 503, json: async () => ({ error: 'tidak tersedia' }) };
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path: path.replace('/dashboard/api/bot', ''), body, csrf: init.headers?.['x-csrf-token'] });
        inflight++;
        try {
            const answer = await req(path.replace('/dashboard/api/bot', ''), method, body);
            return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
        } finally {
            inflight--;
        }
    };
    for (const name of scripts) w.eval(fs.readFileSync(dir + name, 'utf8'));
    const settle = async () => {
        for (let quiet = 0, spent = 0; quiet < 4 && spent < 800; spent++) {
            await tick();
            quiet = inflight === 0 ? quiet + 1 : 0;
        }
    };
    await settle();
    const root = () => w.document.querySelector('#serverStatsLive');
    const submit = async (form) => { form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await settle(); };
    const writes = () => calls.filter((call) => call.method !== 'GET');
    return { fx, w, root, submit, settle, confirms, calls, writes };
}

test('page: create a counter from the form, after a confirmation that names what is created', { skip }, async (t) => {
    const page = await openPage(t, { options: { humans: 3, bots: 1 } });
    const { fx } = page;
    assert.match(page.w.document.querySelector('.f-demo-warning').textContent, /DATA POSTGRESQL · MEMBUAT DAN MENGHAPUS CHANNEL DI DISCORD/);
    assert.match(page.root().querySelector('#serverStatsList').textContent, /Belum ada counter/);

    const form = page.root().querySelector('#serverStatsCreateForm');
    assert.deepEqual([...form.elements.type.options].map((option) => option.value), ['members', 'members_only', 'bots']);

    // Without a category nothing is asked and nothing is sent.
    await page.submit(form);
    assert.match(page.root().querySelector('#serverStatsCreateStatus').textContent, /Pilih kategori/);
    assert.deepEqual([page.confirms.length, page.writes().length], [0, 0]);

    form.elements.type.value = 'bots';
    form.elements.channelType.value = 'text';
    form.elements.categoryId.value = fx.category.id;
    await page.submit(form);

    assert.equal(page.confirms.length, 1);
    assert.match(page.confirms[0], /channel teks baru di kategori "Stats" untuk counter "Bot saja"/);
    assert.deepEqual(page.writes(), [{
        method: 'POST', path: '/server-stats/counters', csrf: 'c',
        body: { confirmed: true, type: 'bots', channelType: 'text', categoryId: fx.category.id },
    }]);
    const [stored] = await fx.stored();
    assert.equal(stored.type, 'bots');
    assert.equal(fx.channels.get(stored.channelId).type, ChannelType.GuildText);

    // The page reloaded: the counter is listed, and its type is no longer offered for a new counter.
    const listed = page.root().querySelector('form[data-counter]');
    assert.match(listed.textContent, /bots-1/);
    assert.match(listed.textContent, /Jumlah saat ini: 1/);
    assert.match(listed.textContent, /Sesuai jumlah saat ini/);
    assert.match(page.root().querySelector('#serverStatsStatus').textContent, /Counter dibuat: channel "bots-1"/);
    assert.deepEqual([...page.root().querySelector('#serverStatsCreateForm').elements.type.options].map((option) => option.value), ['members', 'members_only']);
});

test('page: declining the confirmation sends nothing', { skip }, async (t) => {
    const page = await openPage(t, { confirm: false });
    const form = page.root().querySelector('#serverStatsCreateForm');
    form.elements.categoryId.value = page.fx.category.id;
    await page.submit(form);
    assert.equal(page.confirms.length, 1);
    assert.equal(page.writes().length, 0);
    assert.equal(page.fx.calls.create.length, 0);
});

test('page: change the type and delete a counter; the delete confirmation says the channel is removed from Discord', { skip }, async (t) => {
    const page = await openPage(t, { options: { humans: 3, bots: 1 } });
    const { fx } = page;
    const create = page.root().querySelector('#serverStatsCreateForm');
    create.elements.categoryId.value = fx.category.id;
    await page.submit(create);
    const [stored] = await fx.stored();
    page.calls.length = 0;
    page.confirms.length = 0;

    let form = page.root().querySelector('form[data-counter]');
    await page.submit(form);
    assert.match(page.root().querySelector('#serverStatsStatus').textContent, /Jenis tidak berubah/);
    assert.equal(page.writes().length, 0);

    form.elements.type.value = 'members_only';
    await page.submit(form);
    assert.match(page.confirms[0], /menjadi "Anggota saja"\? Nama channel di Discord akan ikut berubah/);
    const [patch] = page.writes();
    assert.equal(patch.method, 'PATCH');
    assert.equal(patch.path, `/server-stats/counters/${stored.id}`);
    assert.deepEqual(Object.keys(patch.body).sort(), ['confirmed', 'revision', 'type']);
    assert.equal(patch.body.type, 'members_only');
    assert.equal(patch.csrf, 'c');
    assert.equal((await fx.stored())[0].type, 'members_only');
    assert.equal(fx.channels.get(stored.channelId).name, 'Members-3');
    assert.match(page.root().querySelector('#serverStatsStatus').textContent, /Jenis counter diubah\. Nama channel sudah mengikuti/);

    page.calls.length = 0;
    page.confirms.length = 0;
    form = page.root().querySelector('form[data-counter]');
    form.querySelector('[data-delete]').click();
    await page.settle();
    assert.match(page.confirms[0], /Channel "Members-3" DIHAPUS dari Discord dan tidak dapat dikembalikan/);
    const [del] = page.writes();
    assert.equal(del.method, 'DELETE');
    assert.deepEqual(Object.keys(del.body).sort(), ['confirmed', 'revision']);
    assert.deepEqual(await fx.stored(), []);
    assert.equal(fx.channels.has(stored.channelId), false);
    assert.match(page.root().querySelector('#serverStatsStatus').textContent, /Counter dan channel-nya dihapus/);
    assert.equal(page.root().querySelector('form[data-counter]'), null);
});

test('page: a refusal is shown in place and the controls work again; a stale page is told to reload', { skip }, async (t) => {
    const page = await openPage(t);
    const { fx } = page;
    const create = page.root().querySelector('#serverStatsCreateForm');
    create.elements.categoryId.value = fx.category.id;
    fx.hooks.createChannel = () => { throw missingPermissions(); };
    await page.submit(create);
    assert.match(page.root().querySelector('#serverStatsCreateStatus').textContent, /Discord menolak perubahan channel\. Tidak ada yang diubah\. Bila hasilnya tidak jelas, muat ulang/);
    assert.equal(create.querySelector('button').disabled, false);
    assert.equal(create.isConnected, true, 'the form with the entered values stays');

    fx.hooks.createChannel = null;
    await page.submit(create);
    assert.equal((await fx.stored()).length, 1);

    // Someone else changes the list; this page still holds the old revision.
    const [stored] = await fx.stored();
    await fx.store([{ ...stored, type: 'bots' }]);
    const form = page.root().querySelector('form[data-counter]');
    form.querySelector('[data-delete]').click();
    await page.settle();
    assert.match(page.root().querySelector('#serverStatsStatus').textContent, /Daftar counter berubah sejak halaman dimuat/);
    assert.equal(fx.channels.has(stored.channelId), true, 'nothing is deleted from a stale page');
});

test('page: names from Discord are shown as text; categories the bot cannot use are not selectable; states are described', { skip }, async (t) => {
    const page = await openPage(t, { options: { humans: 3, bots: 1 } });
    const { fx } = page;
    const hostile = fx.makeChannel({ name: '<img src=x onerror=alert(1)>', type: ChannelType.GuildVoice });
    const locked = fx.makeChannel({ id: '810000000000000002', name: '"><svg onload=alert(1)>', type: ChannelType.GuildCategory });
    fx.setBotPermissions(locked.id, ['ViewChannel']);
    await fx.store([
        { id: '1', type: 'members', channelId: hostile.id, guildId, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: '2', type: 'bots', channelId: '830000000000000002', guildId, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: '3', type: 'boosts', channelId: '830000000000000003', guildId, enabled: true, createdAt: '2026-01-01T00:00:00.000Z' },
        { broken: true },
    ]);
    page.root().querySelector('#serverStatsReload').click();
    await page.settle();

    const root = page.root();
    assert.equal(root.querySelector('img,svg'), null, 'server data is never parsed as HTML');
    const forms = [...root.querySelectorAll('form[data-counter]')];
    assert.equal(forms.length, 3);
    assert.match(forms[0].textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(forms[0].textContent, /Nama akan diperbarui pada penyegaran berikutnya/);
    assert.match(forms[1].textContent, /Channel tidak terlihat oleh bot/);
    assert.match(forms[2].textContent, /Jenis tidak dikenal/);
    assert.deepEqual([...forms[2].elements.type.options].map((option) => option.value), ['boosts', 'members_only']);
    assert.match(root.textContent, /1 entri tersimpan tidak dapat dibaca/);
    assert.doesNotMatch(root.textContent, /undefined|NaN|\[object/);

    const options = [...root.querySelector('#serverStatsCreateForm').elements.categoryId.options];
    assert.deepEqual(options.map((option) => [option.value, option.disabled]), [['', false], [fx.category.id, false], [locked.id, true]]);
    assert.match(options[2].textContent, /izin bot kurang/);
    assert.equal(fx.calls.rename.length + fx.calls.delete.length + fx.calls.create.length, 0, 'looking at the page changes nothing');
});

test('page: a read failure offers a retry and no create form', { skip }, async (t) => {
    const page = await openPage(t);
    page.fx.control.failQuery = (sql) => /SELECT counters/.test(sql);
    page.root().querySelector('#serverStatsReload').click();
    await page.settle();
    assert.match(page.root().querySelector('#serverStatsList').textContent, /Counter tidak dapat dibaca dari database/);
    assert.equal(page.root().querySelector('#serverStatsCreateForm'), null);

    page.fx.control.failQuery = null;
    page.root().querySelector('#serverStatsRetry').click();
    await page.settle();
    assert.ok(page.root().querySelector('#serverStatsCreateForm'));
});

test('static preview: the Server Stats room is a labelled placeholder and requests nothing', { skip }, async (t) => {
    const page = await openPage(t, { url: 'http://localhost/preview/#features/server-stats' });
    assert.equal(page.root(), null);
    assert.match(page.w.document.querySelector('.f-demo-warning').textContent, /PREVIEW · DATA CONTOH · TIDAK TERHUBUNG KE DISCORD/);
    assert.match(page.w.document.querySelector('.f-content').textContent, /Preview saja; tidak terhubung ke bot/);
    assert.deepEqual(page.calls, []);
});

test.after(() => counterRefresher.reset());
