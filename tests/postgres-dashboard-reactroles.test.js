import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM } from 'jsdom';
import { createReactRolesFixture, guildId, memberId, roleId, missingPermissions, serverError } from './helpers/reactroles-fixture.js';
import { pgEnabled } from './helpers/leveling-postgres-fixture.js';
import { createReactionRolesApi } from '../src/dashboard/reactionRolesApi.js';

// The real router and the real page scripts on a disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const dir = 'dashboard-preview/';
const raw = fs.readFileSync(dir + 'index.html', 'utf8');
const scripts = [...raw.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = raw.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (ids) => ids.map((id) => id.slice(-1)).join('');
const BASE = '/reaction-roles';

async function api(t) {
    const fx = await createReactRolesFixture(t);
    fx.client.isReady = () => true;
    const req = await fx.startApi([createReactionRolesApi]);
    const view = async () => (await req(BASE)).body;
    const make = (body = {}) => req(`${BASE}/panels`, 'POST', {
        confirmed: true, channelId: fx.panelChannel.id, title: 'Pick roles', description: 'Choose below', roleIds: [fx.R[1].id, fx.R[2].id], ...body,
    });
    const storedRoles = async (id) => tail((await fx.stored())[id]?.roles ?? []);
    return { fx, req, view, make, storedRoles };
}

// ---- API ------------------------------------------------------------------------

test('API read: panels with their state, channels and roles with reasons; reading changes nothing', { skip }, async (t) => {
    const { fx, req, view } = await api(t);
    const managed = fx.addRole(roleId(22), { name: 'Booster', position: 22, managed: true });
    fx.setBotPermissions(fx.adminChannel.id, ['ViewChannel']);
    const message = await fx.seedPanel([fx.R[1], fx.R[2]]);
    fx.roles.delete(fx.R[2].id);
    const gone = await fx.seedPanel([fx.R[3]], { extra: { title: 'Stored title' } });
    fx.panelChannel.messages.cache.delete(gone.id);
    await fx.store('830000000000000777', { broken: true });
    const before = JSON.stringify(await fx.stored());

    const data = await view();
    assert.equal(data.rejected, 1);
    assert.deepEqual(data.limits, { panels: 5, roles: 25, title: 256, description: 2048 });
    assert.deepEqual(data.panels.map((panel) => [panel.status, panel.title, panel.channelName, panel.url]), [
        ['ok', 'Pick roles', 'roles', message.url], ['message_missing', 'Stored title', 'roles', null],
    ]);
    assert.deepEqual(data.panels[0].roles, [
        { id: fx.R[1].id, name: 'Role 1', ok: true, reason: null },
        { id: fx.R[2].id, name: null, ok: false, reason: 'Role sudah tidak ada.' },
    ]);
    assert.match(data.panels[0].revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(data.channels, [
        { id: fx.panelChannel.id, name: 'roles', usable: true }, { id: fx.adminChannel.id, name: 'admin', usable: false },
    ]);
    // Highest first, without @everyone; a role that cannot be offered says why.
    assert.equal(data.roles.some((role) => role.id === guildId), false);
    assert.deepEqual(data.roles.find((role) => role.id === managed.id), { id: managed.id, name: 'Booster', usable: false, reason: 'Role dikelola oleh bot atau integrasi.' });
    assert.deepEqual(data.roles.filter((role) => role.usable).map((role) => role.name), ['Role 6', 'Role 5', 'Role 4', 'Role 3', 'Role 1']);

    assert.equal(JSON.stringify(await fx.stored()), before);
    assert.equal(fx.calls.send.length + fx.calls.edit.length + fx.calls.delete.length, 0);
    assert.equal((await req(`${BASE}?x=1`)).status, 400);
});

test('API create: posts the panel and stores it; bad input, refused roles and missing CSRF change nothing', { skip }, async (t) => {
    const { fx, req, make } = await api(t);
    const pinger = fx.addRole(roleId(21), { name: 'Pinger', position: 21, permissions: ['MentionEveryone'] });

    const created = await make();
    assert.equal(created.status, 200);
    const [message] = [...fx.panelChannel.messages.cache.values()];
    assert.deepEqual(created.body, { ok: true, messageId: message.id, url: message.url });
    const stored = (await fx.stored())[message.id];
    assert.deepEqual([tail(stored.roles), stored.title, stored.description], ['12', 'Pick roles', 'Choose below']);
    assert.deepEqual(fx.menuRoles(message), [fx.R[1].id, fx.R[2].id]);

    const refusals = [
        [await make({ roleIds: [pinger.id] }), 409, /tidak dapat ditawarkan di panel\. Role memberi izin pengelolaan server, moderasi, atau mention @everyone/],
        [await make({ roleIds: [roleId(99)] }), 400, /Role itu tidak ada di server ini/],
        [await make({ roleIds: [] }), 400, /Pilih minimal satu role/],
        [await make({ roleIds: [fx.R[1].id, fx.R[1].id] }), 400, /Permintaan tidak valid/],
        [await make({ roleIds: 'x' }), 400, /Permintaan tidak valid/],
        [await make({ title: '   ' }), 400, /Judul harus 1 sampai 256 karakter/],
        [await make({ description: 'x'.repeat(2049) }), 400, /Deskripsi harus 1 sampai 2048 karakter/],
        [await make({ channelId: '443456789012345999' }), 400, /Pilih channel teks atau pengumuman/],
        [await make({ channelId: 'abc' }), 400, /Permintaan tidak valid/],
        [await make({ extra: 1 }), 400, /Permintaan tidak valid/],
        [await make({ confirmed: false }), 400, /Konfirmasi diperlukan/],
        [await req(`${BASE}/panels`, 'POST', { confirmed: true, channelId: fx.panelChannel.id, title: 'T', description: 'D', roleIds: [fx.R[1].id] }, { csrf: false }), 403, /csrf/],
    ];
    for (const [answer, status, text] of refusals) {
        assert.equal(answer.status, status, JSON.stringify(answer.body));
        assert.match(answer.body.error, text);
    }
    assert.equal(fx.calls.send.length, 1);
    assert.equal(Object.keys(await fx.stored()).length, 1);
});

test('API create: bot not ready, limit, Discord refusal and database failure leave nothing behind', { skip }, async (t) => {
    const { fx, make } = await api(t);
    fx.client.isReady = () => false;
    assert.equal((await make()).status, 503);
    fx.client.isReady = () => true;

    fx.hooks.send = () => { throw missingPermissions(); };
    const refused = await make();
    assert.deepEqual([refused.status, refused.body], [502, { error: 'Discord menolak permintaan. Tidak ada yang diubah.' }]);
    fx.hooks.send = null;

    fx.control.failQuery = (sql) => /INSERT INTO/.test(sql) && /temp_data/.test(sql);
    const unsaved = await make();
    assert.equal(unsaved.status, 503);
    assert.doesNotMatch(JSON.stringify(unsaved.body), /injected/);
    assert.equal(fx.panelChannel.messages.cache.size, 0);

    fx.hooks.deleteMessage = () => { throw missingPermissions(); };
    const left = await make();
    fx.control.failQuery = null;
    fx.hooks.deleteMessage = null;
    const [stray] = [...fx.panelChannel.messages.cache.values()];
    assert.deepEqual([left.status, left.body.messageUrl], [500, stray.url]);
    assert.match(left.body.error, /Hapus pesan itu secara manual/);
    assert.deepEqual(await fx.stored(), {});

    for (let n = 0; n < 5; n++) await fx.seedPanel();
    const full = await make();
    assert.equal(full.status, 409);
    assert.match(full.body.error, /sudah memiliki 5 panel/);
    assert.equal(Object.keys(await fx.stored()).length, 5);
});

test('API change: text and roles need the current revision and say what happened to the message', { skip }, async (t) => {
    const { fx, req, view, storedRoles } = await api(t);
    const message = await fx.seedPanel();
    const path = `${BASE}/panels/${message.id}`;
    let [panel] = (await view()).panels;

    const text = await req(path, 'PATCH', { confirmed: true, revision: panel.revision, title: 'New', description: 'New text' });
    assert.deepEqual(text.body, { ok: true, message: 'updated' });
    assert.equal(message.embeds[0].title, 'New');

    // The page still holds the old revision.
    const stale = await req(`${path}/roles`, 'POST', { confirmed: true, revision: panel.revision, roleId: fx.R[3].id });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /Panel berubah sejak halaman dimuat/);
    [panel] = (await view()).panels;

    const added = await req(`${path}/roles`, 'POST', { confirmed: true, revision: panel.revision, roleId: fx.R[3].id });
    assert.deepEqual(added.body, { ok: true, message: 'updated' });
    assert.equal(await storedRoles(message.id), '123');
    assert.equal(tail(fx.menuRoles(message)), '123');
    [panel] = (await view()).panels;

    const duplicate = await req(`${path}/roles`, 'POST', { confirmed: true, revision: panel.revision, roleId: fx.R[3].id });
    assert.deepEqual([duplicate.status, duplicate.body.error], [409, 'Role itu sudah ada di panel ini.']);

    // The message cannot be edited: the change is stored and the answer says the message did not follow.
    fx.hooks.editMessage = () => { throw missingPermissions(); };
    const removed = await req(`${path}/roles/${fx.R[1].id}`, 'DELETE', { confirmed: true, revision: panel.revision });
    assert.deepEqual(removed.body, { ok: true, message: 'failed' });
    assert.equal(await storedRoles(message.id), '23');
    assert.equal(tail(fx.menuRoles(message)), '123');
    fx.hooks.editMessage = null;

    const refreshed = await req(`${path}/refresh`, 'POST', { confirmed: true });
    assert.deepEqual(refreshed.body, { ok: true, message: 'updated' });
    assert.equal(tail(fx.menuRoles(message)), '23');
    [panel] = (await view()).panels;

    await req(`${path}/roles/${fx.R[2].id}`, 'DELETE', { confirmed: true, revision: panel.revision });
    [panel] = (await view()).panels;
    const last = await req(`${path}/roles/${fx.R[3].id}`, 'DELETE', { confirmed: true, revision: panel.revision });
    assert.equal(last.status, 409);
    assert.match(last.body.error, /role terakhir di panel ini/);
    assert.equal(await storedRoles(message.id), '3');

    const unknown = await req(`${BASE}/panels/830000000000000999/roles`, 'POST', { confirmed: true, revision: panel.revision, roleId: fx.R[1].id });
    assert.equal(unknown.status, 404);
    for (const bad of [
        await req(path, 'PATCH', { confirmed: true, revision: 'x', title: 'A', description: 'B' }),
        await req(path, 'PATCH', { confirmed: true, revision: panel.revision, title: 'A' }),
        await req(`${path}/roles`, 'POST', { confirmed: true, revision: panel.revision, roleId: 'x' }),
        await req(`${BASE}/panels/abc/refresh`, 'POST', { confirmed: true }),
        await req(`${path}/refresh`, 'POST', {}),
    ]) assert.equal(bad.status, 400);
    assert.equal((await req(path, 'PATCH', { confirmed: true, revision: panel.revision, title: 'A', description: 'B' }, { csrf: false })).status, 403);
    assert.equal(message.embeds[0].title, 'New');
});

test('API delete and repost: a refused delete keeps the panel; repost only when the message is gone', { skip }, async (t) => {
    const { fx, req, view } = await api(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2]], { extra: { title: 'Colours', description: 'Pick one' } });
    const path = `${BASE}/panels/${message.id}`;
    const [panel] = (await view()).panels;

    const notMissing = await req(`${path}/repost`, 'POST', { confirmed: true });
    assert.deepEqual([notMissing.status, notMissing.body.error], [409, 'Pesan panel masih ada, jadi tidak perlu dipasang ulang.']);

    fx.hooks.deleteMessage = () => { throw missingPermissions(); };
    const refused = await req(path, 'DELETE', { confirmed: true, revision: panel.revision });
    assert.deepEqual([refused.status, refused.body.error], [502, 'Discord menolak permintaan. Tidak ada yang diubah.']);
    fx.hooks.deleteMessage = null;
    fx.hooks.fetchMessage = () => { throw serverError(); };
    const uncertain = await req(path, 'DELETE', { confirmed: true, revision: panel.revision });
    assert.equal(uncertain.status, 502);
    assert.match(uncertain.body.error, /tidak dapat diperiksa di Discord saat ini\. Tidak ada yang diubah/);
    fx.hooks.fetchMessage = null;
    assert.equal(Object.keys(await fx.stored()).length, 1);
    assert.equal(fx.panelChannel.messages.cache.has(message.id), true);
    assert.equal((await req(path, 'DELETE', { confirmed: true, revision: 'f'.repeat(64) })).status, 409);
    assert.equal((await req(path, 'DELETE', { confirmed: true })).status, 400);

    fx.panelChannel.messages.cache.delete(message.id);
    const reposted = await req(`${path}/repost`, 'POST', { confirmed: true });
    assert.equal(reposted.status, 200);
    const [fresh] = [...fx.panelChannel.messages.cache.values()];
    assert.deepEqual(reposted.body, { ok: true, messageId: fresh.id, url: fresh.url });
    assert.deepEqual([fresh.embeds[0].title, fresh.embeds[0].description], ['Colours', 'Pick one']);
    assert.deepEqual(Object.keys(await fx.stored()), [fresh.id]);

    const [moved] = (await view()).panels;
    const deleted = await req(`${BASE}/panels/${fresh.id}`, 'DELETE', { confirmed: true, revision: moved.revision });
    assert.deepEqual(deleted.body, { ok: true, messageDeleted: true });
    assert.deepEqual(await fx.stored(), {});
    assert.equal(fx.panelChannel.messages.cache.size, 0);
});

