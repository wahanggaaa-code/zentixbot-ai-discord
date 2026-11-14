import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM } from 'jsdom';
import { ChannelType } from 'discord.js';
import { createCountingFixture, GAME_KEY, guildId, memberId } from './helpers/counting-fixture.js';
import { pgEnabled, onSQLite } from './helpers/leveling-postgres-fixture.js';
import { createCountingApi } from '../src/dashboard/countingApi.js';
import { MAX_START } from '../src/services/countingGame/manage.js';
import messageCreate from '../src/events/messageCreate.js';

// The real router and the real page scripts on a disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const dir = 'dashboard-preview/';
const raw = fs.readFileSync(dir + 'index.html', 'utf8');
const scripts = [...raw.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = raw.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = '/counting';
const STALE = 'a'.repeat(64);

async function api(t) {
    const fx = await createCountingFixture(t);
    fx.client.isReady = () => true;
    const req = await fx.startApi([createCountingApi]);
    const view = async () => (await req(BASE)).body;
    const revision = async () => (await view()).revision;
    const setup = async (body = {}) => req(BASE, 'PUT', { confirmed: true, revision: await revision(), channelId: fx.countChannel.id, system: 'decimal', ...body });
    const reset = async (body = {}) => req(`${BASE}/reset`, 'POST', { confirmed: true, revision: await revision(), start: 1, clearScores: false, ...body });
    const disable = async (body = {}) => req(`${BASE}/disable`, 'POST', { confirmed: true, revision: await revision(), ...body });
    return { fx, req, view, revision, setup, reset, disable };
}

// ---- API ------------------------------------------------------------------------

test('API read: the stored game, whether it can run, the leaderboard and what can be chosen; reading changes nothing', { skip }, async (t) => {
    const { fx, req, view } = await api(t);
    fx.makeChannel({ id: '443456789012345703', name: 'voice', type: ChannelType.GuildVoice });
    fx.setBotPermissions(fx.otherChannel.id, ['ViewChannel', 'SendMessages']);

    const empty = await view();
    assert.deepEqual(empty.game, {
        enabled: false, channelId: null, system: 'decimal', nextNumber: 1, currentStreak: 0, bestStreak: 0, channelName: null, expected: '1', lastUserId: null, lastUserName: null,
    });
    assert.deepEqual([empty.health, empty.players, empty.leaderboard, empty.limits], [{ state: 'none', missing: [] }, 0, [], { maxStart: MAX_START }]);
    assert.match(empty.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(empty.systems.map((system) => system.value), ['decimal', 'hexadecimal', 'binary', 'base36', 'base64', 'roman', 'math', 'alphabet']);
    assert.ok(empty.systems.every((system) => system.label && system.description));
    const offered = Object.fromEntries(empty.channels.map((channel) => [channel.name, [channel.usable, channel.missing]]));
    assert.deepEqual(offered.counting, [true, []]);
    assert.deepEqual(offered.general, [false, ['ManageMessages']]);
    assert.equal(offered.voice, undefined, 'text channels only');
    assert.equal(await fx.stored(), undefined, 'reading creates nothing');

    fx.guild.members.cache.set(fx.bob.id, { user: { username: 'bob', globalName: 'Bob <b>' } });
    const stranger = memberId(99); // not a member the bot knows
    await fx.seed({ system: 'roman', nextNumber: 12, currentStreak: 11, bestStreak: 30, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 70, [stranger]: 3 } });
    const running = await view();
    assert.deepEqual(running.game, {
        enabled: true, channelId: fx.countChannel.id, system: 'roman', nextNumber: 12, currentStreak: 11, bestStreak: 30,
        channelName: 'counting', expected: 'XII', lastUserId: fx.bob.id, lastUserName: 'Bob <b>',
    });
    assert.deepEqual(running.leaderboard, [{ userId: fx.bob.id, name: 'Bob <b>', counts: 70 }, { userId: stranger, name: null, counts: 3 }]);
    assert.deepEqual([running.health.state, running.players], ['ok', 2]);
    assert.notEqual(running.revision, empty.revision);

    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel']);
    assert.deepEqual((await view()).health, { state: 'permissions', missing: ['SendMessages', 'ManageMessages'] });
    fx.channels.delete(fx.countChannel.id);
    const gone = await view();
    assert.deepEqual([gone.health.state, gone.game.channelName, gone.game.channelId], ['channel_missing', null, fx.countChannel.id]);

    assert.equal((await req(`${BASE}?x=1`)).status, 400);
    assert.equal(fx.calls.send.length, 0);
});

test('API setup: stores channel and system, keeps the scores, and refuses what /count setup refuses', { skip }, async (t) => {
    const { fx, req, setup, revision } = await api(t);
    const made = await setup({ system: 'binary' });
    assert.deepEqual([made.status, made.body], [200, {
        ok: true, changed: true, game: { enabled: true, channelId: fx.countChannel.id, system: 'binary', nextNumber: 1, currentStreak: 0, bestStreak: 0 },
    }]);
    await fx.seed({ system: 'binary', nextNumber: 5, currentStreak: 4, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 } });
    const same = await setup({ system: 'binary' });
    assert.deepEqual([same.status, same.body.changed, (await fx.stored()).nextNumber], [200, false, 5]);
    const hex = await setup({ system: 'hexadecimal' });
    assert.deepEqual([hex.body.changed, hex.body.game.nextNumber, hex.body.game.bestStreak], [true, 1, 30]);
    assert.deepEqual((await fx.stored()).leaderboard, { [fx.bob.id]: 70 });
    const before = await fx.stored();

    const elsewhere = await setup({ channelId: fx.otherChannel.id });
    assert.deepEqual([elsewhere.status, elsewhere.body], [409, { error: 'Permainan hitung sudah berjalan di channel lain. Nonaktifkan dulu, lalu atur ulang.' }]);
    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel', 'SendMessages']);
    const lacking = await setup({ system: 'roman' });
    assert.deepEqual([lacking.status, lacking.body], [409, { error: 'Bot kekurangan izin di channel itu. Tidak ada yang diubah. Izin yang kurang: Manage Messages.' }]);
    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel', 'SendMessages', 'ManageMessages']);
    const unknown = await setup({ channelId: '443456789012345999' });
    assert.deepEqual([unknown.status, unknown.body], [400, { error: 'Pilih channel teks dari server ini.' }]);
    const stale = await setup({ revision: STALE, system: 'roman' });
    assert.deepEqual([stale.status, stale.body], [409, { error: 'Pengaturan permainan hitung sudah berubah. Muat ulang, lalu coba lagi. Tidak ada yang diubah.' }]);

    const current = await revision();
    for (const body of [
        { confirmed: true, revision: current, channelId: fx.countChannel.id },
        { confirmed: true, revision: current, channelId: fx.countChannel.id, system: 'roman', extra: 1 },
        { confirmed: false, revision: current, channelId: fx.countChannel.id, system: 'roman' },
        { confirmed: 'true', revision: current, channelId: fx.countChannel.id, system: 'roman' },
        { confirmed: true, revision: 'short', channelId: fx.countChannel.id, system: 'roman' },
        { confirmed: true, revision: current, channelId: 'abc', system: 'roman' },
        { confirmed: true, revision: current, channelId: fx.countChannel.id, system: 'klingon' },
        { confirmed: true, revision: current, channelId: fx.countChannel.id, system: 'toString' },
        { confirmed: true, revision: current, channelId: [fx.countChannel.id], system: 'roman' },
        [],
    ]) assert.equal((await req(BASE, 'PUT', body)).status, 400, JSON.stringify(body));
    assert.equal((await req(BASE, 'PUT', { confirmed: true, revision: current, channelId: fx.countChannel.id, system: 'roman' }, { csrf: false })).status, 403);
    assert.deepEqual(await fx.stored(), before);
});

