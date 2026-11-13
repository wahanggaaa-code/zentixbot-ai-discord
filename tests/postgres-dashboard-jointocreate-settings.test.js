import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createJoinToCreateSettingsApi } from '../src/dashboard/joinToCreateSettingsApi.js';
import { createDashboardRouter } from '../src/dashboard/router.js';
import { handleJoinToCreateVoiceState, joinToCreateTiming } from '../src/services/joinToCreateRuntime.js';
import {
    setupJoinToCreate,
    registerJoinToCreateChannel,
    reserveJoinToCreate,
    updateJoinToCreate,
} from '../src/services/storage/postgresJoinToCreateTransactions.js';
import { pgEnabled as enabled, GUILD_ID, TRIGGER_ID, snowflake, createJtcDatabase } from './helpers/jtc-postgres-fixture.js';
import { createFakeGuild } from './helpers/fake-discord-guild.js';

const ADMIN = '234567890123456789';
const OWNER = snowflake(2001);
const STALE = 'a'.repeat(64);

const originalTiming = { ...joinToCreateTiming };
test.beforeEach(() => Object.assign(joinToCreateTiming, { pendingStaleMs: 250, createTimeoutMs: 100, discordTimeoutMs: 200, cooldownMs: 0 }));
test.after(() => Object.assign(joinToCreateTiming, originalTiming));

async function listen(t, app) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
}

/** PostgreSQL, a fake guild with three channels, and the settings API behind stub auth/CSRF. */
async function setup(t) {
    const db = await createJtcDatabase(t, 'jtc_set');
    const discord = createFakeGuild({ id: GUILD_ID });
    db.client.guilds = { cache: new Map([[GUILD_ID, discord.guild]]) };
    db.client.isReady = () => true;

    const category = discord.addChannel({ type: ChannelType.GuildCategory, name: 'Voice <b>' });
    const lobby = discord.addChannel({ name: 'Lobby', parentId: category.id, channelId: TRIGGER_ID });
    const locked = discord.addChannel({ name: 'Locked', channelId: snowflake(3002) });
    locked.botHasPermissions = false;
    const text = discord.addChannel({ type: ChannelType.GuildText, name: 'general', channelId: snowflake(3003) });

    const audits = [];
    const auth = (req, res, next) => {
        if (req.get('x-auth') !== 'yes') return res.status(401).json({ error: 'login' });
        req.guild = discord.guild;
        req.session = { user: { id: ADMIN }, csrf: 'token' };
        next();
    };
    const csrf = (req, res, next) => (req.get('x-csrf-token') === 'token' ? next() : res.status(403).json({ error: 'csrf' }));
    const app = express();
    app.use('/api', createJoinToCreateSettingsApi(db.client, { auth, csrf, audit: async (...args) => { audits.push(args.slice(1)); } }));
    const root = await listen(t, app);

    const call = async (method, path = '', body, headers = { 'x-auth': 'yes', 'x-csrf-token': 'token' }) => {
        const response = await fetch(`${root}/api/join-to-create/settings${path}`, {
            method,
            headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        });
        const raw = await response.text();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        return { status: response.status, json, raw, cache: response.headers.get('cache-control') };
    };
    const view = async () => (await call('GET')).json;
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    return { ...db, discord, category, lobby, locked, text, audits, call, view, flush };
}

const validSetup = (channelId = TRIGGER_ID) => ({ confirmed: true, channelId, nameTemplate: '{username} room', userLimit: 4, bitrate: 64000 });

