// AI provider chain: one primary provider and up to three backups, tried in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { DEFAULT_AI, PROVIDERS, BACKUP_SLOTS, validateSettings, upgradeSettings, providerChain, createAIFoundation, createAIStore } from '../src/services/ai/foundation.js';
import { createAIApi } from '../src/dashboard/aiApi.js';

const guild = '123456789012345678', user = '234567890123456789';
const client = { homeGuildId: guild };
const full = Object.freeze({
    ...DEFAULT_AI, enabled: true, providerDataConsent: true,
    primary: 'groq', primaryModel: 'model-groq',
    backup: 'gemini', backupModel: 'model-gemini',
    backup2: 'openrouter', backup2Model: 'vendor/model-openrouter:free',
    backup3: 'nvidia', backup3Model: 'model-nvidia',
});
const allKeys = { AI_GROQ_API_KEY: 'key-groq', AI_GEMINI_API_KEY: 'key-gemini', AI_OPENROUTER_API_KEY: 'key-openrouter', AI_NVIDIA_API_KEY: 'key-nvidia' };
// What a record saved before this change looks like: one backup, no backup2 / backup3 keys.
const legacy = Object.freeze({ enabled: true, providerDataConsent: true, primary: 'groq', primaryModel: 'model-groq', backup: 'gemini', backupModel: 'model-gemini', perUserDaily: 20, guildDaily: 200, timeoutSeconds: 20, maxOutputTokens: 256 });

const good = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 });
const providerOf = (url) => Object.entries(PROVIDERS).find(([, p]) => p.url === url)[0];

function memoryStore(settings) {
    let count = 0;
    return { get count() { return count; }, read: async () => ({ ...settings }), save: async () => {}, reserve: async () => { count++; return { day: '2026-11-14', guild: count, user: count }; } };
}

/** A foundation whose providers answer as `answers` says: a status number, 'throw', or a text. */
function chainOf(settings, answers, env = allKeys) {
    const calls = [];
    const store = memoryStore(settings);
    const foundation = createAIFoundation({
        client, store, env,
        fetchImpl: async (url, options) => {
            const id = providerOf(url);
            calls.push({ id, model: JSON.parse(options.body).model, authorization: options.headers.Authorization });
            const answer = answers[id];
            if (answer === 'throw') throw new Error('network down');
            return typeof answer === 'number' ? new Response('', { status: answer }) : good(answer);
        },
    });
    return { foundation, calls, store, ask: () => foundation.generate({ guildId: guild, userId: user, prompt: 'hello', consent: true }) };
}

test('the defaults have three backup slots, all empty', () => {
    assert.deepEqual(BACKUP_SLOTS, [['backup', 'backupModel'], ['backup2', 'backup2Model'], ['backup3', 'backup3Model']]);
    for (const [provider, model] of BACKUP_SLOTS) {
        assert.equal(DEFAULT_AI[provider], 'none');
        assert.equal(DEFAULT_AI[model], '');
    }
    assert.deepEqual(validateSettings({ ...DEFAULT_AI }), { ...DEFAULT_AI });
    assert.deepEqual(providerChain(DEFAULT_AI), [['groq', '']]);
});

test('settings with three backups are accepted and give a chain of four in order', () => {
    assert.deepEqual(validateSettings({ ...full }), { ...full });
    assert.deepEqual(providerChain(full), [
        ['groq', 'model-groq'], ['gemini', 'model-gemini'], ['openrouter', 'vendor/model-openrouter:free'], ['nvidia', 'model-nvidia'],
    ]);
});

test('an empty slot between two backups is allowed and skipped', () => {
    const gap = { ...full, backup: 'none', backupModel: '', backup2: 'none', backup2Model: '' };
    assert.deepEqual(validateSettings(gap), gap);
    assert.deepEqual(providerChain(gap), [['groq', 'model-groq'], ['nvidia', 'model-nvidia']]);
});