test('API reset and disable: need the current revision; reset clears scores only when asked', { skip }, async (t) => {
    const { fx, req, reset, disable, revision } = await api(t);
    const refused = await reset();
    assert.deepEqual([refused.status, refused.body], [409, { error: 'Aktifkan permainan hitung terlebih dahulu.' }]);
    const nothing = await disable();
    assert.deepEqual([nothing.status, nothing.body.changed], [200, false]);
    assert.equal(await fx.stored(), undefined);

    const seeded = await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 30, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 70 } });
    const current = await revision();
    for (const body of [
        { confirmed: true, revision: current, start: 0, clearScores: false },
        { confirmed: true, revision: current, start: MAX_START + 1, clearScores: false },
        { confirmed: true, revision: current, start: 1.5, clearScores: false },
        { confirmed: true, revision: current, start: '5', clearScores: false },
        { confirmed: true, revision: current, start: 5, clearScores: 'yes' },
        { confirmed: true, revision: current, start: 5 },
        { confirmed: true, start: 5, clearScores: false },
        { revision: current, start: 5, clearScores: false },
    ]) assert.equal((await req(`${BASE}/reset`, 'POST', body)).status, 400, JSON.stringify(body));
    assert.equal((await reset({ revision: STALE })).status, 409);
    assert.equal((await disable({ revision: STALE })).status, 409);
    assert.equal((await req(`${BASE}/disable`, 'POST', { confirmed: true, revision: current, extra: 1 })).status, 400);
    assert.equal((await req(`${BASE}/disable`, 'POST', { confirmed: true, revision: current }, { csrf: false })).status, 403);
    assert.equal((await req(`${BASE}/reset`, 'POST', { confirmed: true, revision: current, start: 5, clearScores: true }, { csrf: false })).status, 403);
    assert.deepEqual(await fx.stored(), seeded);

    const restarted = await reset({ start: 40 });
    assert.deepEqual([restarted.status, restarted.body], [200, { ok: true, game: { enabled: true, channelId: fx.countChannel.id, system: 'decimal', nextNumber: 40, currentStreak: 0, bestStreak: 30 } }]);
    assert.deepEqual(await fx.stored(), { ...seeded, nextNumber: 40, currentStreak: 0, lastUserId: null });
    await reset({ start: 2, clearScores: true });
    assert.deepEqual(await fx.stored(), { ...seeded, nextNumber: 2, currentStreak: 0, lastUserId: null, bestStreak: 0, leaderboard: {} });

    const off = await disable();
    assert.deepEqual([off.status, off.body.changed, off.body.game.enabled], [200, true, false]);
    assert.deepEqual([(await fx.stored()).enabled, (await fx.stored()).channelId], [false, fx.countChannel.id]);
});