test('settings view pairs values with their revision, lists voice channels for setup and leaks nothing private', { skip: !enabled }, async (t) => {
    const s = await setup(t);

    const empty = await s.call('GET');
    assert.equal(empty.status, 200);
    assert.equal(empty.cache, 'no-store');
    assert.match(empty.json.configRevision, /^[0-9a-f]{64}$/);
    assert.deepEqual(empty.json.triggers, []);
    assert.equal(empty.json.enabled, false);
    assert.deepEqual(empty.json.voiceChannels, [
        { id: s.locked.id, name: 'Locked', category: null, usable: false },
        { id: TRIGGER_ID, name: 'Lobby', category: 'Voice <b>', usable: true },
    ], 'voice channels only (uncategorized first), with whether the bot can manage them');
    assert.ok(empty.json.placeholders.includes('{username}'));
    assert.deepEqual(empty.json.limits, { nameTemplate: 100, guildBitrate: 96000 });

    await setupJoinToCreate(s.client, GUILD_ID, TRIGGER_ID, { userLimit: 3 });
    await registerJoinToCreateChannel(s.client, GUILD_ID, snowflake(5001), OWNER, TRIGGER_ID, 1700000000000);
    await reserveJoinToCreate(s.client, GUILD_ID, snowflake(2002), TRIGGER_ID);
    const token = Object.keys((await s.data()).pendingCreates)[0];

    const stored = await s.call('GET');
    assert.deepEqual(stored.json.triggers, [{
        channelId: TRIGGER_ID, channelName: 'Lobby', botCanManage: true,
        nameTemplate: "{username}'s Room", userLimit: 3, bitrate: 64000,
    }], 'effective values: stored option plus defaults');
    assert.deepEqual(stored.json.voiceChannels, [], 'no channel list once a trigger exists');
    assert.equal(stored.json.busy, true);
    assert.equal(stored.json.temporaryCount, 1);
    assert.doesNotMatch(stored.raw, new RegExp(`${OWNER}|${snowflake(2002)}|${token}|ownerId`));
    assert.notEqual(stored.json.configRevision, empty.json.configRevision);

    // A trigger whose channel the bot no longer sees is shown as such, not hidden.
    s.discord.channels.delete(TRIGGER_ID);
    const gone = (await s.view()).triggers[0];
    assert.equal(gone.channelName, null);
    assert.equal(gone.botCanManage, null);

    assert.equal((await s.call('GET', '?x=1')).status, 400);
    assert.equal((await s.call('GET', '', undefined, {})).status, 401);
});

test('setup from the web checks the channel and the bot permissions, then stores through the protocol', { skip: !enabled }, async (t) => {
    const s = await setup(t);

    const refused = [
        [validSetup(s.text.id), /channel suara/],
        [validSetup(s.category.id), /channel suara/],
        [validSetup(snowflake(9999)), /channel suara/],
        [validSetup(s.locked.id), /Manage Channels/],
        [{ ...validSetup(), nameTemplate: '{nope}' }, /Template nama tidak valid/],
        [{ ...validSetup(), nameTemplate: '@everyone room' }, /Template nama tidak valid/],
        [{ ...validSetup(), userLimit: 100 }, /0 sampai 99/],
        [{ ...validSetup(), bitrate: 64 }, /8 sampai 384/],
    ];
    for (const [body, message] of refused) {
        const response = await s.call('POST', '/triggers', body);
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match(response.json.error, message);
    }
    assert.equal(await s.data(), undefined, 'nothing stored by refused requests');

    s.client.isReady = () => false;
    assert.equal((await s.call('POST', '/triggers', validSetup())).status, 503);
    s.client.isReady = () => true;

    const created = await s.call('POST', '/triggers', { ...validSetup(), nameTemplate: '  {username} room\u200b ' });
    assert.deepEqual([created.status, created.json], [200, { ok: true }]);
    const stored = await s.data();
    assert.equal(stored.enabled, true);
    assert.deepEqual(stored.triggerChannels, [TRIGGER_ID]);
    assert.deepEqual(stored.channelOptions[TRIGGER_ID], { nameTemplate: '{username} room', userLimit: 4, bitrate: 64000 }, 'template stored normalized');

    const again = await s.call('POST', '/triggers', validSetup());
    assert.equal(again.status, 409);
    assert.match(again.json.error, /sudah memiliki trigger/);

    await s.flush();
    assert.deepEqual(s.audits, [[GUILD_ID, ADMIN, 'Dashboard: Initialized Join to Create', { channelId: TRIGGER_ID, nameTemplate: '{username} room', userLimit: 4, bitrate: 64000 }]]);
    assert.equal(s.discord.calls.create.length + s.discord.calls.delete.length + s.discord.calls.move.length, 0, 'no Discord effect');
});

