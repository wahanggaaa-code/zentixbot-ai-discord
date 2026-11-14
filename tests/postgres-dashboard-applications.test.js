import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM } from 'jsdom';
import { createCommunityFixture, guildId, memberId, roleId } from './helpers/community-fixture.js';
import { pgEnabled, onSQLite } from './helpers/leveling-postgres-fixture.js';
import { createApplicationsApi } from '../src/dashboard/applicationsApi.js';
import { LIMITS, readConfig } from '../src/services/applications/store.js';
import { logger } from '../src/utils/logger.js';

// The real router and the real page scripts on a disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const dir = 'dashboard-preview/';
const raw = fs.readFileSync(dir + 'index.html', 'utf8');
const scripts = [...raw.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = raw.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE = '/applications';

/** The API behind a stand-in for the session check: `who.member` is the signed-in member. */
async function api(t, { arrange } = {}) {
    const fx = await createCommunityFixture(t);
    fx.client.isReady = () => true;
    await arrange?.(fx);
    const who = { member: fx.owner };
    const app = express();
    const auth = (req, res, next) => { req.guild = fx.guild; req.member = who.member; next(); };
    const csrf = (req, res, next) => (req.get('x-csrf') === 'yes' ? next() : res.status(403).json({ error: 'csrf' }));
    app.use('/api', createApplicationsApi(fx.client, { auth, csrf }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}/api`;
    const req = async (path, method = 'GET', body, { csrf: sendCsrf = true, rawBody } = {}) => {
        const headers = {};
        if (sendCsrf) headers['x-csrf'] = 'yes';
        if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(origin + path, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
        return { status: response.status, body: await response.json().catch(() => null), cache: response.headers.get('cache-control') };
    };
    const view = async () => (await req(BASE)).body;
    const revision = async () => (await view()).revision;
    const settings = async (body = {}) => req(`${BASE}/settings`, 'PUT', { confirmed: true, revision: await revision(), enabled: true, managerRoles: [], pendingDays: 30, reviewedDays: 30, ...body });
    const create = async (body = {}) => req(`${BASE}/forms`, 'POST', { confirmed: true, revision: await revision(), roleId: fx.staff.id, name: 'Staff', questions: ['Why?'], ...body });
    const update = async (role, body = {}) => req(`${BASE}/forms/${role}`, 'PUT', { confirmed: true, revision: await revision(), name: 'Staff', enabled: true, questions: ['Why?'], ...body });
    const remove = async (role, body = {}) => req(`${BASE}/forms/${role}/delete`, 'POST', { confirmed: true, revision: await revision(), ...body });
    return { fx, who, req, view, revision, settings, create, update, remove };
}
const INVALID = { error: 'Permintaan tidak valid.' };

// ---- API ------------------------------------------------------------------------

test('API read: settings, forms, counts and the roles this member may offer; no answers, and reading stores nothing', { skip }, async (t) => {
    const { fx, who, req, view } = await api(t);
    const empty = await view();
    assert.deepEqual(empty.settings, { enabled: false, managerRoles: [], pendingDays: 30, reviewedDays: 30 });
    assert.deepEqual([empty.revision, empty.forms, empty.counts], [0, [], { pending: 0, approved: 0, denied: 0 }]);
    assert.deepEqual(empty.logging, { channelId: null, channelName: null, channelUsable: false, enabled: false, applicationEvents: true });
    assert.deepEqual(empty.limits, { forms: 25, questions: 5, question: 100, formName: 50, managerRoles: 10, retentionMin: 1, retentionMax: 3650 });
    assert.equal(empty.rolesTruncated, false);
    assert.deepEqual(await fx.stored(), {}, 'reading creates nothing');
    assert.equal((await req(BASE)).cache, 'no-store');

    // The owner may offer whatever the bot can give; the reasons are the bot's.
    const forOwner = Object.fromEntries(empty.roles.map((role) => [role.name, role.offerable ? true : role.reason]));
    assert.equal(forOwner.Staff, true);
    assert.equal(forOwner.Admin, true);
    assert.equal(forOwner.Founder, 'Posisinya tidak di bawah role tertinggi bot.');
    assert.equal(forOwner.Booster, 'Role dikelola oleh integrasi dan tidak dapat diberikan kepada anggota.');
    assert.equal(forOwner['@everyone'], undefined);
    assert.deepEqual(empty.roles.slice(0, 2).map((role) => role.name), ['Founder', 'ZentixBot'], 'highest first');

    // An administrator who is not the owner: only roles below their own highest role.
    who.member = fx.admin;
    const forAdmin = Object.fromEntries((await view()).roles.map((role) => [role.name, role.offerable ? true : role.reason]));
    assert.equal(forAdmin.Staff, true);
    assert.equal(forAdmin.Admin, 'Posisinya tidak di bawah role tertinggi Anda.');
    who.member = fx.owner;

    await fx.seedConfig({
        settings: { enabled: true, managerRoles: [fx.reviewerRole.id], pendingApplicationRetentionDays: 7, revision: 4 },
        forms: [{ role: fx.staff, name: 'Staff <b>', questions: ['Why?'] }, { role: fx.aboveBot, name: 'Founder', enabled: false }, { role: { id: '553456789012345999' }, name: 'Ghost' }],
    });
    await fx.logTo(fx.reports);
    await fx.applyFor(fx.alice, 'Staff <b>', ['My secret answer']);
    const now = Date.now();
    await fx.seed(`${now - 5000}-denied`, { userId: fx.bob.id, roleId: fx.staff.id, status: 'denied', reviewedAt: new Date(now).toISOString(), answers: [{ question: 'Why?', answer: 'Another secret' }] });

    const full = await view();
    assert.deepEqual(full.settings, { enabled: true, managerRoles: [fx.reviewerRole.id], pendingDays: 7, reviewedDays: 30 });
    assert.equal(full.revision, 4);
    assert.deepEqual(full.counts, { pending: 1, approved: 0, denied: 1 });
    assert.deepEqual(full.logging, { channelId: fx.reports.id, channelName: 'reports', channelUsable: true, enabled: true, applicationEvents: true });
    assert.deepEqual(full.forms, [
        { roleId: fx.staff.id, roleName: 'Staff', name: 'Staff <b>', enabled: true, questions: ['Why?'], ownQuestions: true, logChannelId: null, usable: true, problem: null, pending: 1, stored: 2 },
        { roleId: fx.aboveBot.id, roleName: 'Founder', name: 'Founder', enabled: false, questions: ['What is your name?', 'How old are you?', 'Why do you want to join?'], ownQuestions: false, logChannelId: null, usable: false, problem: 'Posisinya tidak di bawah role tertinggi bot.', pending: 0, stored: 0 },
        { roleId: '553456789012345999', roleName: null, name: 'Ghost', enabled: true, questions: ['What is your name?', 'How old are you?', 'Why do you want to join?'], ownQuestions: false, logChannelId: null, usable: false, problem: 'Role sudah tidak ada.', pending: 0, stored: 0 },
    ]);
    const text = JSON.stringify(full);
    assert.doesNotMatch(text, /secret/i, 'answers never leave Discord');
    assert.doesNotMatch(text, new RegExp(`${fx.alice.id}|${fx.bob.id}`), 'nor who applied');

    assert.deepEqual([(await req(`${BASE}?x=1`)).status, (await req(`${BASE}?x=1`)).body], [400, { error: 'Parameter tidak valid.' }]);
});

test('API settings: stores exactly what was sent, needs the current revision, and refuses what the dashboard in Discord refuses', { skip }, async (t) => {
    const { fx, req, view, settings, revision } = await api(t);
    const saved = await settings({ enabled: true, managerRoles: [fx.reviewerRole.id, fx.helper.id], pendingDays: 7, reviewedDays: 365 });
    assert.deepEqual([saved.status, saved.body], [200, { ok: true, settings: { enabled: true, managerRoles: [fx.reviewerRole.id, fx.helper.id], pendingDays: 7, reviewedDays: 365 }, revision: 1 }]);
    assert.deepEqual((await view()).settings, saved.body.settings);
    const before = await fx.stored();
    assert.deepEqual([before.settings.pendingApplicationRetentionDays, before.settings.reviewedApplicationRetentionDays, before.settings.revision], [7, 365, 1]);

    const good = { confirmed: true, revision: 1, enabled: false, managerRoles: [], pendingDays: 30, reviewedDays: 30 };
    const { reviewedDays, ...missing } = good;
    for (const [label, body, status, error] of [
        ['not confirmed', { ...good, confirmed: false }, 400, { error: 'Konfirmasi diperlukan.' }],
        ['confirmed as text', { ...good, confirmed: 'true' }, 400, { error: 'Konfirmasi diperlukan.' }],
        ['a key missing', missing, 400, INVALID],
        ['a key too many', { ...good, logChannelId: fx.reports.id }, 400, INVALID],
        ['a list as body', [good], 400, INVALID],
        ['revision as text', { ...good, revision: '1' }, 400, INVALID],
        ['revision negative', { ...good, revision: -1 }, 400, INVALID],
        ['enabled as text', { ...good, enabled: 'false' }, 400, INVALID],
        ['roles not a list', { ...good, managerRoles: fx.helper.id }, 400, INVALID],
        ['role not an id', { ...good, managerRoles: ['helper'] }, 400, INVALID],
        ['days as text', { ...good, pendingDays: '12' }, 400, { error: 'Masa simpan harus bilangan bulat 1 sampai 3650 hari.' }],
        ['days zero', { ...good, pendingDays: 0 }, 400, { error: 'Masa simpan harus bilangan bulat 1 sampai 3650 hari.' }],
        ['days too many', { ...good, reviewedDays: 3651 }, 400, { error: 'Masa simpan harus bilangan bulat 1 sampai 3650 hari.' }],
        ['days fractional', { ...good, reviewedDays: 1.5 }, 400, { error: 'Masa simpan harus bilangan bulat 1 sampai 3650 hari.' }],
        ['@everyone as manager', { ...good, managerRoles: [guildId] }, 400, { error: 'Role pengelola harus role server ini selain @everyone.' }],
        ['a role of nowhere', { ...good, managerRoles: ['553456789012345999'] }, 400, { error: 'Role pengelola harus role server ini selain @everyone.' }],
        ['eleven roles', { ...good, managerRoles: Array.from({ length: 11 }, (unused, n) => roleId(300 + n)) }, 400, { error: 'Role pengelola paling banyak 10.' }],
        ['an old revision', { ...good, revision: 0 }, 409, { error: 'Pengaturan lamaran sudah diubah dari tempat lain. Tidak ada yang disimpan; muat ulang lalu coba lagi.' }],
    ]) {
        const answer = await req(`${BASE}/settings`, 'PUT', body);
        assert.deepEqual([answer.status, answer.body], [status, error], label);
    }
    assert.deepEqual(await fx.stored(), before);
    assert.equal(await revision(), 1);
    assert.equal((await req(`${BASE}/settings`, 'PUT', good, { csrf: false })).status, 403);
    assert.deepEqual(await fx.stored(), before);
});

test('API forms: create, change and delete; the signed-in member can only offer roles they could hand out themselves', { skip }, async (t) => {
    const { fx, who, req, view, create, update, remove, revision } = await api(t);
    who.member = fx.admin;

    for (const [role, error] of [
        [fx.adminRole.id, 'Posisinya tidak di bawah role tertinggi Anda. Tidak ada yang diubah.'],
        [fx.aboveBot.id, 'Posisinya tidak di bawah role tertinggi bot. Tidak ada yang diubah.'],
        [fx.booster.id, 'Role dikelola oleh integrasi dan tidak dapat diberikan kepada anggota. Tidak ada yang diubah.'],
        [guildId, 'Role @everyone tidak dapat dilamar. Tidak ada yang diubah.'],
        ['553456789012345999', 'Role sudah tidak ada. Tidak ada yang diubah.'],
    ]) {
        const answer = await create({ roleId: role });
        assert.deepEqual([answer.status, answer.body], [409, { error }], role);
    }
    assert.deepEqual(await fx.stored(), {});

    const made = await create({ name: '  Staff   team ', questions: [' Why? ', '', 'Since\nwhen?'] });
    assert.equal(made.status, 200);
    assert.deepEqual(made.body.form, {
        roleId: fx.staff.id, roleName: 'Staff', name: 'Staff team', enabled: true, questions: ['Why?', 'Since when?'], ownQuestions: true, logChannelId: null, usable: true, problem: null, pending: 0, stored: 0,
    });
    assert.deepEqual([made.body.settings.enabled, made.body.revision], [true, 1], 'the first form switches applications on');
    // The form made on the web is the form the bot asks.
    const open = await fx.command('apply', { subcommand: 'submit', application: 'staff team' }, { member: fx.alice });
    assert.deepEqual(open.shown[0].components.map((row) => row.components[0].label), ['Why?', 'Since when?']);

    for (const [label, body, status, error] of [
        ['same role', {}, 409, { error: 'Role itu sudah punya formulir lamaran.' }],
        ['same name', { roleId: fx.helper.id, name: 'STAFF TEAM' }, 409, { error: 'Nama itu sudah dipakai formulir lain.' }],
        ['blank name', { roleId: fx.helper.id, name: '   ' }, 400, { error: 'Formulir perlu nama.' }],
        ['no question', { roleId: fx.helper.id, name: 'Helper', questions: [' ', ''] }, 400, { error: 'Formulir perlu sedikitnya satu pertanyaan.' }],
        ['name too long', { roleId: fx.helper.id, name: 'N'.repeat(LIMITS.formName + 1) }, 400, INVALID],
        ['question too long', { roleId: fx.helper.id, name: 'Helper', questions: ['Q'.repeat(LIMITS.question + 1)] }, 400, INVALID],
        ['six questions', { roleId: fx.helper.id, name: 'Helper', questions: ['1', '2', '3', '4', '5', '6'] }, 400, INVALID],
        ['questions not text', { roleId: fx.helper.id, name: 'Helper', questions: [1] }, 400, INVALID],
        ['role not an id', { roleId: 'helper', name: 'Helper' }, 400, INVALID],
        ['stale', { roleId: fx.helper.id, name: 'Helper', revision: 0 }, 409, { error: 'Pengaturan lamaran sudah diubah dari tempat lain. Tidak ada yang disimpan; muat ulang lalu coba lagi.' }],
    ]) {
        const answer = await create(body);
        assert.deepEqual([answer.status, answer.body], [status, error], label);
    }
    assert.equal((await view()).forms.length, 1);

    const changed = await update(fx.staff.id, { name: 'Moderator', enabled: false, questions: ['New?'] });
    assert.deepEqual([changed.status, changed.body.form.name, changed.body.form.enabled, changed.body.form.questions, changed.body.revision], [200, 'Moderator', false, ['New?'], 2]);
    assert.deepEqual((await readConfig(fx.client, guildId)).forms, [{ roleId: fx.staff.id, name: 'Moderator', enabled: false, questions: ['New?'], logChannelId: null }]);
    for (const [label, role, body, status] of [
        ['no such form', fx.helper.id, {}, 404], ['not an id', 'staff', {}, 400], ['stale', fx.staff.id, { revision: 1 }, 409],
        ['enabled as text', fx.staff.id, { enabled: 'yes' }, 400], ['no question', fx.staff.id, { questions: [] }, 400],
    ]) assert.equal((await update(role, body)).status, status, label);
    assert.equal(await revision(), 2);

    // Deleting takes the applications of the form along and says how many.
    await update(fx.staff.id, { name: 'Moderator', enabled: true, questions: ['New?'] });
    await fx.applyFor(fx.alice, 'Moderator', ['x']);
    await fx.applyFor(fx.bob, 'Moderator', ['x']);
    assert.equal((await remove(fx.staff.id, { revision: 0 })).status, 409);
    assert.equal((await remove(fx.helper.id)).status, 404);
    assert.equal((await req(`${BASE}/forms/${fx.staff.id}/delete`, 'POST', { confirmed: true, revision: await revision(), extra: 1 })).status, 400);
    assert.equal((await fx.applications()).length, 2);
    const gone = await remove(fx.staff.id);
    assert.deepEqual([gone.status, gone.body], [200, { ok: true, deleted: { roleId: fx.staff.id, name: 'Moderator', applications: 2 }, revision: 4 }]);
    assert.deepEqual(Object.keys(await fx.stored()).sort(), ['roles', 'settings']);
});

test('API: bot not ready, a database failure and unreadable stored data change nothing and give no details', { skip }, async (t) => {
    const { fx, req, create, settings, update, remove } = await api(t);
    await create();
    const before = await fx.stored();
    const UNSURE = { error: 'Perubahan tidak dapat diselesaikan saat ini. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.' };
    const attempts = () => [settings({ enabled: false }), update(fx.staff.id, { name: 'Other' }), create({ roleId: fx.helper.id, name: 'Helper' }), remove(fx.staff.id)];

    fx.client.isReady = () => false;
    for (const answer of await Promise.all(attempts())) assert.deepEqual([answer.status, answer.body], [503, { error: 'Bot belum siap.' }]);
    fx.client.isReady = () => true;

    // Reads fail: each change needs the revision first, so drive the routes directly.
    const bodies = [
        ['PUT', `${BASE}/settings`, { confirmed: true, revision: 1, enabled: false, managerRoles: [], pendingDays: 30, reviewedDays: 30 }],
        ['PUT', `${BASE}/forms/${fx.staff.id}`, { confirmed: true, revision: 1, name: 'Other', enabled: true, questions: ['Why?'] }],
        ['POST', `${BASE}/forms`, { confirmed: true, revision: 1, roleId: fx.helper.id, name: 'Helper', questions: ['Why?'] }],
        ['POST', `${BASE}/forms/${fx.staff.id}/delete`, { confirmed: true, revision: 1 }],
    ];
    for (const failing of [/INSERT|DELETE/, /SELECT key/, /BEGIN/]) {
        fx.control.failQuery = (sql) => failing.test(sql);
        for (const [method, path, body] of bodies) {
            const answer = await req(path, method, body);
            assert.deepEqual([answer.status, answer.body], [503, { error: 'Database sedang tidak dapat dipakai. Tidak ada yang diubah.' }], `${failing} ${path}`);
        }
    }
    fx.control.failQuery = (sql) => /COMMIT/.test(sql);
    const unsure = await req(...[bodies[0][1], bodies[0][0], bodies[0][2]]);
    // A failed COMMIT is an unknown outcome on PostgreSQL and a rollback on SQLite.
    assert.deepEqual([unsure.status, unsure.body], [503, { error: onSQLite ? 'Database sedang tidak dapat dipakai. Tidak ada yang diubah.' : 'Database tidak mengonfirmasi perubahan. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.' }]);
    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    const read = await req(BASE);
    assert.deepEqual([read.status, read.body], [503, { error: 'Pengaturan lamaran tidak dapat dibaca dari database.' }]);
    fx.control.failQuery = null;
    assert.deepEqual(await fx.stored(), before);

    // Something unexpected inside the service: a general answer, without the message of the error.
    fx.guild.roles.cache.get = () => { throw new Error('secret internal detail'); };
    const odd = await req(bodies[2][1], bodies[2][0], bodies[2][2]);
    assert.deepEqual([odd.status, odd.body], [503, UNSURE]);
    delete fx.guild.roles.cache.get;

    await fx.seed('settings', 'not an object');
    const unreadable = await req(BASE);
    assert.deepEqual([unreadable.status, unreadable.body], [409, { error: 'Data lamaran yang tersimpan tidak dapat dibaca. Tidak ada yang diubah.' }]);
    assert.equal((await req(bodies[0][1], bodies[0][0], bodies[0][2])).status, 409);
});

test('API: malformed and oversized JSON are answered in the API format; without a verified member nothing is read', { skip }, async (t) => {
    const { fx, who, req, create } = await api(t);
    await create();
    const before = await fx.stored();
    const malformed = await req(`${BASE}/settings`, 'PUT', undefined, { rawBody: '{"confirmed":' });
    assert.deepEqual([malformed.status, malformed.body], [400, INVALID]);
    const large = await req(`${BASE}/forms`, 'POST', undefined, { rawBody: JSON.stringify({ confirmed: true, pad: 'x'.repeat(20000) }) });
    assert.deepEqual([large.status, large.body], [413, INVALID]);

    let reads = 0;
    fx.control.failQuery = (sql) => { if (/temp_data/.test(sql)) reads += 1; return false; };
    for (const member of [undefined, { id: fx.alice.id, permissions: fx.alice.permissions, roles: fx.alice.roles }, fx.reviewer]) {
        who.member = member;
        for (const [method, path, body] of [
            ['GET', BASE, undefined],
            ['PUT', `${BASE}/settings`, { confirmed: true, revision: 1, enabled: false, managerRoles: [], pendingDays: 30, reviewedDays: 30 }],
            ['POST', `${BASE}/forms`, { confirmed: true, revision: 1, roleId: fx.helper.id, name: 'Helper', questions: ['Why?'] }],
            ['PUT', `${BASE}/forms/${fx.staff.id}`, { confirmed: true, revision: 1, name: 'Mine', enabled: true, questions: ['Why?'] }],
            ['POST', `${BASE}/forms/${fx.staff.id}/delete`, { confirmed: true, revision: 1 }],
        ]) {
            const answer = await req(path, method, body);
            assert.deepEqual([answer.status, answer.body], [403, { error: 'Akses ditolak.' }], `${member?.id} ${method} ${path}`);
        }
    }
    fx.control.failQuery = null;
    assert.equal(reads, 0, 'refused before the database was asked');
    assert.deepEqual(await fx.stored(), before);
});

test('API: each stored change is one line in the bot log naming the member and the dashboard; refusals write none', { skip }, async (t) => {
    const { fx, who, create, settings, update, remove } = await api(t);
    who.member = fx.admin;
    const lines = [];
    t.mock.method(logger, 'info', (message, details) => { if (message === 'Application settings changed') lines.push(details); });

    await create();
    await create(); // refused: the role has a form
    await settings({ enabled: false });
    await settings({ pendingDays: 0 }); // refused
    await update(fx.staff.id, { name: 'Moderator' });
    await remove(fx.staff.id);
    assert.deepEqual(lines, [
        { guildId, actorId: fx.admin.id, source: 'dashboard', change: 'form created', roleId: fx.staff.id },
        { guildId, actorId: fx.admin.id, source: 'dashboard', change: 'settings changed', fields: ['enabled', 'managerRoles', 'pendingDays', 'reviewedDays'] },
        { guildId, actorId: fx.admin.id, source: 'dashboard', change: 'form changed', roleId: fx.staff.id, fields: ['name', 'enabled', 'questions'] },
        { guildId, actorId: fx.admin.id, source: 'dashboard', change: 'form deleted', roleId: fx.staff.id, removedApplications: 0 },
    ]);

    // The same change made in Discord says so.
    lines.length = 0;
    await fx.run(fx.button('app:switch:on', { member: fx.manager }));
    assert.deepEqual(lines, [{ guildId, actorId: fx.manager.id, source: 'discord', change: 'settings changed', fields: ['enabled'] }]);
});

// ---- page -----------------------------------------------------------------------

/** The dashboard page on the Community room; its requests go to the real router. */
async function openPage(t, { confirm = true, url = 'http://localhost/dashboard/#features/community', arrange } = {}) {
    const made = await api(t, { arrange });
    const { fx, req } = made;
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
        if (!path.startsWith('/dashboard/api/bot/applications')) return { ok: false, status: 503, json: async () => ({ error: 'tidak tersedia' }) };
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
    const root = () => w.document.querySelector('#applicationsLive');
    const q = (selector) => root().querySelector(selector);
    const all = (selector) => [...root().querySelectorAll(selector)];
    const submit = async (form) => { form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await settle(); };
    const click = async (button) => { button.click(); await settle(); };
    const writes = () => calls.filter((call) => call.method !== 'GET');
    return { ...made, w, root, q, all, submit, click, settle, confirms, calls, writes };
}
const twoForms = (fx) => fx.seedConfig({
    settings: { enabled: true, managerRoles: [fx.reviewerRole.id], pendingApplicationRetentionDays: 14, reviewedApplicationRetentionDays: 90, revision: 3 },
    forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?', 'Since when?'] }, { role: fx.aboveBot, name: 'Founder', enabled: false, questions: ['Why?'] }],
});

test('page: shows the stored settings and forms; saving the settings asks first and sends exactly what the form holds', { skip }, async (t) => {
    const page = await openPage(t, { arrange: twoForms });
    const { fx } = page;
    assert.match(page.w.document.querySelector('.f-demo-warning').textContent, /DATA POSTGRESQL · PENGATURAN DAN FORMULIR TERSIMPAN · LAMARAN DIPUTUSKAN DI DISCORD/);
    assert.match(page.q('#applicationsState').textContent, /Status: Aktif\./);
    assert.match(page.q('#applicationsState').textContent, /Lamaran tersimpan: 0 menunggu\s+·\s+0 diterima\s+·\s+0 ditolak/);
    assert.match(page.q('#applicationsState').textContent, /Channel log lamaran: Belum diatur\. Lamaran baru tidak diumumkan di channel mana pun, dan role pengelola tidak mendapat tombol Review\./);
    assert.equal(page.q('#applicationsState a').getAttribute('href'), '#features/logging');
    assert.match(page.root().textContent, /Isi lamaran \(jawaban anggota\) tidak ditampilkan di halaman ini\./);

    const form = page.q('#applicationsSettingsForm');
    assert.deepEqual([form.elements.enabled.checked, form.elements.pendingDays.value, form.elements.reviewedDays.value], [true, '14', '90']);
    assert.deepEqual([...form.elements.managerRoles.selectedOptions].map((option) => option.textContent), ['@Recruiter']);
    assert.ok(![...form.elements.managerRoles.options].some((option) => option.value === guildId), '@everyone is not offered');

    form.elements.enabled.checked = false;
    for (const option of form.elements.managerRoles.options) option.selected = [fx.helper.id, fx.staff.id].includes(option.value);
    form.elements.pendingDays.value = '7';
    form.elements.reviewedDays.value = '30';
    await page.submit(form);

    assert.deepEqual(page.confirms, ['Simpan pengaturan lamaran? Lamaran NONAKTIF; 2 role pengelola. Masa simpan diperpendek: lamaran yang lebih lama dari masa baru tidak lagi ditampilkan dan akan dihapus.']);
    assert.deepEqual(page.writes(), [{
        method: 'PUT', path: '/applications/settings', csrf: 'c',
        body: { confirmed: true, revision: 3, enabled: false, managerRoles: [fx.staff.id, fx.helper.id], pendingDays: 7, reviewedDays: 30 },
    }]);
    const { settings } = await readConfig(fx.client, guildId);
    assert.deepEqual([settings.enabled, settings.managerRoles, settings.pendingDays, settings.reviewedDays, settings.revision], [false, [fx.staff.id, fx.helper.id], 7, 30, 4]);
    // The page was reloaded from what is stored.
    assert.equal(page.q('#applicationsStatus').textContent, 'Pengaturan lamaran disimpan.');
    assert.match(page.q('#applicationsState').textContent, /Status: Nonaktif\. Anggota tidak dapat melamar\./);
    assert.equal(page.q('#applicationsSettingsForm').elements.pendingDays.value, '7');

    // Not shortened: the confirmation does not warn about deletion.
    await page.submit(page.q('#applicationsSettingsForm'));
    assert.equal(page.confirms[1], 'Simpan pengaturan lamaran? Lamaran NONAKTIF; 2 role pengelola.');
});

test('page: create, change and delete a form; each confirmation says what follows', { skip }, async (t) => {
    const page = await openPage(t);
    const { fx } = page;
    assert.match(page.q('#applicationsForms').textContent, /Belum ada formulir\./);

    const created = page.q('#applicationsNewForm');
    const offered = Object.fromEntries([...created.elements.roleId.options].map((option) => [option.textContent, option.disabled]));
    assert.equal(offered['@Staff'], false);
    assert.equal(offered['@Founder (Posisinya tidak di bawah role tertinggi bot.)'], true);
    assert.equal(offered['@Booster (Role dikelola oleh integrasi dan tidak dapat diberikan kepada anggota.)'], true);
    assert.equal(created.querySelectorAll('input[name^=q]').length, LIMITS.questions);

    created.elements.roleId.value = fx.staff.id;
    created.elements.name.value = ' Staff ';
    created.elements.q0.value = 'Why?';
    created.elements.q2.value = ' Since when? ';
    await page.submit(created);
    assert.deepEqual(page.confirms, ['Buat formulir "Staff" untuk role @Staff? Setiap lamaran yang disetujui memberi role itu kepada pelamar. Ini formulir pertama, jadi lamaran sekaligus diaktifkan.']);
    assert.deepEqual(page.writes()[0], { method: 'POST', path: '/applications/forms', csrf: 'c', body: { confirmed: true, revision: 0, roleId: fx.staff.id, name: 'Staff', questions: ['Why?', 'Since when?'] } });
    assert.equal(page.q('#applicationsStatus').textContent, 'Formulir "Staff" dibuat.');
    assert.match(page.q('#applicationsState').textContent, /Status: Aktif\./);
    assert.ok(![...page.q('#applicationsNewForm').elements.roleId.options].some((option) => option.value === fx.staff.id), 'a role with a form is not offered again');

    await fx.applyFor(fx.alice, 'Staff', ['a', 'b']);
    await page.click(page.q('#applicationsReload'));
    const card = page.q(`[data-app-form="${fx.staff.id}"]`);
    assert.match(card.textContent, /Role: @Staff\s+·\s+1 menunggu, 1 tersimpan/);
    assert.deepEqual([card.elements.name.value, card.elements.enabled.checked, card.elements.q0.value, card.elements.q1.value, card.elements.q2.value], ['Staff', true, 'Why?', 'Since when?', '']);
    card.elements.name.value = 'Moderator';
    card.elements.enabled.checked = false;
    card.elements.q1.value = '';
    await page.submit(card);
    assert.equal(page.confirms[1], 'Simpan formulir "Moderator"? Anggota yang sedang mengisi formulir ini harus mengulang bila pertanyaannya berubah.');
    assert.deepEqual(page.writes()[1], { method: 'PUT', path: `/applications/forms/${fx.staff.id}`, csrf: 'c', body: { confirmed: true, revision: 1, name: 'Moderator', enabled: false, questions: ['Why?'] } });
    assert.deepEqual((await readConfig(fx.client, guildId)).forms, [{ roleId: fx.staff.id, name: 'Moderator', enabled: false, questions: ['Why?'], logChannelId: null }]);

    await page.click(page.q(`[data-app-delete="${fx.staff.id}"]`));
    assert.equal(page.confirms[2], 'Hapus formulir "Moderator"? Pertanyaan, pengaturan, dan 1 lamaran yang masuk lewat formulir ini DIHAPUS dan tidak dapat dikembalikan. Role yang sudah diberikan tidak dicabut.');
    assert.deepEqual(page.writes()[2], { method: 'POST', path: `/applications/forms/${fx.staff.id}/delete`, csrf: 'c', body: { confirmed: true, revision: 2 } });
    assert.equal(page.q('#applicationsStatus').textContent, 'Formulir "Moderator" dihapus bersama 1 lamaran.');
    assert.deepEqual(Object.keys(await fx.stored()).sort(), ['roles', 'settings']);
});

test('page: declining a confirmation, or a form the page itself can see is wrong, sends nothing', { skip }, async (t) => {
    const page = await openPage(t, { confirm: false, arrange: twoForms });
    const before = await page.fx.stored();
    await page.submit(page.q('#applicationsSettingsForm'));
    await page.submit(page.q(`[data-app-form="${page.fx.staff.id}"]`));
    await page.click(page.q(`[data-app-delete="${page.fx.staff.id}"]`));
    const created = page.q('#applicationsNewForm');
    created.elements.roleId.value = page.fx.helper.id;
    created.elements.name.value = 'Helper';
    created.elements.q0.value = 'Why?';
    await page.submit(created);
    assert.equal(page.confirms.length, 4);

    // Wrong on its face: said in place, no question asked, nothing sent.
    const settings = page.q('#applicationsSettingsForm');
    for (const [pending, reviewed] of [['0', '30'], ['30', '3651'], ['1.5', '30'], ['', '30'], ['12abc', '30']]) {
        settings.elements.pendingDays.value = pending;
        settings.elements.reviewedDays.value = reviewed;
        await page.submit(settings);
        assert.equal(page.q('#applicationsSettingsStatus').textContent, 'Masa simpan harus bilangan bulat 1 sampai 3650 hari.', `${pending}/${reviewed}`);
    }
    created.elements.roleId.value = '';
    await page.submit(created);
    assert.equal(page.q('#applicationsFormsStatus').textContent, 'Pilih role terlebih dahulu.');
    created.elements.roleId.value = page.fx.helper.id;
    created.elements.q0.value = '  ';
    await page.submit(created);
    assert.equal(page.q('#applicationsFormsStatus').textContent, 'Formulir perlu sedikitnya satu pertanyaan.');
    created.elements.q0.value = 'Why?';
    created.elements.name.value = ' ';
    await page.submit(created);
    assert.equal(page.q('#applicationsFormsStatus').textContent, 'Formulir perlu nama.');
    const card = page.q(`[data-app-form="${page.fx.staff.id}"]`);
    card.elements.q0.value = '';
    card.elements.q1.value = '';
    await page.submit(card);
    assert.equal(page.q('#applicationsFormsStatus').textContent, 'Formulir perlu sedikitnya satu pertanyaan.');

    assert.equal(page.confirms.length, 4);
    assert.deepEqual(page.writes(), []);
    assert.deepEqual(await page.fx.stored(), before);
});

test('page: a refusal is shown in place and the controls work again; an outdated page is told to reload', { skip }, async (t) => {
    const page = await openPage(t, { arrange: twoForms });
    const { fx } = page;
    // Someone renames the other form in Discord while this page is open.
    await fx.run(fx.form(`app:rename:${fx.aboveBot.id}`, { app_name: 'Owner' }, { member: fx.owner }));

    const card = page.q(`[data-app-form="${fx.staff.id}"]`);
    card.elements.name.value = 'Changed';
    await page.submit(card);
    assert.equal(page.q('#applicationsFormsStatus').textContent, 'Pengaturan lamaran sudah diubah dari tempat lain. Tidak ada yang disimpan; muat ulang lalu coba lagi. Bila hasilnya tidak jelas, muat ulang dan periksa sebelum mengulang.');
    assert.equal(page.all('button:disabled, input:disabled, select:disabled').length, 0, 'nothing stays locked');
    assert.deepEqual((await readConfig(fx.client, guildId)).forms.map((form) => form.name), ['Staff', 'Owner']);

    await page.click(page.q('#applicationsReload'));
    const fresh = page.q(`[data-app-form="${fx.staff.id}"]`);
    fresh.elements.name.value = 'owner';
    await page.submit(fresh);
    assert.match(page.q('#applicationsFormsStatus').textContent, /^Nama itu sudah dipakai formulir lain\./);
    fresh.elements.name.value = 'Changed';
    await page.submit(fresh);
    assert.equal(page.q('#applicationsStatus').textContent, 'Formulir "Changed" disimpan.');
});

test('page: names are shown as text; what stands in the way of a form or of the log channel is described', { skip }, async (t) => {
    const page = await openPage(t, { arrange: async (fx) => {
        fx.staff.name = 'Staff <img src=x onerror=alert(1)>';
        await fx.seedConfig({
            settings: { enabled: true, managerRoles: ['553456789012345999'] },
            forms: [{ role: fx.staff, name: '<b>Bold</b> "form"', questions: ['<i>Why?</i>'] }, { role: fx.aboveBot, name: 'Founder', questions: ['Why?'] }, { role: { id: '553456789012345998' }, name: 'Ghost', questions: ['Why?'] }],
        });
        await fx.setLogging({ enabled: false, channels: { applications: fx.reports.id } });
    } });
    const { fx } = page;
    assert.equal(page.root().querySelector('img, i, h3 *, option *'), null, 'no markup made from names');
    const card = page.q(`[data-app-form="${fx.staff.id}"]`);
    assert.equal(card.querySelector('h3').textContent, '<b>Bold</b> "form"');
    assert.equal(card.elements.name.value, '<b>Bold</b> "form"');
    assert.equal(card.elements.q0.value, '<i>Why?</i>');
    assert.match(card.textContent, /Role: @Staff <img src=x onerror=alert\(1\)>/);

    assert.equal(page.q(`[data-app-form="${fx.aboveBot.id}"] [role=alert]`).textContent, 'Persetujuan akan ditolak: Posisinya tidak di bawah role tertinggi bot.');
    const ghost = page.q('[data-app-form="553456789012345998"]');
    assert.match(ghost.textContent, /Role: Role sudah tidak ada \(ID 553456789012345998\)/);
    assert.equal(ghost.querySelector('[role=alert]').textContent, 'Persetujuan akan ditolak: Role sudah tidak ada.');
    // A manager role that no longer exists stays visible and selected, so saving does not drop it silently.
    assert.deepEqual([...page.q('#applicationsSettingsForm').elements.managerRoles.selectedOptions].map((option) => option.textContent), ['Role tidak dikenal (ID 553456789012345999)']);

    const log = () => page.q('#applicationsState').textContent;
    assert.match(log(), /#reports, tetapi logging server sedang dimatikan sehingga tidak ada yang dikirim\./);
    await fx.logTo(fx.reports, { enabledEvents: { 'application.submit': false } });
    await page.click(page.q('#applicationsReload'));
    assert.match(log(), /#reports, tetapi jenis log lamaran dimatikan di pengaturan Logging sehingga tidak ada yang dikirim\./);
    await fx.logTo(fx.reports);
    await page.click(page.q('#applicationsReload'));
    assert.match(log(), /Channel log lamaran: #reports Diatur di Logging/);
    fx.guild.channels.cache.delete(fx.reports.id);
    await page.click(page.q('#applicationsReload'));
    assert.match(log(), new RegExp(`Channel \\(ID ${fx.reports.id}\\) tidak terlihat oleh bot; mungkin sudah dihapus\\.`));
});

test('page: a read failure offers a retry and no forms; the static preview is a labelled placeholder that requests nothing', { skip }, async (t) => {
    const page = await openPage(t, { arrange: (fx) => { fx.control.failQuery = (sql) => /temp_data/.test(sql); } });
    assert.equal(page.q('#applicationsState [role=alert]').textContent, 'Pengaturan lamaran tidak dapat dibaca dari database.');
    assert.equal(page.root().querySelectorAll('form').length, 0);
    page.fx.control.failQuery = null;
    await page.click(page.q('#applicationsRetry'));
    assert.ok(page.q('#applicationsSettingsForm'));
    assert.ok(page.q('#applicationsNewForm'));

    const preview = await openPage(t, { url: 'http://localhost/preview/#features/community' });
    assert.equal(preview.root(), null);
    assert.match(preview.w.document.querySelector('.f-demo-warning').textContent, /PREVIEW · DATA CONTOH · TIDAK TERHUBUNG KE DISCORD/);
    assert.match(preview.w.document.querySelector('.f-content').textContent, /Preview saja; tidak terhubung ke bot/);
    assert.deepEqual(preview.calls, []);
});