test('API: a game set up on the web is the game the bot plays', { skip }, async (t) => {
    const { fx, setup, view, reset } = await api(t);
    await setup({ system: 'hexadecimal' });
    await fx.say(messageCreate, fx.alice, '1');
    await fx.say(messageCreate, fx.bob, '2');
    assert.deepEqual([(await view()).game.nextNumber, (await view()).game.lastUserId], [3, fx.bob.id]);
    // A page opened before those counts can still change the settings.
    await reset({ start: 10 });
    assert.equal((await fx.say(messageCreate, fx.alice, 'a')).deleted, false);
    assert.equal((await fx.say(messageCreate, fx.bob, '11')).deleted, true);
    const after = await view();
    assert.deepEqual([after.game.nextNumber, after.game.bestStreak, after.leaderboard.map((entry) => entry.counts)], [1, 2, [2, 1]]);
});

test('API: bot not ready, database failure and an unreadable stored value change nothing and give no details', { skip }, async (t) => {
    const { fx, req, revision } = await api(t);
    const seeded = await fx.seed({ nextNumber: 5, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 } });
    const current = await revision();
    const writes = () => [
        req(BASE, 'PUT', { confirmed: true, revision: current, channelId: fx.countChannel.id, system: 'roman' }),
        req(`${BASE}/reset`, 'POST', { confirmed: true, revision: current, start: 9, clearScores: true }),
        req(`${BASE}/disable`, 'POST', { confirmed: true, revision: current }),
    ];

    fx.client.isReady = () => false;
    for (const answer of await Promise.all(writes())) assert.deepEqual([answer.status, answer.body], [503, { error: 'Bot belum siap.' }]);
    fx.client.isReady = () => true;

    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    const read = await req(BASE);
    assert.deepEqual([read.status, read.body], [503, { error: 'Permainan hitung tidak dapat dibaca dari database.' }]);
    for (const answer of [await writes()[0], await writes()[1], await writes()[2]]) {
        assert.deepEqual([answer.status, answer.body], [503, { error: 'Database tidak dapat dihubungi. Tidak ada yang diubah.' }]);
    }
    fx.control.failQuery = (sql) => sql === 'COMMIT';
    const unsure = await writes()[2];
    // A failed COMMIT is an unknown outcome on PostgreSQL and a rollback on SQLite.
    assert.deepEqual([unsure.status, unsure.body], [503, { error: onSQLite ? 'Database tidak dapat dihubungi. Tidak ada yang diubah.' : 'Database tidak mengonfirmasi perubahan. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.' }]);
    fx.control.failQuery = null;
    assert.deepEqual(await fx.stored(), seeded);

    await fx.query('UPDATE temp_data SET value = $2::jsonb WHERE key = $1', [GAME_KEY, JSON.stringify('broken')]);
    const unreadable = await req(BASE);
    assert.deepEqual([unreadable.status, unreadable.body], [409, { error: 'Data permainan hitung yang tersimpan tidak dapat dibaca. Tidak ada yang diubah.' }]);
    assert.equal((await req(BASE, 'PUT', { confirmed: true, revision: current, channelId: fx.countChannel.id, system: 'roman' })).status, 409);
    assert.equal(await fx.stored(), 'broken');
});