test('API: an administrator who is not the owner may only offer roles below their own', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    fx.client.isReady = () => true;
    const mod = fx.addMember(memberId(9), [], ['Administrator']);
    mod.roles.highest = fx.R[3];
    const app = express();
    app.use('/api', createReactionRolesApi(fx.client, { auth: (req, res, next) => { req.guild = fx.guild; req.member = mod; next(); }, csrf: (req, res, next) => next() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}/api${BASE}`;
    const send = async (path, method, body) => {
        const response = await fetch(origin + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() };
    };

    const data = (await send('', 'GET')).body;
    assert.deepEqual(data.roles.filter((role) => role.usable).map((role) => role.name), ['Role 2', 'Role 1']);
    assert.equal(data.roles.find((role) => role.name === 'Role 5').reason, 'Posisinya tidak di bawah role tertinggi Anda.');

    const body = { confirmed: true, channelId: fx.panelChannel.id, title: 'T', description: 'D' };
    const refused = await send('/panels', 'POST', { ...body, roleIds: [fx.R[1].id, fx.R[5].id] });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /tidak di bawah role tertinggi Anda/);
    assert.equal(fx.calls.send.length, 0);
    assert.equal((await send('/panels', 'POST', { ...body, roleIds: [fx.R[1].id] })).status, 200);
});

test('API: every change is handed to the log with the acting user; refusals are not, and a failing log changes nothing', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    fx.client.isReady = () => true;
    const records = [];
    let broken = false;
    const audit = async (client, guild, action, details) => {
        if (broken) throw new Error('log channel unavailable');
        records.push([guild, action, details]);
    };
    const app = express();
    app.use('/api', createReactionRolesApi(fx.client, { auth: (req, res, next) => { req.guild = fx.guild; req.member = fx.admin; next(); }, csrf: (req, res, next) => next(), audit }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}/api${BASE}`;
    const send = async (path, method = 'GET', body) => {
        const response = await fetch(origin + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        await tick();
        return { status: response.status, body: await response.json() };
    };
    const revision = async () => (await send('')).body.panels[0].revision;
    const by = { source: 'dashboard', actorId: fx.admin.id };

    const created = await send('/panels', 'POST', { confirmed: true, channelId: fx.panelChannel.id, title: 'Colours', description: 'Pick', roleIds: [fx.R[1].id, fx.R[2].id] });
    let id = created.body.messageId;
    const at = () => ({ ...by, messageId: id, channelId: fx.panelChannel.id });
    assert.deepEqual(records.pop(), [guildId, 'create', { ...at(), title: 'Colours', roleIds: [fx.R[1].id, fx.R[2].id] }]);

    // Refused: wrong revision, duplicate role, unconfirmed.
    assert.equal((await send(`/panels/${id}/roles`, 'POST', { confirmed: true, revision: 'a'.repeat(64), roleId: fx.R[3].id })).status, 409);
    assert.equal((await send(`/panels/${id}/roles`, 'POST', { confirmed: true, revision: await revision(), roleId: fx.R[1].id })).status, 409);
    assert.equal((await send(`/panels/${id}`, 'DELETE', { confirmed: false, revision: await revision() })).status, 400);
    assert.deepEqual(records, []);

    await send(`/panels/${id}/roles`, 'POST', { confirmed: true, revision: await revision(), roleId: fx.R[3].id });
    assert.deepEqual(records.pop(), [guildId, 'role_add', { ...at(), title: 'Colours', roleId: fx.R[3].id }]);
    await send(`/panels/${id}/roles/${fx.R[1].id}`, 'DELETE', { confirmed: true, revision: await revision() });
    assert.deepEqual(records.pop(), [guildId, 'role_remove', { ...at(), title: 'Colours', roleId: fx.R[1].id }]);
    await send(`/panels/${id}`, 'PATCH', { confirmed: true, revision: await revision(), title: 'Shades', description: 'Pick one' });
    assert.deepEqual(records.pop(), [guildId, 'text', { ...at(), title: 'Shades' }]);
    // Redrawing the message changes nothing that is stored and is not logged.
    await send(`/panels/${id}/refresh`, 'POST', { confirmed: true });
    assert.deepEqual(records, []);

    fx.panelChannel.messages.cache.delete(id);
    id = (await send(`/panels/${id}/repost`, 'POST', { confirmed: true })).body.messageId;
    assert.deepEqual(records.pop(), [guildId, 'repost', { ...at(), title: 'Shades', roleIds: [fx.R[2].id, fx.R[3].id] }]);

    broken = true;
    const deleted = await send(`/panels/${id}`, 'DELETE', { confirmed: true, revision: await revision() });
    assert.deepEqual([deleted.status, deleted.body], [200, { ok: true, messageDeleted: true }]);
    assert.deepEqual(await fx.stored(), {});
});

test('API: with a log channel configured, a change made on the web is written there as coming from the dashboard', { skip }, async (t) => {
    const { fx, make } = await api(t);
    await fx.query('UPDATE guilds SET config = config || $2::jsonb WHERE id = $1', [guildId, JSON.stringify({ logging: { enabled: true, channels: { audit: fx.adminChannel.id } } })]);
    const created = await make({ title: 'Colours' });
    assert.equal(created.status, 200);
    let entry;
    for (let n = 0; n < 100 && !entry; n++) {
        await tick();
        entry = fx.calls.send.find((call) => call.channelId === fx.adminChannel.id);
    }
    const embed = entry.payload.embeds[0].data ?? entry.payload.embeds[0];
    assert.equal(embed.title, 'Reaction Role Panel Created');
    assert.match(embed.description, new RegExp(`\\*\\*Source:\\*\\* web dashboard[\\s\\S]*\\*\\*Message:\\*\\* ${created.body.messageId}[\\s\\S]*\\*\\*Panel:\\*\\* Colours[\\s\\S]*\\*\\*Roles:\\*\\* <@&${fx.R[1].id}>, <@&${fx.R[2].id}>`));
    assert.match(embed.description, /\*\*By:\*\* <@\d{17,20}>/);
});

test('API: a database failure is a 503 without details and reaches neither Discord nor the browser with its message', { skip }, async (t) => {
    const { fx, req, make } = await api(t);
    const message = await fx.seedPanel();
    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    const read = await req(BASE);
    assert.deepEqual([read.status, read.body], [503, { error: 'Panel tidak dapat dibaca dari database.' }]);
    for (const write of [
        await make(),
        await req(`${BASE}/panels/${message.id}`, 'DELETE', { confirmed: true, revision: 'a'.repeat(64) }),
        await req(`${BASE}/panels/${message.id}/refresh`, 'POST', { confirmed: true }),
        await req(`${BASE}/panels/${message.id}/repost`, 'POST', { confirmed: true }),
    ]) {
        assert.equal(write.status, 503);
        assert.doesNotMatch(JSON.stringify(write.body), /injected/);
    }
    fx.control.failQuery = null;
    assert.equal(fx.calls.send.length + fx.calls.edit.length + fx.calls.delete.length, 0);
});

test('API: malformed and oversized JSON are answered in the API format', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    fx.client.isReady = () => true;
    const app = express();
    app.use('/api', createReactionRolesApi(fx.client, { auth: (req, res, next) => { req.guild = fx.guild; next(); }, csrf: (req, res, next) => next() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const send = (body) => fetch(`http://127.0.0.1:${server.address().port}/api${BASE}/panels`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

    const malformed = await send('{"confirmed":');
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Permintaan tidak valid.' });
    const large = await send(JSON.stringify({ confirmed: true, pad: 'x'.repeat(20000) }));
    assert.equal(large.status, 413);
    assert.deepEqual(await large.json(), { error: 'Permintaan tidak valid.' });

    // This router was mounted without a member on the request: role rules cannot be checked, so nothing is served.
    const origin = `http://127.0.0.1:${server.address().port}/api${BASE}`;
    assert.equal((await fetch(origin)).status, 403);
    const created = await send(JSON.stringify({ confirmed: true, channelId: fx.panelChannel.id, title: 'T', description: 'D', roleIds: [fx.R[1].id] }));
    assert.deepEqual([created.status, await created.json()], [403, { error: 'Akses ditolak.' }]);
    const message = await fx.seedPanel();
    const added = await fetch(`${origin}/panels/${message.id}/roles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, revision: 'a'.repeat(64), roleId: fx.R[3].id }) });
    assert.equal(added.status, 403);
    const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    for (const refused of [
        await fetch(`${origin}/panels/${message.id}`, json('PATCH', { confirmed: true, revision: 'a'.repeat(64), title: 'A', description: 'B' })),
        await fetch(`${origin}/panels/${message.id}/roles/${fx.R[1].id}`, json('DELETE', { confirmed: true, revision: 'a'.repeat(64) })),
        await fetch(`${origin}/panels/${message.id}/refresh`, json('POST', { confirmed: true })),
        await fetch(`${origin}/panels/${message.id}/repost`, json('POST', { confirmed: true })),
        await fetch(`${origin}/panels/${message.id}`, json('DELETE', { confirmed: true, revision: 'a'.repeat(64) })),
    ]) assert.equal(refused.status, 403);
    assert.equal(fx.calls.send.length + fx.calls.edit.length + fx.calls.delete.length + fx.calls.fetchMessage.length, 0);
});

// ---- page ---------------------------------------------------------------------------

/** The dashboard page on the Reaction Roles room; its requests go to the real router. */
async function openPage(t, { confirm = true, url = 'http://localhost/dashboard/#features/reaction-roles', arrange } = {}) {
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
        if (!path.startsWith('/dashboard/api/bot/reaction-roles')) return { ok: false, status: 503, json: async () => ({ error: 'tidak tersedia' }) };
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
    const root = () => w.document.querySelector('#reactRolesLive');
    const submit = async (form) => { form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await settle(); };
    const click = async (button) => { button.click(); await settle(); };
    const writes = () => calls.filter((call) => call.method !== 'GET');
    const status = () => root().querySelector('#reactRolesStatus').textContent;
    return { fx, w, root, submit, click, settle, confirms, calls, writes, status };
}

test('page: create a panel from the form, after a confirmation that names the channel and the roles', { skip }, async (t) => {
    const page = await openPage(t, { arrange: (fx) => { fx.addRole(roleId(22), { name: 'Booster', position: 22, managed: true }); } });
    const { fx } = page;
    assert.match(page.w.document.querySelector('.f-demo-warning').textContent, /DATA POSTGRESQL · MENGIRIM, MENGUBAH, DAN MENGHAPUS PESAN DI DISCORD/);
    assert.match(page.root().querySelector('#reactRolesList').textContent, /Belum ada panel/);

    const form = page.root().querySelector('#reactRolesCreateForm');
    const boxes = [...form.querySelectorAll('input[name="roleIds"]')];
    // A role that cannot be offered is shown with its reason and cannot be ticked.
    const booster = boxes.find((box) => box.value === roleId(22));
    assert.equal(booster.disabled, true);
    assert.match(booster.parentElement.textContent, /Booster — Role dikelola oleh bot atau integrasi/);
    const createStatus = () => page.root().querySelector('#reactRolesCreateStatus').textContent;

    // Step by step: nothing is asked and nothing is sent until the form is complete.
    await page.submit(form);
    assert.match(createStatus(), /Pilih channel/);
    form.elements.channelId.value = fx.panelChannel.id;
    await page.submit(form);
    assert.match(createStatus(), /Judul dan deskripsi wajib diisi/);
    form.elements.title.value = ' Warna ';
    form.elements.description.value = 'Pilih warna';
    await page.submit(form);
    assert.match(createStatus(), /Pilih minimal satu role/);
    assert.deepEqual([page.confirms.length, page.writes().length], [0, 0]);

    boxes.find((box) => box.value === fx.R[2].id).checked = true;
    boxes.find((box) => box.value === fx.R[1].id).checked = true;
    await page.submit(form);
    assert.equal(page.confirms.length, 1);
    assert.match(page.confirms[0], /Kirim panel "Warna" ke #roles\? Semua anggota yang melihatnya dapat mengambil sendiri role: Role 2, Role 1\./);
    assert.deepEqual(page.writes(), [{
        method: 'POST', path: '/reaction-roles/panels', csrf: 'c',
        body: { confirmed: true, channelId: fx.panelChannel.id, title: 'Warna', description: 'Pilih warna', roleIds: [fx.R[2].id, fx.R[1].id] },
    }]);
    const [message] = [...fx.panelChannel.messages.cache.values()];
    assert.equal(tail(fx.menuRoles(message)), '21');
    assert.match(page.status(), /Panel dibuat dan dikirim ke Discord/);
    assert.match(page.root().querySelector('[data-panel] h3').textContent, /Warna/);
});

test('page: declining the confirmation sends nothing', { skip }, async (t) => {
    const page = await openPage(t, { confirm: false, arrange: (fx) => fx.seedPanel() });
    const block = page.root().querySelector('[data-panel]');
    const text = block.querySelector('form[data-text]');
    text.elements.title.value = 'Other';
    await page.submit(text);
    const add = block.querySelector('form[data-add]');
    add.elements.roleId.value = page.fx.R[3].id;
    await page.submit(add);
    await page.click(block.querySelector('[data-remove]'));
    await page.click(block.querySelector('[data-refresh]'));
    await page.click(block.querySelector('[data-delete]'));
    assert.equal(page.confirms.length, 5);
    assert.deepEqual(page.writes(), []);
    assert.equal(page.fx.calls.edit.length + page.fx.calls.delete.length, 0);
});

test('page: change text, add and remove a role, refresh and delete; each confirmation says what happens on Discord', { skip }, async (t) => {
    let message;
    const page = await openPage(t, { arrange: async (fx) => { message = await fx.seedPanel(); } });
    const { fx } = page;
    const block = () => page.root().querySelector('[data-panel]');
    const path = `/reaction-roles/panels/${message.id}`;
    assert.match(block().textContent, /#roles · ID pesan/);
    assert.match(block().textContent, /Status: Aktif di Discord/);
    assert.equal(block().querySelector('a').getAttribute('href'), message.url);

    // Unchanged text is not sent.
    await page.submit(block().querySelector('form[data-text]'));
    assert.match(page.status(), /Teks tidak berubah/);
    assert.equal(page.writes().length, 0);

    let text = block().querySelector('form[data-text]');
    text.elements.title.value = 'Warna';
    text.elements.description.value = 'Pilih warna';
    await page.submit(text);
    assert.match(page.confirms.at(-1), /Ubah judul dan deskripsi panel "Pick roles"\? Pesannya di Discord ikut diubah/);
    assert.deepEqual([message.embeds[0].title, message.embeds[0].description], ['Warna', 'Pilih warna']);
    assert.match(page.status(), /Teks panel disimpan\. Pesan panel di Discord sudah mengikuti/);

    const add = block().querySelector('form[data-add]');
    // Roles already on the panel are not offered again.
    assert.deepEqual([...add.elements.roleId.options].map((option) => option.textContent), ['Pilih role', 'Role 6', 'Role 5', 'Role 4', 'Role 3']);
    await page.submit(add);
    assert.match(page.status(), /Pilih role terlebih dahulu/);
    add.elements.roleId.value = fx.R[3].id;
    await page.submit(add);
    assert.match(page.confirms.at(-1), /Tambahkan role "Role 3" ke panel "Warna"\? Semua anggota yang melihat panel dapat mengambil role itu sendiri/);
    assert.equal(tail(fx.menuRoles(message)), '123');

    await page.click(block().querySelector(`[data-remove="${fx.R[1].id}"]`));
    assert.match(page.confirms.at(-1), /Lepas role "Role 1" dari panel "Warna"\? Anggota yang sudah memilikinya tetap memilikinya/);
    assert.equal(tail(fx.menuRoles(message)), '23');

    await page.click(block().querySelector('[data-refresh]'));
    assert.match(page.status(), /Pesan panel digambar ulang/);

    // Every write carried the revision the page was showing and the CSRF token.
    const writes = page.writes();
    assert.deepEqual(writes.map((call) => `${call.method} ${call.path}`), [
        `PATCH ${path}`, `POST ${path}/roles`, `DELETE ${path}/roles/${fx.R[1].id}`, `POST ${path}/refresh`,
    ]);
    assert.ok(writes.every((call) => call.csrf === 'c' && call.body.confirmed === true));
    assert.equal(new Set(writes.slice(0, 3).map((call) => call.body.revision)).size, 3);

    await page.click(block().querySelector('[data-delete]'));
    assert.match(page.confirms.at(-1), /Hapus panel "Warna"\? Pesannya DIHAPUS dari Discord dan tidak dapat dikembalikan\. Role yang sudah dimiliki anggota tidak dicabut/);
    assert.match(page.status(), /Panel dan pesannya dihapus/);
    assert.equal(fx.panelChannel.messages.cache.size, 0);
    assert.deepEqual(await fx.stored(), {});
});

test('page: a refusal is shown in place and the controls work again; a stale page is told to reload', { skip }, async (t) => {
    let message;
    const page = await openPage(t, { arrange: async (fx) => { message = await fx.seedPanel(); } });
    const { fx } = page;
    const block = () => page.root().querySelector('[data-panel]');

    fx.hooks.deleteMessage = () => { throw missingPermissions(); };
    await page.click(block().querySelector('[data-delete]'));
    assert.match(page.status(), /Discord menolak permintaan\. Tidak ada yang diubah\. Bila hasilnya tidak jelas, muat ulang/);
    assert.equal(block().querySelector('[data-delete]').disabled, false);
    assert.equal(fx.panelChannel.messages.cache.has(message.id), true);
    fx.hooks.deleteMessage = null;

    // Changed elsewhere (the slash command) after the page was loaded.
    const { addPanelRole } = await import('../src/services/reactionRoles/manage.js');
    await addPanelRole(fx.client, fx.guild, message.id, fx.R[4]);
    const add = block().querySelector('form[data-add]');
    add.elements.roleId.value = fx.R[3].id;
    await page.submit(add);
    assert.match(page.status(), /Panel berubah sejak halaman dimuat/);
    assert.equal(tail((await fx.stored())[message.id].roles), '124');

    // The stored change whose message did not follow is said in words.
    await page.click(page.root().querySelector('#reactRolesReload'));
    fx.hooks.editMessage = () => { throw missingPermissions(); };
    const again = block().querySelector('form[data-add]');
    again.elements.roleId.value = fx.R[3].id;
    await page.submit(again);
    assert.match(page.status(), /Role ditambahkan\. Tersimpan, tetapi pesan panel belum dapat diperbarui\. Tekan SEGARKAN PESAN/);
});

test('page: names from Discord are shown as text; states are described; a missing message offers repost', { skip }, async (t) => {
    const evil = '<img src=x onerror=alert(1)>';
    const page = await openPage(t, {
        arrange: async (fx) => {
            fx.R[1].name = evil;
            fx.panelChannel.name = evil;
            const shown = await fx.seedPanel([fx.R[1]], { title: evil, description: `"></textarea>${evil}` });
            const gone = await fx.seedPanel([fx.R[2], fx.R[3]], { extra: { title: 'Gone' } });
            fx.panelChannel.messages.cache.delete(gone.id);
            fx.roles.delete(fx.R[3].id);
            const orphan = await fx.seedPanel([fx.R[4]], { channel: fx.adminChannel, extra: { title: 'Orphan' } });
            fx.channels.delete(fx.adminChannel.id);
            shown.url = 'javascript:alert(1)';
            fx.keep = { shown, gone, orphan };
        },
    });
    const { fx } = page;
    assert.equal(page.root().querySelectorAll('img').length, 0);
    assert.equal(page.w.document.querySelectorAll('[onerror]').length, 0);
    const blocks = [...page.root().querySelectorAll('[data-panel]')];
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0].querySelector('h3').textContent, evil);
    assert.equal(blocks[0].querySelector('textarea').value, `"></textarea>${evil}`);
    // A link that is not a Discord message link is not turned into a link.
    assert.equal(blocks[0].querySelector('a'), null);
    // The only role of a panel cannot be removed.
    assert.equal(blocks[0].querySelector('[data-remove]').disabled, true);

    assert.match(blocks[1].textContent, /Pesan panel sudah dihapus di Discord — pasang ulang/);
    assert.match(blocks[1].textContent, new RegExp(`Role terhapus \\(${fx.R[3].id}\\).*Tidak dapat diberikan: Role sudah tidak ada`));
    assert.ok(blocks[1].querySelector('[data-repost]'));
    assert.equal(blocks[1].querySelector('[data-refresh]'), null);
    assert.match(blocks[2].textContent, /Channel tidak terlihat oleh bot/);
    assert.match(blocks[2].textContent, /Channel panel sudah tidak ada — hapus panel ini/);
    assert.equal(blocks[2].querySelector('[data-repost]'), null);

    await page.click(blocks[1].querySelector('[data-repost]'));
    assert.match(page.confirms.at(-1), /Pasang ulang panel "Gone"\? Pesan baru dikirim ke #<img/);
    assert.match(page.status(), /Panel dipasang ulang sebagai pesan baru/);
    const stored = await fx.stored();
    assert.equal(stored[fx.keep.gone.id], undefined);
    assert.equal(Object.keys(stored).length, 3);

    // A panel without a channel: the confirmation says only the record goes.
    const orphan = [...page.root().querySelectorAll('[data-panel]')].find((block) => /Orphan/.test(block.querySelector('h3').textContent));
    await page.click(orphan.querySelector('[data-delete]'));
    assert.match(page.confirms.at(-1), /Pesannya tidak ditemukan; hanya catatan panel yang dihapus/);
    assert.match(page.status(), /Panel dihapus\. Pesannya sudah tidak ada/);
});

test('page: at the limit no create form is offered; a read failure offers a retry', { skip }, async (t) => {
    const page = await openPage(t, { arrange: async (fx) => { for (let n = 0; n < 5; n++) await fx.seedPanel([fx.R[1]]); } });
    const { fx } = page;
    assert.equal(page.root().querySelector('#reactRolesCreateForm'), null);
    assert.match(page.root().querySelector('#reactRolesCreate').textContent, /sudah memiliki 5 panel \(batas maksimum\)/);

    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    await page.click(page.root().querySelector('#reactRolesReload'));
    assert.match(page.root().querySelector('#reactRolesList').textContent, /Panel tidak dapat dibaca dari database/);
    assert.doesNotMatch(page.root().textContent, /injected/);
    assert.match(page.root().querySelector('#reactRolesCreate').textContent, /Tidak tersedia sampai daftar panel dapat dibaca/);
    fx.control.failQuery = null;
    await page.click(page.root().querySelector('#reactRolesRetry'));
    assert.equal(page.root().querySelectorAll('[data-panel]').length, 5);
});

test('static preview: the Reaction Roles room is a labelled placeholder and requests nothing', { skip }, async (t) => {
    const page = await openPage(t, { url: 'http://localhost/preview/#features/reaction-roles' });
    assert.equal(page.root(), null);
    assert.match(page.w.document.querySelector('.f-demo-warning').textContent, /PREVIEW · DATA CONTOH · TIDAK TERHUBUNG KE DISCORD/);
    assert.match(page.w.document.querySelector('.f-content').textContent, /Preview saja; tidak terhubung ke bot/);
    assert.deepEqual(page.calls, []);
});