test('every backup slot is checked: provider, model, and no provider twice', () => {
    const refused = (change, message) => assert.throws(() => validateSettings({ ...full, ...change }), { code: 'INVALID_SETTINGS', message });
    for (const [provider, model] of BACKUP_SLOTS) {
        refused({ [provider]: 'evil' }, 'Provider tidak didukung.');
        refused({ [provider]: undefined }, 'Provider tidak didukung.');
        refused({ [model]: '' }, /Model atau persetujuan/);                       // a provider without a model
        refused({ [model]: 'http://evil?x=1' }, /Model atau persetujuan/);
        refused({ [model]: 42 }, /Model atau persetujuan/);
        refused({ [provider]: 'none' }, /Model atau persetujuan/);                // a model without a provider
        refused({ [provider]: 'groq' }, /harus berbeda/);                         // same as the primary
    }
    refused({ backup2: 'gemini' }, /harus berbeda/);
    refused({ backup3: 'gemini' }, /harus berbeda/);
    refused({ backup3: 'openrouter' }, /harus berbeda/);
    // The four keys are part of the shape: a body without them is not a complete form.
    assert.throws(() => validateSettings({ ...legacy }), { code: 'INVALID_SETTINGS', message: 'Pengaturan AI tidak valid.' });
});

test('a record saved before the change is read as "no second or third backup"', () => {
    const upgraded = upgradeSettings(legacy);
    assert.deepEqual(upgraded, { ...legacy, backup2: 'none', backup2Model: '', backup3: 'none', backup3Model: '' });
    assert.deepEqual(validateSettings(upgraded), upgraded);
    assert.deepEqual(providerChain(upgraded), [['groq', 'model-groq'], ['gemini', 'model-gemini']]);
    // A record that already has any of the keys is not touched, so a damaged one still fails validation.
    assert.equal(upgradeSettings(full), full);
    const partial = { ...legacy, backup2: 'nvidia' };
    assert.equal(upgradeSettings(partial), partial);
    assert.throws(() => validateSettings(upgradeSettings(partial)), { code: 'INVALID_SETTINGS' });
    for (const odd of [null, undefined, 'text', 7, []]) assert.equal(upgradeSettings(odd), odd);
});