test('a registered temporary channel cannot become the trigger', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    const temporary = s.discord.addChannel({ name: 'someone\'s room', channelId: snowflake(5001) });
    await s.put({ enabled: false, triggerChannels: [], temporaryChannels: { [temporary.id]: { ownerId: OWNER, triggerChannelId: TRIGGER_ID } } });
    const response = await s.call('POST', '/triggers', validSetup(temporary.id));
    assert.equal(response.status, 409);
    assert.deepEqual((await s.data()).triggerChannels, []);
});

test('an edit changes only the submitted fields, survives channel churn and is refused when settings changed', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    await s.put({
        enabled: true, triggerChannels: [TRIGGER_ID], temporaryChannels: {}, custom: { keep: true },
        channelOptions: { [TRIGGER_ID]: { nameTemplate: '{username} room', userLimit: 4, extra: 'kept' } },
    });
    const path = `/triggers/${TRIGGER_ID}`;
    const { configRevision } = await s.view();

    // Members creating channels do not invalidate what the administrator is looking at.
    await registerJoinToCreateChannel(s.client, GUILD_ID, snowflake(5001), OWNER, TRIGGER_ID, 1);
    assert.equal((await s.view()).configRevision, configRevision);

    const saved = await s.call('PATCH', path, { confirmed: true, revision: configRevision, userLimit: 10 });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { ok: true, options: { nameTemplate: '{username} room', userLimit: 10, bitrate: 64000 } });
    let stored = await s.data();
    assert.deepEqual(stored.channelOptions[TRIGGER_ID], { nameTemplate: '{username} room', userLimit: 10, extra: 'kept' }, 'bitrate was not submitted, so it is not written');
    assert.deepEqual(stored.custom, { keep: true });
    assert.equal(stored.temporaryChannels[snowflake(5001)].ownerId, OWNER);

    // The page still holds the old revision: a second save must not go through.
    const stale = await s.call('PATCH', path, { confirmed: true, revision: configRevision, bitrate: 96000 });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error, /berubah sejak halaman dimuat/);
    assert.equal((await s.data()).channelOptions[TRIGGER_ID].bitrate, undefined);

    // So is an edit made in Discord with /jointocreate in the meantime.
    const fresh = (await s.view()).configRevision;
    await updateJoinToCreate(s.client, GUILD_ID, TRIGGER_ID, { nameTemplate: 'from discord' });
    assert.equal((await s.call('PATCH', path, { confirmed: true, revision: fresh, userLimit: 1 })).status, 409);
    stored = await s.data();
    assert.deepEqual([stored.channelOptions[TRIGGER_ID].nameTemplate, stored.channelOptions[TRIGGER_ID].userLimit], ['from discord', 10]);

    const current = (await s.view()).configRevision;
    const refused = [
        [{ confirmed: true, revision: current, nameTemplate: 'x'.repeat(101) }, 400],
        [{ confirmed: true, revision: current, nameTemplate: '   ' }, 400],
        [{ confirmed: true, revision: current, userLimit: 2.5 }, 400],
        [{ confirmed: true, revision: current, userLimit: '2' }, 400],
        [{ confirmed: true, revision: current, bitrate: 500000 }, 400],
        [{ confirmed: true, revision: current }, 400],
    ];
    for (const [body, status] of refused) assert.equal((await s.call('PATCH', path, body)).status, status, JSON.stringify(body));
    const unknown = await s.call('PATCH', `/triggers/${snowflake(7777)}`, { confirmed: true, revision: current, userLimit: 2 });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await s.data(), stored, 'refused requests changed nothing');

    await s.flush();
    assert.deepEqual(s.audits, [[GUILD_ID, ADMIN, 'Dashboard: Updated trigger settings', { channelId: TRIGGER_ID, userLimit: 10 }]], 'only the successful change is recorded');
});