test('API: every change is handed to the log with the acting user; refusals and no-ops are not, and a failing log changes nothing', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    fx.client.isReady = () => true;
    const records = [];
    let broken = false;
    const audit = async (client, guild, action, details) => {
        if (broken) throw new Error('log channel unavailable');
        records.push([guild, action, details]);
    };
    const app = express();
    app.use('/api', createCountingApi(fx.client, { auth: (req, res, next) => { req.guild = fx.guild; req.member = fx.manager; next(); }, csrf: (req, res, next) => next(), audit }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}/api${BASE}`;
    const send = async (path, method = 'GET', body) => {
        const response = await fetch(origin + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        await tick();
        return { status: response.status, body: await response.json() };
    };
    const revision = async () => (await send('')).body.revision;
    const by = { source: 'dashboard', actorId: fx.manager.id, channelId: fx.countChannel.id };

    await send('', 'PUT', { confirmed: true, revision: await revision(), channelId: fx.countChannel.id, system: 'roman' });
    assert.deepEqual(records.pop(), [guildId, 'setup', { ...by, system: 'Roman' }]);
    await send('', 'PUT', { confirmed: true, revision: await revision(), channelId: fx.countChannel.id, system: 'roman' });
    await send('', 'PUT', { confirmed: true, revision: STALE, channelId: fx.countChannel.id, system: 'binary' });
    await send('/reset', 'POST', { confirmed: true, revision: await revision(), start: 0, clearScores: false });
    await send('/disable', 'POST', { confirmed: false, revision: await revision() });
    assert.deepEqual(records, [], 'no-op and refusals');

    await send('/reset', 'POST', { confirmed: true, revision: await revision(), start: 40, clearScores: true });
    assert.deepEqual(records.pop(), [guildId, 'reset', { ...by, start: 40, scoresCleared: true }]);
    await send('/disable', 'POST', { confirmed: true, revision: await revision() });
    assert.deepEqual(records.pop(), [guildId, 'disable', by]);
    await send('/disable', 'POST', { confirmed: true, revision: await revision() });
    assert.deepEqual(records, []);

    broken = true;
    const made = await send('', 'PUT', { confirmed: true, revision: await revision(), channelId: fx.countChannel.id, system: 'binary' });
    assert.deepEqual([made.status, made.body.changed, (await fx.stored()).system], [200, true, 'binary']);
});

test('API: with a log channel configured, a change made on the web is written there as coming from the dashboard', { skip }, async (t) => {
    const { fx, setup } = await api(t);
    await fx.enableLog();
    assert.equal((await setup({ system: 'alphabet' })).status, 200);
    let entry;
    for (let n = 0; n < 100 && !entry; n++) {
        await tick();
        [entry] = fx.logEntries();
    }
    assert.equal(entry.title, 'Counting Game Set Up');
    assert.match(entry.description, new RegExp(`\\*\\*Source:\\*\\* web dashboard\\n> \\*\\*By:\\*\\* <@\\d{17,20}> \\(\\d{17,20}\\)\\n> \\*\\*Channel:\\*\\* <#${fx.countChannel.id}>\\n> \\*\\*System:\\*\\* Alphabet`));
});