test('the PostgreSQL store upgrades an old record on read and saves the new shape', async () => {
    const rows = new Map([[`ai:foundation:config:${guild}`, { ...legacy }]]);
    const pool = {
        query: async (sql, args) => {
            if (sql.startsWith('SELECT value')) return { rows: rows.has(args[0]) ? [{ value: rows.get(args[0]) }] : [] };
            if (sql.startsWith('INSERT INTO')) { rows.set(args[0], JSON.parse(args[1])); return { rows: [] }; }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
    const store = createAIStore({ db: { getStatus: () => ({ isDegraded: false }), isAvailable: () => true, db: { isAvailable: () => true, pool } } });

    const read = await store.read(guild);
    assert.deepEqual(read, { ...legacy, backup2: 'none', backup2Model: '', backup3: 'none', backup3Model: '' });
    assert.deepEqual(rows.get(`ai:foundation:config:${guild}`), { ...legacy }, 'reading does not rewrite the record');

    await store.save(guild, { ...read, backup2: 'nvidia', backup2Model: 'model-nvidia' });
    assert.equal(rows.get(`ai:foundation:config:${guild}`).backup2, 'nvidia');
    assert.equal((await store.read(guild)).backup2Model, 'model-nvidia');
    assert.deepEqual(await store.read('999999999999999999'), { ...DEFAULT_AI });

    rows.set(`ai:foundation:config:${guild}`, { ...legacy, primary: 'evil' });
    await assert.rejects(store.read(guild), { code: 'INVALID_SETTINGS' });
});

const hasSQLite = await import('node:sqlite').then(() => true, () => false);

test('the SQLite store upgrades an old record on read too', { skip: !hasSQLite && 'node:sqlite needs Node 22.5 or newer' }, async (t) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openSQLiteStore } = await import('../src/services/storage/sqlite.js');
    const dir = mkdtempSync(join(tmpdir(), 'zentix-ai-chain-'));
    const sqlite = await openSQLiteStore({ path: join(dir, 'data.db') });
    t.after(() => { sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
    const store = createAIStore({ homeGuildId: guild, db: { getStatus: () => ({ isDegraded: false }), isAvailable: () => true, db: { sqlite, isAvailable: () => true } } });

    sqlite.set(`ai:foundation:config:${guild}`, { ...legacy });
    const read = await store.read(guild);
    assert.deepEqual(read, { ...legacy, backup2: 'none', backup2Model: '', backup3: 'none', backup3Model: '' });

    await store.save(guild, { ...full });
    assert.deepEqual(await store.read(guild), { ...full });
    assert.deepEqual(sqlite.get(`ai:foundation:config:${guild}`), { ...full });
});

test('each provider is tried in order until one answers', async () => {
    const first = chainOf(full, { groq: 'from groq' });
    const a = await first.ask();
    assert.deepEqual([a.provider, a.model, a.usedFallback, a.text], ['groq', 'model-groq', false, 'from groq']);
    assert.deepEqual(first.calls.map((c) => c.id), ['groq']);

    const second = chainOf(full, { groq: 429, gemini: 'from gemini' });
    const b = await second.ask();
    assert.deepEqual([b.provider, b.usedFallback], ['gemini', true]);
    assert.deepEqual(second.calls.map((c) => c.id), ['groq', 'gemini']);

    const third = chainOf(full, { groq: 429, gemini: 503, openrouter: 'from openrouter' });
    const c = await third.ask();
    assert.deepEqual([c.provider, c.model, c.usedFallback], ['openrouter', 'vendor/model-openrouter:free', true]);
    assert.deepEqual(third.calls.map((x) => x.id), ['groq', 'gemini', 'openrouter']);

    const fourth = chainOf(full, { groq: 429, gemini: 'throw', openrouter: 401, nvidia: 'from nvidia' });
    const d = await fourth.ask();
    assert.deepEqual([d.provider, d.model, d.usedFallback, d.text], ['nvidia', 'model-nvidia', true, 'from nvidia']);
    assert.deepEqual(fourth.calls, [
        { id: 'groq', model: 'model-groq', authorization: 'Bearer key-groq' },
        { id: 'gemini', model: 'model-gemini', authorization: 'Bearer key-gemini' },
        { id: 'openrouter', model: 'vendor/model-openrouter:free', authorization: 'Bearer key-openrouter' },
        { id: 'nvidia', model: 'model-nvidia', authorization: 'Bearer key-nvidia' },
    ]);
    assert.equal(fourth.store.count, 1, 'one request costs one unit of quota, however many providers were tried');
});

test('when all four fail the request fails once, after trying each', async () => {
    const all = chainOf(full, { groq: 429, gemini: 500, openrouter: 'throw', nvidia: 404 });
    await assert.rejects(all.ask(), { code: 'PROVIDERS_UNAVAILABLE', status: 503, message: 'Semua provider gagal atau timeout.' });
    assert.deepEqual(all.calls.map((c) => c.id), ['groq', 'gemini', 'openrouter', 'nvidia']);
    assert.equal(all.store.count, 1);
});

test('a provider without an API key is skipped, and the order of the rest is kept', async () => {
    const env = { AI_GROQ_API_KEY: 'key-groq', AI_NVIDIA_API_KEY: 'key-nvidia', AI_GEMINI_API_KEY: '   ' };
    const some = chainOf(full, { groq: 429, nvidia: 'from nvidia' }, env);
    const r = await some.ask();
    assert.equal(r.provider, 'nvidia');
    assert.deepEqual(some.calls.map((c) => c.id), ['groq', 'nvidia']);

    // Only the third backup has a key: the request still goes out.
    const last = chainOf(full, { nvidia: 'only nvidia' }, { AI_NVIDIA_API_KEY: 'key-nvidia' });
    assert.equal((await last.ask()).usedFallback, true);
    assert.deepEqual(last.calls.map((c) => c.id), ['nvidia']);

    // A key exists, but for a provider that is not in the chain.
    const unused = chainOf({ ...full, backup3: 'none', backup3Model: '' }, {}, { AI_NVIDIA_API_KEY: 'key-nvidia' });
    await assert.rejects(unused.ask(), { code: 'NO_CREDENTIALS' });
    assert.equal(unused.calls.length, 0);
    assert.equal(unused.store.count, 0);
});

test('a refusal or a blocked answer stops the chain: the next backup is not asked', async () => {
    const rejected = chainOf(full, { groq: 400, gemini: 'never' });
    await assert.rejects(rejected.ask(), { code: 'REQUEST_REJECTED' });
    assert.deepEqual(rejected.calls.map((c) => c.id), ['groq']);

    const later = chainOf(full, { groq: 429, gemini: 503, openrouter: 422, nvidia: 'never' });
    await assert.rejects(later.ask(), { code: 'REQUEST_REJECTED' });
    assert.deepEqual(later.calls.map((c) => c.id), ['groq', 'gemini', 'openrouter']);
});

test('the dashboard API saves three backups and refuses a duplicate provider', async (t) => {
    let saved = { ...DEFAULT_AI };
    const store = { read: async () => ({ ...saved }), save: async (id, v) => { saved = { ...v }; return v; }, reserve: async () => ({}) };
    const foundation = createAIFoundation({ client, store, env: allKeys, fetchImpl: async () => good('ok') });
    const app = express();
    const auth = (req, res, next) => { req.session = { user: { id: user } }; req.guild = { id: guild }; next(); };
    app.use('/ai', express.json(), createAIApi(client, { auth, csrf: (req, res, next) => next(), env: { OWNER_IDS: user }, foundation }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    t.after(() => server.close());
    const patch = (body) => fetch(`http://127.0.0.1:${server.address().port}/ai/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const ok = await patch(full);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).settings, { ...full });
    assert.deepEqual(saved, { ...full });

    const twice = await patch({ ...full, backup3: 'gemini' });
    assert.equal(twice.status, 400);
    assert.match((await twice.json()).error, /harus berbeda/);
    const old = await patch(legacy);
    assert.equal(old.status, 400);
    assert.deepEqual(saved, { ...full }, 'a refused save changes nothing');

    const read = await (await fetch(`http://127.0.0.1:${server.address().port}/ai/settings`)).json();
    assert.deepEqual(read.settings, { ...full });
    assert.deepEqual(read.credentials, { groq: true, gemini: true, openrouter: true, nvidia: true });
});

async function providerPage(t, settings) {
    const html = fs.readFileSync('dashboard-preview/index.html', 'utf8').replace(/<script src=".*?"><\/script>/g, '');
    const dom = new JSDOM(html, { url: 'http://localhost/dashboard/#ai/providers', runScripts: 'outside-only' });
    const w = dom.window;
    t.after(() => w.close());
    w.scrollTo = () => {};
    const page = { posted: null, w };
    w.fetch = async (url, options = {}) => ({
        ok: true,
        json: async () => {
            if (String(url).endsWith('/me')) return { user: { username: 'Owner' }, guild: { name: 'Guild' }, csrf: 'test' };
            if (options.method === 'PATCH') { page.posted = JSON.parse(options.body); return { ok: true }; }
            return { settings, credentials: { groq: true, gemini: false, openrouter: false, nvidia: true } };
        },
    });
    for (const file of ['session.js', 'live.js', 'modules-live.js', 'operations-live.js', 'features.js', 'ai-foundation.js', 'ai-studio.js', 'app.js']) w.eval(fs.readFileSync(`dashboard-preview/${file}`, 'utf8'));
    await new Promise((r) => setTimeout(r, 40));
    page.form = w.document.querySelector('#aiRealForm');
    page.submit = async () => { page.form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 10)); };
    return page;
}

test('the provider page shows three backup slots and sends what the server accepts', async (t) => {
    const page = await providerPage(t, { ...full });
    assert.ok(page.form);
    const labels = [...page.form.querySelectorAll('.f-field b')].map((b) => b.textContent);
    for (const label of ['Provider cadangan 1', 'Model cadangan 1', 'Provider cadangan 2', 'Model cadangan 2', 'Provider cadangan 3', 'Model cadangan 3']) assert.ok(labels.includes(label), label);
    const x = page.form.elements;
    assert.deepEqual([x.backup.value, x.backup2.value, x.backup3.value], ['gemini', 'openrouter', 'nvidia']);
    assert.deepEqual([x.backupModel.value, x.backup2Model.value, x.backup3Model.value], ['model-gemini', 'vendor/model-openrouter:free', 'model-nvidia']);
    assert.deepEqual([...x.backup3.options].map((o) => o.value), ['none', 'groq', 'gemini', 'openrouter', 'nvidia']);
    assert.deepEqual([...x.primary.options].map((o) => o.value), ['groq', 'gemini', 'openrouter', 'nvidia']);

    await page.submit();
    assert.deepEqual(page.posted, { ...full });
    assert.deepEqual(validateSettings(page.posted), { ...full });

    // Turning a slot off drops its model, so a model left in the box cannot make the save fail.
    x.backup2.value = 'none';
    x.backup3Model.value = '  other-model  ';
    await page.submit();
    assert.deepEqual(page.posted, { ...full, backup2: 'none', backup2Model: '', backup3Model: 'other-model' });
    assert.doesNotThrow(() => validateSettings(page.posted));
});

test('the provider page opens settings that have no backup at all', async (t) => {
    const page = await providerPage(t, { ...DEFAULT_AI });
    const x = page.form.elements;
    assert.deepEqual([x.backup.value, x.backup2.value, x.backup3.value], ['none', 'none', 'none']);
    assert.deepEqual([x.backupModel.value, x.backup2Model.value, x.backup3Model.value], ['', '', '']);
    await page.submit();
    assert.deepEqual(page.posted, { ...DEFAULT_AI });
});