test('two administrators saving at once: one wins, the other is told to reload', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    await setupJoinToCreate(s.client, GUILD_ID, TRIGGER_ID, { userLimit: 1 });
    const { configRevision } = await s.view();
    const results = await Promise.all([2, 3, 4, 5, 6, 7].map((userLimit) => s.call('PATCH', `/triggers/${TRIGGER_ID}`, { confirmed: true, revision: configRevision, userLimit })));
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409, 409, 409, 409, 409]);
    const winner = results.find((result) => result.status === 200).json.options.userLimit;
    assert.equal((await s.data()).channelOptions[TRIGGER_ID].userLimit, winner);
});

test('removing a trigger keeps temporary channels managed and deletes nothing in Discord', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    await setupJoinToCreate(s.client, GUILD_ID, TRIGGER_ID, { userLimit: 1 });
    await registerJoinToCreateChannel(s.client, GUILD_ID, snowflake(5001), OWNER, TRIGGER_ID, 1);
    const path = `/triggers/${TRIGGER_ID}`;
    const { configRevision } = await s.view();

    assert.equal((await s.call('DELETE', path, { confirmed: true, revision: STALE })).status, 409);
    assert.equal((await s.call('DELETE', path, { revision: configRevision })).status, 400, 'confirmation is required');
    assert.equal((await s.call('DELETE', path)).status, 400);
    assert.equal((await s.data()).enabled, true);

    const removed = await s.call('DELETE', path, { confirmed: true, revision: configRevision });
    assert.deepEqual([removed.status, removed.json], [200, { ok: true }]);
    const stored = await s.data();
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.triggerChannels, []);
    assert.equal(stored.channelOptions[TRIGGER_ID], undefined);
    assert.equal(stored.temporaryChannels[snowflake(5001)].ownerId, OWNER);
    assert.ok(s.discord.channels.has(TRIGGER_ID), 'the Discord channel is left alone');
    assert.equal(s.discord.calls.delete.length, 0);

    assert.equal((await s.call('DELETE', path, { confirmed: true, revision: (await s.view()).configRevision })).status, 404);
    // The page now offers setup again, and it works.
    assert.equal((await s.view()).voiceChannels.length, 2);
    assert.equal((await s.call('POST', '/triggers', validSetup())).status, 200);
});

test('a setting saved on the web is what the next member gets', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    assert.equal((await s.call('POST', '/triggers', validSetup())).status, 200);
    const { configRevision } = await s.view();
    assert.equal((await s.call('PATCH', `/triggers/${TRIGGER_ID}`, { confirmed: true, revision: configRevision, nameTemplate: 'Ruang {display_name}', userLimit: 7 })).status, 200);

    const member = s.discord.addMember(snowflake(2100), { username: 'dewi', displayName: 'Dewi' });
    const { oldState, newState } = s.discord.voiceStates(member, TRIGGER_ID);
    const result = await handleJoinToCreateVoiceState(s.client, oldState, newState);
    assert.equal(result.joined.status, 'created');
    const [created] = s.discord.calls.create;
    assert.deepEqual([created.name, created.userLimit, created.bitrate, created.parent], ['Ruang Dewi', 7, 64000, s.category.id]);
});