test('API: malformed and oversized JSON are answered in the API format; a request without a member is refused before anything is read', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    fx.client.isReady = () => true;
    const seeded = await fx.seed({ nextNumber: 5 });
    const app = express();
    app.use('/api', createCountingApi(fx.client, { auth: (req, res, next) => { req.guild = fx.guild; next(); }, csrf: (req, res, next) => next() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}/api${BASE}`;
    const send = (method, path, body) => fetch(origin + path, { method, headers: { 'content-type': 'application/json' }, body });

    const malformed = await send('PUT', '', '{"confirmed":');
    assert.deepEqual([malformed.status, await malformed.json()], [400, { error: 'Permintaan tidak valid.' }]);
    const large = await send('PUT', '', JSON.stringify({ confirmed: true, pad: 'x'.repeat(8000) }));
    assert.deepEqual([large.status, await large.json()], [413, { error: 'Permintaan tidak valid.' }]);

    let reads = 0;
    fx.control.failQuery = (sql) => { if (/temp_data/.test(sql)) reads++; return false; };
    const read = await fetch(origin);
    assert.deepEqual([read.status, await read.json()], [403, { error: 'Akses ditolak.' }]);
    for (const [method, path, body] of [
        ['PUT', '', { confirmed: true, revision: STALE, channelId: fx.countChannel.id, system: 'roman' }],
        ['POST', '/reset', { confirmed: true, revision: STALE, start: 5, clearScores: true }],
        ['POST', '/disable', { confirmed: true, revision: STALE }],
    ]) assert.equal((await send(method, path, JSON.stringify(body))).status, 403, path);
    fx.control.failQuery = null;
    assert.equal(reads, 0, 'refused before the database was asked');
    assert.deepEqual(await fx.stored(), seeded);
});

// ---- page ---------------------------------------------------------------------------

/** The dashboard page on the Fun room; its requests go to the real router. */
async function openPage(t, { confirm = true, url = 'http://localhost/dashboard/#features/fun', arrange } = {}) {
    const { fx, req } = await api(t);
    await arrange?.(fx);
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
        if (!path.startsWith('/dashboard/api/bot/counting')) return { ok: false, status: 503, json: async () => ({ error: 'tidak tersedia' }) };
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
    const root = () => w.document.querySelector('#countingLive');
    const q = (selector) => root().querySelector(selector);
    const submit = async (form) => { form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await settle(); };
    const click = async (button) => { button.click(); await settle(); };
    const writes = () => calls.filter((call) => call.method !== 'GET');
    return { fx, w, root, q, submit, click, settle, confirms, calls, writes };
}

test('page: set the game up from the form, after a confirmation that names the channel and what the bot will do there', { skip }, async (t) => {
    const page = await openPage(t);
    const { fx } = page;
    assert.match(page.w.document.querySelector('.f-demo-warning').textContent, /DATA POSTGRESQL · PENGATURAN TERSIMPAN · BOT MENILAI PESAN DI CHANNEL HITUNG/);
    assert.match(page.q('#countingState').textContent, /Status: Belum pernah diatur\./);
    assert.equal(page.q('#countingResetForm'), null, 'nothing to reset or disable yet');
    assert.match(page.q('#countingBoard').textContent, /Belum ada hitungan yang tercatat/);

    const form = page.q('#countingSetupForm');
    assert.equal(form.querySelector('button[type=submit]').textContent, 'AKTIFKAN ↗');
    await page.submit(form);
    assert.equal(page.q('#countingSetupStatus').textContent, 'Pilih channel terlebih dahulu.');
    assert.deepEqual([page.writes(), page.confirms], [[], []]);

    form.elements.channelId.value = fx.countChannel.id;
    form.elements.system.value = 'roman';
    form.elements.system.dispatchEvent(new page.w.Event('change', { bubbles: true }));
    assert.equal(page.q('#countingSystemHint').textContent, 'Roman numerals: I, II, III, IV, V');
    await page.submit(form);
    assert.deepEqual(page.confirms, ['Jalankan permainan hitung di #counting dengan sistem "Roman"? Urutan dimulai dari 1; papan skor dan rekor tetap. '
        + 'Setiap pesan anggota di channel itu akan dinilai, dan pesan yang salah dihapus.']);
    const [write] = page.writes();
    assert.deepEqual([write.method, write.path, write.csrf], ['PUT', '/counting', 'c']);
    assert.deepEqual(Object.keys(write.body).sort(), ['channelId', 'confirmed', 'revision', 'system']);
    assert.deepEqual([write.body.confirmed, write.body.channelId, write.body.system], [true, fx.countChannel.id, 'roman']);
    assert.deepEqual([(await fx.stored()).enabled, (await fx.stored()).system], [true, 'roman']);

    // The page was loaded again and shows the running game.
    assert.equal(page.q('#countingStatus').textContent, 'Permainan hitung disimpan dan aktif.');
    assert.match(page.q('#countingState').textContent, /Status: Aktif\.[\s\S]*Channel: #counting[\s\S]*Sistem: Roman[\s\S]*Angka berikutnya: I /);
    assert.equal(page.q('#countingSetupForm button[type=submit]').textContent, 'SIMPAN ↗');
    assert.ok(page.q('#countingResetForm'));

    // The same settings again: said to change nothing.
    await page.submit(page.q('#countingSetupForm'));
    assert.doesNotMatch(page.confirms.at(-1), /Urutan dimulai dari 1/);
    assert.equal(page.q('#countingStatus').textContent, 'Tidak ada yang berubah; pengaturan sudah seperti itu.');
});

test('page: declining a confirmation sends nothing', { skip }, async (t) => {
    const page = await openPage(t, { confirm: false, arrange: (fx) => fx.seed({ nextNumber: 5, bestStreak: 9 }) });
    const before = await page.fx.stored();
    page.q('#countingSetupForm').elements.system.value = 'binary';
    await page.submit(page.q('#countingSetupForm'));
    page.q('#countingResetForm').elements.clearScores.checked = true;
    await page.submit(page.q('#countingResetForm'));
    await page.click(page.q('#countingDisable'));
    assert.equal(page.confirms.length, 3);
    assert.deepEqual(page.writes(), []);
    assert.deepEqual(await page.fx.stored(), before);
});

test('page: restart the sequence and disable; each confirmation says what is lost and what is kept', { skip }, async (t) => {
    const page = await openPage(t, { arrange: (fx) => fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 } }) });
    const { fx } = page;
    const reset = () => page.q('#countingResetForm');

    for (const bad of ['0', String(MAX_START + 1), '1.5', '']) {
        reset().elements.start.value = bad;
        await page.submit(reset());
        assert.equal(page.q('#countingSetupStatus').textContent, `Angka awal harus antara 1 dan ${MAX_START}.`, JSON.stringify(bad));
    }
    assert.deepEqual([page.writes(), page.confirms], [[], []]);

    reset().elements.start.value = '40';
    await page.submit(reset());
    assert.equal(page.confirms.at(-1), 'Mulai ulang urutan dari 40? Urutan yang sedang berjalan hilang. Papan skor dan rekor tetap.');
    assert.deepEqual([page.writes().at(-1).path, page.writes().at(-1).body.start, page.writes().at(-1).body.clearScores], ['/counting/reset', 40, false]);
    assert.deepEqual([(await fx.stored()).nextNumber, (await fx.stored()).bestStreak], [40, 30]);
    assert.equal(page.q('#countingStatus').textContent, 'Urutan dimulai dari 40.');
    assert.match(page.q('#countingState').textContent, /Angka berikutnya: 40 /);

    reset().elements.clearScores.checked = true;
    await page.submit(reset());
    assert.equal(page.confirms.at(-1), 'Mulai ulang urutan dari 1? Urutan yang sedang berjalan hilang. Papan skor dan rekor DIHAPUS dan tidak dapat dikembalikan.');
    assert.deepEqual(Object.keys(page.writes().at(-1).body).sort(), ['clearScores', 'confirmed', 'revision', 'start']);
    assert.deepEqual([(await fx.stored()).bestStreak, (await fx.stored()).leaderboard], [0, {}]);
    assert.equal(page.q('#countingStatus').textContent, 'Urutan dimulai dari 1. Papan skor dan rekor dikosongkan.');

    await page.click(page.q('#countingDisable'));
    assert.equal(page.confirms.at(-1), 'Nonaktifkan permainan hitung? Pesan di channel itu tidak lagi dinilai. Channel, sistem, papan skor, dan rekor tetap tersimpan.');
    assert.deepEqual([page.writes().at(-1).method, page.writes().at(-1).path, Object.keys(page.writes().at(-1).body).sort()], ['POST', '/counting/disable', ['confirmed', 'revision']]);
    assert.equal((await fx.stored()).enabled, false);
    assert.match(page.q('#countingState').textContent, /Status: Nonaktif\. Pesan di channel tidak dinilai\./);
    assert.equal(page.q('#countingResetForm'), null);
    // The channel is still selected, ready to be turned on again.
    assert.equal(page.q('#countingSetupForm').elements.channelId.value, fx.countChannel.id);
});

test('page: a refusal is shown in place and the controls work again; an outdated page is told to reload', { skip }, async (t) => {
    const page = await openPage(t, { arrange: (fx) => fx.seed({ nextNumber: 5 }) });
    const { fx } = page;
    const form = () => page.q('#countingSetupForm');

    form().elements.channelId.value = fx.otherChannel.id;
    await page.submit(form());
    assert.equal(page.q('#countingSetupStatus').textContent,
        'Permainan hitung sudah berjalan di channel lain. Nonaktifkan dulu, lalu atur ulang. Bila hasilnya tidak jelas, muat ulang dan periksa sebelum mengulang.');
    assert.ok([...page.root().querySelectorAll('button, select, input')].every((control) => !control.disabled), 'controls are usable again');
    assert.equal(form().elements.channelId.value, fx.otherChannel.id, 'what was chosen is still there');

    // Someone else changes the settings while this page is open.
    await fx.seed({ nextNumber: 5, system: 'roman' });
    form().elements.channelId.value = fx.countChannel.id;
    form().elements.system.value = 'binary';
    await page.submit(form());
    assert.match(page.q('#countingSetupStatus').textContent, /^Pengaturan permainan hitung sudah berubah\. Muat ulang, lalu coba lagi\. Tidak ada yang diubah\./);
    assert.equal((await fx.stored()).system, 'roman');
    await page.click(page.q('#countingReload'));
    assert.equal(form().elements.system.value, 'roman');
    await page.click(page.q('#countingDisable'));
    assert.equal((await fx.stored()).enabled, false);
});

test('page: names from Discord are shown as text; channels the bot cannot use are named with what is missing; problems are described', { skip }, async (t) => {
    const evil = '<img src=x onerror=alert(1)>';
    const page = await openPage(t, {
        arrange: async (fx) => {
            fx.makeChannel({ id: '443456789012345705', name: evil });
            fx.setBotPermissions(fx.otherChannel.id, ['ViewChannel', 'SendMessages']);
            fx.guild.members.cache.set(fx.bob.id, { user: { username: 'bob', globalName: evil } });
            await fx.seed({ nextNumber: 12, currentStreak: 3, bestStreak: 30, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 70, [memberId(99)]: 3 } });
        },
    });
    const { fx } = page;
    assert.equal(page.root().querySelectorAll('img').length, 0);
    assert.match(page.q('#countingState').textContent, /Penghitung terakhir: <img src=x onerror=alert\(1\)>/);
    const rows = [...page.q('#countingBoard').querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent));
    assert.deepEqual(rows, [['1', evil, '70'], ['2', `ID ${memberId(99)}`, '3']]);
    assert.match(page.q('#countingBoard').textContent, /2 anggota pernah menghitung dengan benar/);
    const options = [...page.q('#countingSetupForm').elements.channelId.options].map((option) => [option.textContent, option.disabled]);
    assert.deepEqual(options.find(([text]) => text.startsWith('#general')), ['#general (izin bot kurang: Manage Messages)', true]);
    assert.deepEqual(options.find(([text]) => text.includes('img')), [`#${evil}`, false]);
    assert.match(page.q('#countingSetupForm').textContent, /Permainan sedang aktif: untuk pindah channel, nonaktifkan dulu\./);

    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel']);
    await page.click(page.q('#countingReload'));
    assert.equal(page.q('#countingState [role=alert]').textContent, 'Status: Aktif, tetapi bot kekurangan izin di channel itu: Send Messages, Manage Messages.');
    fx.channels.delete(fx.countChannel.id);
    await page.click(page.q('#countingReload'));
    assert.match(page.q('#countingState [role=alert]').textContent, new RegExp(`Aktif, tetapi channel \\(ID ${fx.countChannel.id}\\) tidak terlihat oleh bot`));
    assert.match(page.q('#countingState').textContent, new RegExp(`Channel: Channel tidak terlihat \\(ID ${fx.countChannel.id}\\)`));
    assert.equal(page.q('#countingSetupForm').elements.channelId.value, '', 'a channel that is gone is not preselected');
});

test('page: a read failure offers a retry and no forms; the static preview is a labelled placeholder that requests nothing', { skip }, async (t) => {
    const page = await openPage(t, { arrange: (fx) => { fx.control.failQuery = (sql) => /temp_data/.test(sql); } });
    assert.equal(page.q('#countingState [role=alert]').textContent, 'Permainan hitung tidak dapat dibaca dari database.');
    assert.equal(page.root().querySelectorAll('form').length, 0);
    page.fx.control.failQuery = null;
    await page.click(page.q('#countingRetry'));
    assert.ok(page.q('#countingSetupForm'));

    const preview = await openPage(t, { url: 'http://localhost/preview/#features/fun' });
    assert.equal(preview.root(), null);
    assert.match(preview.w.document.querySelector('.f-demo-warning').textContent, /PREVIEW · DATA CONTOH · TIDAK TERHUBUNG KE DISCORD/);
    assert.match(preview.w.document.querySelector('.f-content').textContent, /Preview saja; tidak terhubung ke bot/);
    assert.deepEqual(preview.calls, []);
});