test('states that must not be edited are refused with a reason and left untouched', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    await setupJoinToCreate(s.client, GUILD_ID, TRIGGER_ID, { userLimit: 1 });
    const path = `/triggers/${TRIGGER_ID}`;
    const edit = async () => s.call('PATCH', path, { confirmed: true, revision: (await s.view())?.configRevision ?? STALE, userLimit: 9 });

    // A create is in flight: nothing else is written until it is resolved.
    s.discord.addMember(snowflake(2100));
    await reserveJoinToCreate(s.client, GUILD_ID, snowflake(2100), TRIGGER_ID);
    const busy = await edit();
    assert.equal(busy.status, 409);
    assert.match(busy.json.error, /sedang membuat channel/);
    assert.equal((await s.call('DELETE', path, { confirmed: true, revision: (await s.view()).configRevision })).status, 409);
    assert.equal((await s.data()).channelOptions[TRIGGER_ID].userLimit, 1);
    // Once it is stale the edit resolves it first (no matching channel → released) and then saves.
    await new Promise((resolve) => setTimeout(resolve, joinToCreateTiming.pendingStaleMs + 20));
    assert.equal((await edit()).status, 200);
    assert.deepEqual((await s.data()).pendingCreates, {});

    const before = await s.data();
    await s.pool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)', [`${s.key}:channels`, '{}']);
    for (const response of [await s.call('GET'), await s.call('PATCH', path, { confirmed: true, revision: STALE, userLimit: 2 }), await s.call('POST', '/triggers', validSetup())]) {
        assert.equal(response.status, 409);
        assert.match(response.json.error, /format lama/);
    }
    await s.pool.query('DELETE FROM temp_data WHERE key=$1', [`${s.key}:channels`]);

    await s.put(before, new Date(Date.now() + 60000));
    assert.match((await s.call('GET')).json.error, /masa berlaku/);
    await s.put({ ...before, temporaryChannels: { bad: {} } });
    const invalid = await s.call('PATCH', path, { confirmed: true, revision: STALE, userLimit: 2 });
    assert.equal(invalid.status, 409);
    assert.match(invalid.json.error, /perlu diperiksa/);
    assert.deepEqual(await s.data(), { ...before, temporaryChannels: { bad: {} } });

    await s.put(before);
    s.backend.isConnected = false;
    for (const response of [await s.call('GET'), await s.call('PATCH', path, { confirmed: true, revision: STALE, userLimit: 2 })]) {
        assert.equal(response.status, 503);
        assert.match(response.json.error, /tidak tersedia/);
    }
    s.backend.isConnected = true;

    // An unexpected database error is reported without details and without claiming success.
    await s.pool.query('ALTER TABLE temp_data RENAME TO temp_data_gone');
    const broken = await s.call('PATCH', path, { confirmed: true, revision: STALE, userLimit: 2 });
    assert.equal(broken.status, 503);
    assert.doesNotMatch(broken.raw, /relation|temp_data|SELECT/i);
    await s.pool.query('ALTER TABLE temp_data_gone RENAME TO temp_data');
    await s.flush();
    assert.equal(s.audits.length, 1, 'only the one successful edit was recorded');
});

test('malformed requests are rejected before anything is written', { skip: !enabled }, async (t) => {
    const s = await setup(t);
    await setupJoinToCreate(s.client, GUILD_ID, TRIGGER_ID, { userLimit: 1 });
    const before = await s.data();
    const revision = (await s.view()).configRevision;
    const path = `/triggers/${TRIGGER_ID}`;

    const cases = [
        ['PATCH', path, { confirmed: true, revision, userLimit: 2, enabled: false }],          // unknown field
        ['PATCH', path, { confirmed: true, revision, userLimit: 2, channelOptions: {} }],
        ['PATCH', path, { confirmed: 'true', revision, userLimit: 2 }],
        ['PATCH', path, { confirmed: true, revision: 'missing', userLimit: 2 }],
        ['PATCH', path, { confirmed: true, userLimit: 2 }],
        ['PATCH', path, [{ confirmed: true, revision, userLimit: 2 }]],
        ['PATCH', '/triggers/not-an-id', { confirmed: true, revision, userLimit: 2 }],
        ['PATCH', path, '{"confirmed":true,'],                                                    // broken JSON
        ['PATCH', path, JSON.stringify({ confirmed: true, revision, nameTemplate: 'x'.repeat(6000) })], // over the body limit
        ['DELETE', path, { confirmed: true, revision, force: true }],
        ['POST', '/triggers', { ...validSetup(snowflake(3002)), revision }],
        ['POST', '/triggers', { confirmed: true, channelId: TRIGGER_ID }],
    ];
    for (const [method, target, body] of cases) {
        const response = await s.call(method, target, body);
        assert.ok([400, 413].includes(response.status), `${method} ${target} ${JSON.stringify(body).slice(0, 60)} → ${response.status}`);
        assert.equal(typeof response.json?.error, 'string', 'answers in JSON');
        assert.doesNotMatch(response.raw, /SyntaxError|at JSON|node_modules/);
    }
    for (const method of ['POST', 'PATCH', 'DELETE']) {
        const target = method === 'POST' ? '/triggers' : path;
        assert.equal((await s.call(method, target, { confirmed: true, revision, userLimit: 2 }, { 'x-auth': 'yes' })).status, 403, 'CSRF token required');
        assert.equal((await s.call(method, target, { confirmed: true, revision, userLimit: 2 }, { 'x-csrf-token': 'token' })).status, 401, 'login required');
    }
    assert.equal((await s.call('PUT', path, { confirmed: true, revision, userLimit: 2 })).status, 404);
    assert.deepEqual(await s.data(), before);
    await s.flush();
    assert.deepEqual(s.audits, []);
});

test('the real dashboard requires login, administrator rights, the dashboard Origin and the session CSRF token', { skip: !enabled }, async (t) => {
    const db = await createJtcDatabase(t, 'jtc_set');
    const discord = createFakeGuild({ id: GUILD_ID });
    discord.addChannel({ name: 'Lobby', channelId: TRIGGER_ID });
    let administrator = true;
    Object.assign(discord.guild, { ownerId: '999999999999999999' });
    discord.guild.members.fetch = async () => ({ id: ADMIN, permissions: { has: (permission) => administrator && permission === PermissionFlagsBits.Administrator } });
    Object.assign(db.client, { isReady: () => true, guilds: { cache: new Map([[GUILD_ID, discord.guild]]) } });
    await setupJoinToCreate(db.client, GUILD_ID, TRIGGER_ID, { userLimit: 1 });

    const origin = 'http://localhost:9999';
    const mockFetch = async (url) => ({ ok: true, json: async () => (url.endsWith('/token') ? { access_token: 'mock', expires_in: 3600 } : { id: ADMIN, username: 'tester' }) });
    const app = express();
    app.use('/dashboard', createDashboardRouter(db.client, { fetchImpl: mockFetch, env: { CLIENT_ID: '345678901234567890', DISCORD_CLIENT_SECRET: 'fake', DASHBOARD_URL: origin } }));
    const root = await listen(t, app);
    const request = (path, options = {}) => fetch(root + path, { redirect: 'manual', ...options });
    const api = '/dashboard/api/bot/join-to-create/settings';
    const target = `${api}/triggers/${TRIGGER_ID}`;

    assert.equal((await request(api)).status, 401);
    assert.equal((await request(target, { method: 'PATCH', headers: { 'Content-Type': 'application/json', origin }, body: '{}' })).status, 401);

    const start = await request('/dashboard/login');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/dashboard/callback?code=mock&state=${state}`, { headers: { cookie: stateCookie } });
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith('zx_session=')).split(';')[0];
    const me = await (await request('/dashboard/api/me', { headers: { cookie } })).json();

    const view = await request(api, { headers: { cookie } });
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('cache-control'), 'no-store');
    const { configRevision } = await view.json();
    const body = JSON.stringify({ confirmed: true, revision: configRevision, userLimit: 6 });
    const patch = (headers) => request(target, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie, ...headers }, body });

    assert.equal((await patch({ 'x-csrf-token': me.csrf })).status, 403, 'no Origin');
    assert.equal((await patch({ origin: 'http://evil.example', 'x-csrf-token': me.csrf })).status, 403, 'foreign Origin');
    assert.equal((await patch({ origin })).status, 403, 'no CSRF token');
    assert.equal((await patch({ origin, 'x-csrf-token': 'f'.repeat(64) })).status, 403, 'wrong CSRF token');
    assert.equal((await db.data()).channelOptions[TRIGGER_ID].userLimit, 1);

    administrator = false;
    assert.equal((await patch({ origin, 'x-csrf-token': me.csrf })).status, 403, 'administrator right is checked again on every request');
    assert.equal((await request(api, { headers: { cookie } })).status, 403);
    assert.equal((await db.data()).channelOptions[TRIGGER_ID].userLimit, 1);

    administrator = true;
    assert.equal((await patch({ origin, 'x-csrf-token': me.csrf })).status, 200);
    assert.equal((await db.data()).channelOptions[TRIGGER_ID].userLimit, 6);
});
