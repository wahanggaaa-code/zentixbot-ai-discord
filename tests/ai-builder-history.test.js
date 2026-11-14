// Server Builder: applying a plan, the record of what was created, and taking the newest build down again.
// Discord is a small in-memory server here; the PostgreSQL side of the history is exercised by
// tests/postgres-dashboard-live-walk.test.js, which reads it through the real router.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createBuilder } from '../src/services/ai/builder.js';
import { MAX_BUILDS, createBuilderHistory, createMemoryBuilderHistory, sanitizeBuilds } from '../src/services/ai/builderHistory.js';
import { createAIApi } from '../src/dashboard/aiApi.js';

const GUILD = '123456789012345678', OWNER = '234567890123456789', OTHER = '345678901234567890';
const PLAN = {
    categories: [
        { name: '📌 INFO', channels: [{ name: 'pengumuman', type: 'text', topic: 'Kabar.' }, { name: 'aturan', type: 'text' }] },
        { name: '🔊 SUARA', channels: [{ name: 'Ruang Santai', type: 'voice' }] },
    ],
    roles: [{ name: '👥 Member', color: '#3498DB' }, { name: 'Tamu' }],
};

/** An in-memory Discord server: channels and roles can be created, fetched and deleted, and made to fail. */
function world({ features = [] } = {}) {
    let seq = 0, clock = 1_700_000_000_000;
    const channels = new Map(), roles = new Map(), deleted = [], denied = new Set();
    const state = { failCreateAt: null, fetchFails: false, creates: 0 };
    const guild = {
        id: GUILD, features, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null, afkChannelId: null, widgetChannelId: null, safetyAlertsChannelId: null,
        members: { me: { permissions: { has: (permission) => !denied.has(permission) } } },
        channels: {
            cache: channels,
            fetch: async () => { if (state.fetchFails) throw new Error('discord down'); return new Map(channels); },
            create: async (options) => {
                if (state.failCreateAt === state.creates) throw new Error('Discord error');
                state.creates++;
                const id = String(600000000000000000n + BigInt(++seq));
                const channel = {
                    id, name: options.name, type: options.type, parentId: options.parent ?? null, topic: options.topic ?? null, lastMessageId: null, failDelete: null,
                    delete: async (reason) => { if (channel.failDelete) throw channel.failDelete; channels.delete(id); deleted.push({ id, name: channel.name, reason }); },
                };
                channels.set(id, channel);
                return channel;
            },
        },
        roles: {
            cache: roles,
            fetch: async () => { if (state.fetchFails) throw new Error('discord down'); return new Map(roles); },
            create: async (options) => {
                if (state.failCreateAt === state.creates) throw new Error('Discord error');
                state.creates++;
                const id = String(700000000000000000n + BigInt(++seq));
                const role = {
                    id, name: options.name, editable: true, managed: false, permissions: { bitfield: options.permissions }, options, failDelete: null,
                    delete: async (reason) => { if (role.failDelete) throw role.failDelete; roles.delete(id); deleted.push({ id, name: role.name, reason }); },
                };
                roles.set(id, role);
                return role;
            },
        },
    };
    const client = { homeGuildId: GUILD, guilds: { cache: new Map([[GUILD, guild]]) } };
    const history = createMemoryBuilderHistory();
    const foundation = { generate: async () => ({ text: JSON.stringify(PLAN) }) };
    const builder = createBuilder({ client, foundation, history, now: () => clock });
    const byName = (name) => [...channels.values(), ...roles.values()].find((entry) => entry.name === name);
    /** Drafts PLAN (or the given plan) for `userId` and applies it. */
    async function build(plan = PLAN, userId = OWNER) {
        const draft = await builder.draftFromTheme({ guildId: GUILD, userId, themeId: 'komunitas' });
        await builder.edit({ guildId: GUILD, userId, id: draft.id, plan });
        clock += 1000;
        return builder.apply({ guild, userId, id: draft.id, confirmed: true });
    }
    return { guild, client, history, builder, channels, roles, deleted, denied, state, byName, build, tick: (ms) => { clock += ms; }, now: () => clock };
}
const names = (items) => items.map((item) => item.name);
const numbered = (prefix) => ({ categories: [{ name: `${prefix} Kategori`, channels: [{ name: `${prefix.toLowerCase()}-teks`, type: 'text' }] }], roles: [{ name: `${prefix} Role` }] });

test('stored history: malformed entries are dropped, the newest 20 builds are kept', () => {
    const item = { type: 'text', id: '600000000000000001', name: 'umum' };
    const good = { id: 'abcdef0123456789', at: 1_700_000_000_000, actorId: OWNER, label: 'Gaming', source: 'theme', items: [item] };
    assert.deepEqual(sanitizeBuilds([good]), [{ ...good, edited: false, partial: false }]);
    assert.deepEqual(sanitizeBuilds([{ ...good, edited: true, partial: true, extra: 'x', items: [{ ...item, secret: 1 }] }]), [{ ...good, edited: true, partial: true }]);
    for (const value of [null, undefined, 'x', 5, {}, { 0: good }]) assert.deepEqual(sanitizeBuilds(value), []);
    const broken = [
        null, 'x', {}, { ...good, id: 'ZZZ' }, { ...good, id: 5 }, { ...good, at: '2026' }, { ...good, at: -1 }, { ...good, actorId: 'me' }, { ...good, label: 5 }, { ...good, label: 'x'.repeat(81) },
        { ...good, source: 'magic' }, { ...good, items: [] }, { ...good, items: 'x' }, { ...good, items: [{ ...item, type: 'guild' }] }, { ...good, items: [{ ...item, id: '12' }] },
        { ...good, items: [{ ...item, name: '' }] }, { ...good, items: [{ ...item, name: 'x'.repeat(101) }] }, { ...good, items: [item, null] }, { ...good, items: Array(101).fill(item) },
    ];
    assert.deepEqual(sanitizeBuilds([...broken, good]), [{ ...good, edited: false, partial: false }]);
    const many = Array.from({ length: 25 }, (_, i) => ({ ...good, id: `${'0'.repeat(14)}${String(i).padStart(2, '0')}` }));
    assert.equal(MAX_BUILDS, 20);
    assert.deepEqual(sanitizeBuilds(many).map((build) => build.id.slice(-2)), many.slice(5).map((build) => build.id.slice(-2)));
});

test('stored history: SQLite and PostgreSQL share one key per server; no database means 503', async () => {
    const item = { type: 'role', id: '700000000000000001', name: 'Member' };
    const build = { id: 'abcdef0123456789', at: 1_700_000_000_000, actorId: OWNER, label: 'Gaming', source: 'ai', edited: false, partial: false, items: [item] };
    const key = `ai:builder:history:${GUILD}`;

    const rows = new Map();
    const sqlite = { dialect: 'sqlite', get: (k) => rows.get(k) ?? null, set: (k, v) => rows.set(k, v) };
    const viaSqlite = createBuilderHistory({ db: { isAvailable: () => true, getStatus: () => ({ isDegraded: false }), db: { isAvailable: () => true, sqlite } } });
    assert.deepEqual(await viaSqlite.read(GUILD), []);
    assert.equal(rows.size, 0, 'reading does not write');
    assert.deepEqual(await viaSqlite.save(GUILD, [build, { junk: true }]), [build]);
    assert.deepEqual([...rows.keys()], [key]);
    assert.deepEqual(await viaSqlite.read(GUILD), [build]);
    rows.set(key, 'rusak');
    assert.deepEqual(await viaSqlite.read(GUILD), []);

    const queries = [], table = new Map();
    const pool = { query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.startsWith('SELECT')) return { rows: table.has(params[0]) ? [{ value: table.get(params[0]) }] : [] };
        table.set(params[0], JSON.parse(params[1]));
        return { rows: [] };
    } };
    const viaPostgres = createBuilderHistory({ db: { isAvailable: () => true, getStatus: () => ({ isDegraded: false }), db: { isAvailable: () => true, pool } } });
    assert.deepEqual(await viaPostgres.read(GUILD), []);
    assert.deepEqual(await viaPostgres.save(GUILD, [build]), [build]);
    assert.deepEqual(await viaPostgres.read(GUILD), [build]);
    assert.deepEqual(queries.map((query) => query.params[0]), [key, key, key]);
    assert.match(queries[1].sql, /^INSERT INTO cache_data \(key,value,expires_at\) VALUES \(\$1,\$2::jsonb,NULL\) ON CONFLICT \(key\) DO UPDATE SET value=EXCLUDED\.value, expires_at=NULL$/);
    assert.match(queries[0].sql, /^SELECT value FROM cache_data WHERE key=\$1$/);

    for (const client of [{}, { db: null }, { db: { isAvailable: () => false, getStatus: () => ({ isDegraded: false }), db: { isAvailable: () => true, pool } } },
        { db: { isAvailable: () => true, getStatus: () => ({ isDegraded: true }), db: { isAvailable: () => true, pool } } }]) {
        await assert.rejects(createBuilderHistory(client).read(GUILD), { status: 503 });
        await assert.rejects(createBuilderHistory(client).save(GUILD, [build]), { status: 503 });
    }
});

test('applying records every created object with its Discord ID', async () => {
    const w = world();
    const result = await w.build();
    assert.deepEqual(names(result.created), ['📌 INFO', 'pengumuman', 'aturan', '🔊 SUARA', 'Ruang Santai', '👥 Member', 'Tamu']);
    assert.deepEqual(result.created.map((item) => item.type), ['category', 'text', 'text', 'category', 'voice', 'role', 'role']);
    assert.deepEqual(result.counts, { categories: 2, channels: 3, roles: 2 });
    assert.equal(result.recorded, true);
    assert.match(result.buildId, /^[0-9a-f]{16}$/);
    for (const item of result.created) assert.equal(w.byName(item.name).id, item.id);
    assert.equal(w.byName('pengumuman').parentId, w.byName('📌 INFO').id);
    assert.equal(w.byName('pengumuman').topic, 'Kabar.');
    assert.equal(w.byName('Ruang Santai').type, ChannelType.GuildVoice);
    assert.deepEqual(w.byName('👥 Member').options.colors, { primaryColor: '#3498DB' });
    assert.equal(w.byName('Tamu').options.colors, undefined);
    for (const role of w.roles.values()) assert.deepEqual([role.options.permissions, role.options.mentionable, role.options.hoist], [0n, false, false]);

    const { builds } = await w.builder.history({ guildId: GUILD });
    assert.equal(builds.length, 1);
    assert.deepEqual(builds[0], {
        id: result.buildId, at: w.now(), actorId: OWNER, label: 'Komunitas', source: 'theme', edited: true, partial: false,
        items: result.created, counts: { categories: 2, channels: 3, roles: 2 },
    });
    await assert.rejects(w.builder.history({ guildId: '999999999999999999' }), { status: 403 });
});

test('the label and source of a build say where the plan came from', async () => {
    const w = world();
    const theme = await w.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'musik' });
    await w.builder.apply({ guild: w.guild, userId: OWNER, id: theme.id, confirmed: true });
    w.builder = createBuilder({ client: w.client, history: w.history, foundation: { generate: async () => ({ text: JSON.stringify(numbered('Z')) }) } });
    const ai = await w.builder.draft({ guildId: GUILD, userId: OWNER, description: `  server   untuk\n ${'sangat '.repeat(20)}ramai  `, consent: true });
    await w.builder.apply({ guild: w.guild, userId: OWNER, id: ai.id, confirmed: true });
    const { builds } = await w.builder.history({ guildId: GUILD });
    assert.deepEqual(builds.map((build) => [build.source, build.edited]), [['ai', false], ['theme', false]]);
    assert.equal(builds[1].label, 'Musik');
    assert.equal(builds[0].label.length, 60);
    assert.match(builds[0].label, /^server untuk sangat sangat .*…$/);
});

test('a build that stops half-way is recorded too, so what it left behind can be taken down', async () => {
    const w = world();
    w.state.failCreateAt = 4; // after the first category with two channels and the second category
    const draft = await w.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'komunitas' });
    await w.builder.edit({ guildId: GUILD, userId: OWNER, id: draft.id, plan: PLAN });
    let failure;
    await assert.rejects(w.builder.apply({ guild: w.guild, userId: OWNER, id: draft.id, confirmed: true }), (error) => { failure = error; return true; });
    assert.equal(failure.status, 409);
    assert.match(failure.message, /berhenti di tengah jalan.*tercatat di riwayat/);
    assert.deepEqual(names(failure.created), ['📌 INFO', 'pengumuman', 'aturan', '🔊 SUARA']);
    assert.equal(failure.recorded, true);
    const { builds } = await w.builder.history({ guildId: GUILD });
    assert.equal(builds.length, 1);
    assert.equal(builds[0].id, failure.buildId);
    assert.equal(builds[0].partial, true);
    assert.deepEqual(builds[0].items, failure.created);
    // The plan is spent: nothing is created a second time.
    await assert.rejects(w.builder.apply({ guild: w.guild, userId: OWNER, id: draft.id, confirmed: true }), { status: 404 });
    assert.equal(w.channels.size, 4);

    w.state.failCreateAt = null;
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.equal(review.build.partial, true);
    assert.equal(review.confirmation, 'BONGKAR 4');
    await w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 4' });
    assert.equal(w.channels.size, 0);

    // Nothing created at all: nothing to record.
    const nothing = world();
    nothing.state.failCreateAt = 0;
    const second = await nothing.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'komunitas' });
    await assert.rejects(nothing.builder.apply({ guild: nothing.guild, userId: OWNER, id: second.id, confirmed: true }), (error) => error.status === 409 && error.created.length === 0 && error.buildId === null && /sebelum ada yang dibuat/.test(error.message));
    assert.deepEqual((await nothing.builder.history({ guildId: GUILD })).builds, []);
});

test('no build without a readable history; a history that cannot be saved is reported, not hidden', async () => {
    const w = world();
    const draft = await w.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'komunitas' });
    const read = w.history.read;
    w.history.read = async () => { throw new Error('db down'); };
    await assert.rejects(w.builder.apply({ guild: w.guild, userId: OWNER, id: draft.id, confirmed: true }), { status: 503 });
    assert.equal(w.channels.size + w.roles.size, 0);
    await assert.rejects(w.builder.history({ guildId: GUILD }));
    await assert.rejects(w.builder.prepareUndo({ guild: w.guild, userId: OWNER }));
    w.history.read = read;
    // The plan was not spent by the refusal.
    w.history.save = async () => { throw new Error('db down'); };
    const result = await w.builder.apply({ guild: w.guild, userId: OWNER, id: draft.id, confirmed: true });
    assert.equal(result.recorded, false);
    // Saved without an error, but the store did not keep this build: that is not "recorded" either.
    w.history.save = async () => [];
    const other = await w.build(numbered('Q'));
    assert.equal(other.recorded, false);
    assert.equal(result.created.length, 14);
    assert.equal(w.channels.size + w.roles.size, 14 + 3);
});

test('forum, announcement and stage channels need a Community server', async () => {
    const plan = { categories: [{ name: 'Komunitas', channels: [{ name: 'tanya', type: 'forum', topic: 'Satu topik.' }, { name: 'kabar', type: 'news' }, { name: 'Panggung', type: 'stage' }, { name: 'umum', type: 'text' }] }], roles: [] };
    const plain = world();
    await assert.rejects(plain.build(plan), (error) => error.status === 409 && /fitur Komunitas/.test(error.message) && /3 channel/.test(error.message));
    assert.equal(plain.channels.size, 0);
    assert.deepEqual((await plain.builder.history({ guildId: GUILD })).builds, []);
    // The refusal does not spend the plan: it can be edited to text and voice and applied.
    const waiting = plain.builder.pending({ guildId: GUILD, userId: OWNER });
    await plain.builder.edit({ guildId: GUILD, userId: OWNER, id: waiting.id, plan: { ...plan, categories: [{ name: 'Komunitas', channels: plan.categories[0].channels.map((channel) => ({ name: channel.name, type: channel.type === 'stage' ? 'voice' : 'text' })) }] } });
    assert.equal((await plain.builder.apply({ guild: plain.guild, userId: OWNER, id: waiting.id, confirmed: true })).created.length, 5);

    const community = world({ features: ['COMMUNITY'] });
    const result = await community.build(plan);
    assert.deepEqual(result.created.map((item) => item.type), ['category', 'forum', 'news', 'stage', 'text']);
    assert.deepEqual(['tanya', 'kabar', 'Panggung', 'umum'].map((name) => community.byName(name).type), [ChannelType.GuildForum, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildText]);
    assert.equal(community.byName('tanya').topic, 'Satu topik.');
});

test('bongkar: review first, then the typed sentence; exactly the recorded IDs are deleted, channels before categories before roles', async () => {
    const w = world();
    // Things that were on the server before, one of them with the same name as a channel of the second build.
    const general = await w.guild.channels.create({ name: 'general', type: ChannelType.GuildText });
    const staff = await w.guild.roles.create({ name: 'Staff', permissions: 8n });
    const first = await w.build(numbered('A'));
    const second = await w.build();
    const before = w.channels.size + w.roles.size;

    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.equal(w.channels.size + w.roles.size, before, 'reviewing changes nothing');
    assert.equal(review.build.id, second.buildId);
    assert.deepEqual(review.counts, { delete: 7, gone: 0, blocked: 0 });
    assert.equal(review.confirmation, 'BONGKAR 7');
    assert.equal(review.expiresInSeconds, 300);
    assert.match(review.warning, /PENGHAPUSAN PERMANEN/);
    assert.deepEqual(review.items.map((item) => [item.name, item.state, item.notes]), second.created.map((item) => [item.name, 'delete', []]));

    for (const confirmation of ['BONGKAR', 'bongkar 7', 'BONGKAR 8', 'BONGKAR 7 ', '', undefined, 7, second.buildId]) {
        await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation }), { status: 400 });
    }
    assert.equal(w.deleted.length, 0);

    const result = await w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' });
    assert.deepEqual(names(w.deleted), ['pengumuman', 'aturan', 'Ruang Santai', '📌 INFO', '🔊 SUARA', '👥 Member', 'Tamu']);
    assert.deepEqual(new Set(w.deleted.map((entry) => entry.id)), new Set(second.created.map((item) => item.id)));
    assert.ok(w.deleted.every((entry) => entry.reason === `AI builder: owner confirmed removal of build ${second.buildId}`));
    assert.deepEqual(result, { buildId: second.buildId, removed: result.removed, kept: [], counts: { categories: 2, channels: 3, roles: 2 }, done: true, recorded: true, remainingBuilds: 1 });
    assert.deepEqual(names(result.removed), names(w.deleted));
    // Everything else is still there.
    assert.ok(w.channels.has(general.id) && w.roles.has(staff.id));
    for (const item of first.created) assert.ok(w.byName(item.name), item.name);

    // The build before it is now the newest and can be taken down the same way.
    const { builds } = await w.builder.history({ guildId: GUILD });
    assert.deepEqual(builds.map((build) => build.id), [first.buildId]);
    const next = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.equal(next.build.id, first.buildId);
    assert.equal(next.confirmation, 'BONGKAR 3');
    await w.builder.undo({ guild: w.guild, userId: OWNER, id: next.id, confirmation: 'BONGKAR 3' });
    assert.deepEqual((await w.builder.history({ guildId: GUILD })).builds, []);
    assert.deepEqual([...w.channels.keys(), ...w.roles.keys()], [general.id, staff.id]);
    await assert.rejects(w.builder.prepareUndo({ guild: w.guild, userId: OWNER }), { status: 404 });
});

test('bongkar deletes by ID: a renamed object is still removed, a namesake that the builder did not create is not', async () => {
    const w = world();
    const build = await w.build();
    w.byName('aturan').name = 'peraturan-baru';
    w.byName('Tamu').name = '**Tamu** <@&1>';
    const namesake = await w.guild.channels.create({ name: 'aturan', type: ChannelType.GuildText });
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.deepEqual(review.items.find((item) => item.name === 'aturan').notes, ['sekarang bernama "peraturan-baru"']);
    assert.deepEqual(review.items.find((item) => item.name === 'Tamu').notes, ['sekarang bernama "**Tamu** <@&1>"']);
    assert.equal(review.confirmation, 'BONGKAR 7');
    await w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' });
    assert.deepEqual([...w.channels.keys()], [namesake.id]);
    assert.equal(w.roles.size, 0);
    assert.equal(w.deleted.length, build.created.length);
});

test('the review says what would be lost', async () => {
    const w = world();
    await w.build();
    w.byName('pengumuman').lastMessageId = '800000000000000001';
    w.byName('Ruang Santai').members = { size: 3 };
    w.byName('aturan').members = { size: 40 }; // everyone who can see a text channel; not "inside" it
    w.byName('👥 Member').permissions = { bitfield: 1024n };
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    const notes = Object.fromEntries(review.items.map((item) => [item.name, item.notes]));
    assert.deepEqual(notes, {
        '📌 INFO': [], pengumuman: ['sudah berisi pesan'], aturan: [], '🔊 SUARA': [], 'Ruang Santai': ['3 orang sedang di dalam'], '👥 Member': ['izinnya sudah diubah'], Tamu: [],
    });
    assert.ok(review.items.every((item) => item.state === 'delete'));
});

test('a review belongs to one person, lasts five minutes, works once, and is void when anything changed', async () => {
    const w = world();
    await w.build();
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OTHER, id: review.id, confirmation: 'BONGKAR 7' }), { status: 404 });
    await assert.rejects(w.builder.undo({ guild: { ...w.guild, id: '999999999999999999' }, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' }), { status: 404 });
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: 'tidak-ada', confirmation: 'BONGKAR 7' }), { status: 404 });
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: undefined, confirmation: 'BONGKAR 7' }), { status: 404 });
    await assert.rejects(w.builder.prepareUndo({ guild: { ...w.guild, id: '999999999999999999' }, userId: OWNER }), { status: 403 });

    // Someone deletes a channel by hand after the review: the count no longer matches.
    w.channels.delete(w.byName('aturan').id);
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' }), (error) => error.status === 409 && /Keadaan server berubah/.test(error.message));
    assert.equal(w.deleted.length, 0);
    const again = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.deepEqual(again.counts, { delete: 6, gone: 1, blocked: 0 });
    assert.deepEqual(again.items.find((item) => item.name === 'aturan'), { ...again.items.find((item) => item.name === 'aturan'), state: 'gone', notes: ['sudah tidak ada'] });
    // A new review replaces the earlier one of the same person.
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' }), { status: 404 });

    // A newer build makes the reviewed one no longer the newest.
    await w.build(numbered('B'));
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: again.id, confirmation: 'BONGKAR 6' }), (error) => error.status === 409 && /Riwayat berubah/.test(error.message));
    assert.equal(w.deleted.length, 0);

    const third = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    w.tick(300_000);
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: third.id, confirmation: third.confirmation }), { status: 404 });
    const fourth = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    w.tick(299_999);
    await w.builder.undo({ guild: w.guild, userId: OWNER, id: fourth.id, confirmation: fourth.confirmation });
    assert.equal(w.deleted.length, 3);
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: fourth.id, confirmation: fourth.confirmation }), { status: 404 });
});

test('what must not be deleted stays, and stays recorded for another try', async () => {
    const w = world();
    const build = await w.build();
    const info = w.byName('📌 INFO'), voiceCategory = w.byName('🔊 SUARA');
    w.guild.rulesChannelId = w.byName('aturan').id;                         // became the server's rules channel
    const foreign = await w.guild.channels.create({ name: 'tamu-lain', type: ChannelType.GuildText, parent: voiceCategory.id }); // someone put a channel in
    w.byName('👥 Member').editable = false;                                  // moved above the bot's role
    w.byName('Tamu').managed = true;

    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.deepEqual(review.counts, { delete: 3, gone: 0, blocked: 4 });
    assert.equal(review.confirmation, 'BONGKAR 3');
    const state = Object.fromEntries(review.items.map((item) => [item.name, [item.state, item.notes.at(-1) ?? null]]));
    assert.deepEqual(state, {
        '📌 INFO': ['delete', null],
        pengumuman: ['delete', null],
        aturan: ['blocked', 'tidak dihapus: dipakai sebagai channel sistem server'],
        '🔊 SUARA': ['blocked', 'tidak dihapus: masih berisi 1 channel yang bukan bagian bangunan ini'],
        'Ruang Santai': ['delete', null],
        '👥 Member': ['blocked', 'tidak dapat dihapus bot: role berada di atas role bot atau dikelola integrasi'],
        Tamu: ['blocked', 'tidak dapat dihapus bot: role berada di atas role bot atau dikelola integrasi'],
    });

    const result = await w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 3' });
    // "📌 INFO" still holds the rules channel, so it is kept as well: deleting it would only move that channel out.
    assert.deepEqual(names(w.deleted), ['pengumuman', 'Ruang Santai']);
    assert.deepEqual(names(result.removed), ['pengumuman', 'Ruang Santai']);
    assert.deepEqual(result.kept.map((item) => [item.name, item.reason]), [
        ['aturan', 'tidak dihapus: dipakai sebagai channel sistem server'],
        ['📌 INFO', 'masih berisi 1 channel yang tidak terhapus'],
        ['🔊 SUARA', 'tidak dihapus: masih berisi 1 channel yang bukan bagian bangunan ini'],
        ['👥 Member', 'tidak dapat dihapus bot: role berada di atas role bot atau dikelola integrasi'],
        ['Tamu', 'tidak dapat dihapus bot: role berada di atas role bot atau dikelola integrasi'],
    ]);
    assert.equal(result.done, false);
    assert.equal(result.remainingBuilds, 1);
    assert.ok(w.channels.has(foreign.id) && w.channels.has(info.id));

    // The record now holds exactly what is left.
    const { builds } = await w.builder.history({ guildId: GUILD });
    assert.equal(builds[0].id, build.buildId);
    assert.deepEqual(names(builds[0].items), ['aturan', '📌 INFO', '🔊 SUARA', '👥 Member', 'Tamu']);
    assert.deepEqual(builds[0].items.map((item) => Object.keys(item)), Array(5).fill(['type', 'id', 'name']));

    // Once the causes are dealt with, a second run finishes the job and closes the record.
    w.guild.rulesChannelId = null;
    foreign.parentId = null;
    w.byName('👥 Member').editable = true;
    w.byName('Tamu').managed = false;
    const second = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.equal(second.confirmation, 'BONGKAR 5');
    const done = await w.builder.undo({ guild: w.guild, userId: OWNER, id: second.id, confirmation: 'BONGKAR 5' });
    assert.equal(done.done, true);
    assert.deepEqual([...w.channels.keys()], [foreign.id]);
    assert.equal(w.roles.size, 0);
    assert.deepEqual((await w.builder.history({ guildId: GUILD })).builds, []);
});

test('Discord errors while deleting: "already gone" counts as removed, anything else keeps the object recorded', async () => {
    const w = world();
    await w.build();
    w.byName('pengumuman').failDelete = Object.assign(new Error('Unknown Channel'), { code: 10003 });
    w.byName('Tamu').failDelete = Object.assign(new Error('Unknown Role'), { code: 10011 });
    w.byName('Ruang Santai').failDelete = Object.assign(new Error('Missing Permissions'), { code: 50013 });
    w.byName('👥 Member').failDelete = new Error('socket hang up');
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    const result = await w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' });
    assert.deepEqual(names(result.removed), ['pengumuman', 'aturan', '📌 INFO', 'Tamu']);
    assert.deepEqual(result.kept.map((item) => [item.name, item.reason]), [
        ['Ruang Santai', 'Discord menolak atau tidak menjawab'],
        ['🔊 SUARA', 'masih berisi 1 channel yang tidak terhapus'],
        ['👥 Member', 'Discord menolak atau tidak menjawab'],
    ]);
    assert.deepEqual(result.counts, { categories: 1, channels: 2, roles: 1 });
    assert.deepEqual(names((await w.builder.history({ guildId: GUILD })).builds[0].items), ['Ruang Santai', '🔊 SUARA', '👥 Member']);
    // The review was spent although part of it failed; the next run needs a fresh review.
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' }), { status: 404 });
});

test('bongkar needs the bot permissions for what it deletes and a readable server, and never runs beside another build', async () => {
    const w = world();
    await w.build();
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    for (const permission of [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]) {
        w.denied.add(permission);
        await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' }), { status: 403 });
        w.denied.delete(permission);
    }
    w.state.fetchFails = true;
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' }), { status: 503 });
    await assert.rejects(w.builder.prepareUndo({ guild: w.guild, userId: OTHER }), { status: 503 });
    w.state.fetchFails = false;
    assert.equal(w.deleted.length, 0);

    // While the first channel is being deleted, a second undo, an apply and a forget are all refused.
    let release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const slow = w.byName('pengumuman');
    slow.delete = async () => { entered(); await new Promise((resolve) => { release = resolve; }); w.channels.delete(slow.id); };
    const waiting = await w.builder.draftFromTheme({ guildId: GUILD, userId: OTHER, themeId: 'musik' });
    const running = w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 7' });
    await started;
    await assert.rejects(w.builder.apply({ guild: w.guild, userId: OTHER, id: waiting.id, confirmed: true }), { status: 409 });
    await assert.rejects(w.builder.forget({ guild: w.guild, userId: OWNER, buildId: review.build.id, confirmed: true }), { status: 409 });
    release();
    assert.equal((await running).done, true);
    // The refused apply did not spend the other person's plan.
    assert.equal((await w.builder.apply({ guild: w.guild, userId: OTHER, id: waiting.id, confirmed: true })).recorded, true);

    // Only roles left to delete: Manage Channels is not needed.
    const rolesOnly = world();
    await rolesOnly.build();
    for (const channel of [...rolesOnly.channels.values()]) rolesOnly.channels.delete(channel.id);
    rolesOnly.denied.add(PermissionFlagsBits.ManageChannels);
    const second = await rolesOnly.builder.prepareUndo({ guild: rolesOnly.guild, userId: OWNER });
    assert.equal(second.confirmation, 'BONGKAR 2');
    assert.equal((await rolesOnly.builder.undo({ guild: rolesOnly.guild, userId: OWNER, id: second.id, confirmation: 'BONGKAR 2' })).done, true);
});

test('a build whose objects are all gone is closed with BONGKAR 0', async () => {
    const w = world();
    await w.build();
    w.channels.clear();
    w.roles.clear();
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    assert.deepEqual(review.counts, { delete: 0, gone: 7, blocked: 0 });
    assert.equal(review.confirmation, 'BONGKAR 0');
    const result = await w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: 'BONGKAR 0' });
    assert.deepEqual([result.removed, result.kept, result.done, result.remainingBuilds], [[], [], true, 0]);
});

test('lepas dari riwayat: drops the newest record only, deletes nothing', async () => {
    const w = world();
    const first = await w.build(numbered('A'));
    const second = await w.build();
    const objects = w.channels.size + w.roles.size;
    const review = await w.builder.prepareUndo({ guild: w.guild, userId: OWNER });
    await assert.rejects(w.builder.forget({ guild: w.guild, userId: OWNER, buildId: first.buildId, confirmed: true }), { status: 409 });
    for (const confirmed of [false, undefined, 'true']) await assert.rejects(w.builder.forget({ guild: w.guild, userId: OWNER, buildId: second.buildId, confirmed }), { status: 400 });
    await assert.rejects(w.builder.forget({ guild: { ...w.guild, id: '999999999999999999' }, userId: OWNER, buildId: second.buildId, confirmed: true }), { status: 403 });
    assert.deepEqual(await w.builder.forget({ guild: w.guild, userId: OWNER, buildId: second.buildId, confirmed: true }), { forgotten: true, remainingBuilds: 1 });
    assert.equal(w.channels.size + w.roles.size, objects);
    assert.equal(w.deleted.length, 0);
    assert.deepEqual((await w.builder.history({ guildId: GUILD })).builds.map((build) => build.id), [first.buildId]);
    // A review of the forgotten build can no longer delete anything.
    await assert.rejects(w.builder.undo({ guild: w.guild, userId: OWNER, id: review.id, confirmation: review.confirmation }), { status: 404 });
    await assert.rejects(w.builder.forget({ guild: w.guild, userId: OWNER, buildId: second.buildId, confirmed: true }), { status: 409 });
});

test('the history keeps the newest 20 builds', async () => {
    const w = world();
    const ids = [];
    for (let i = 0; i < 22; i++) ids.push((await w.build(numbered(`N${i}`))).buildId);
    const { builds } = await w.builder.history({ guildId: GUILD });
    assert.equal(builds.length, 20);
    assert.deepEqual(builds.map((build) => build.id), ids.slice(2).reverse());
});

test('HTTP: every builder route is for the bot owner, writes need CSRF, and bodies have an exact shape', async (t) => {
    const w = world();
    const auth = (req, res, next) => { req.guild = w.guild; req.session = { user: { id: req.get('who') } }; next(); };
    const csrf = (req, res, next) => (req.get('csrf') === 'yes' ? next() : res.sendStatus(403));
    const app = express();
    app.use('/ai', createAIApi(w.client, { auth, csrf, env: { OWNER_IDS: OWNER }, foundation: {}, builder: w.builder }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/ai/builder`;
    const get = (path, who = OWNER) => fetch(url + path, { headers: { who } });
    const post = (path, body, { who = OWNER, token = 'yes' } = {}) => fetch(url + path, { method: 'POST', headers: { who, csrf: token, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    for (const path of ['/themes', '/pending', '/history']) assert.equal((await get(path, OTHER)).status, 403, path);
    const writes = [['/theme', { themeId: 'musik' }], ['/cancel', { id: 'x' }], ['/undo/prepare', { confirmed: true }], ['/undo/apply', { id: 'x', confirmation: 'BONGKAR 1' }], ['/undo/forget', { buildId: 'x', confirmed: true }]];
    for (const [path, body] of writes) {
        assert.equal((await post(path, body, { who: OTHER })).status, 403, `${path} as someone else`);
        assert.equal((await post(path, body, { token: 'no' })).status, 403, `${path} without CSRF`);
        assert.equal((await post(path, { ...body, extra: 1 })).status, 400, `${path} with an extra key`);
        assert.equal((await post(path, {})).status, 400, `${path} with an empty body`);
    }
    assert.equal((await post('/theme', { themeId: 5 })).status, 400);
    assert.equal((await post('/theme', { themeId: 'tidak-ada' })).status, 404);
    assert.equal((await post('/undo/prepare', { confirmed: false })).status, 400);
    assert.equal((await post('/undo/forget', { buildId: 'x', confirmed: false })).status, 400);
    assert.equal(w.channels.size + w.roles.size, 0);

    const themes = await (await get('/themes')).json();
    assert.equal(themes.themes.length, 15);
    assert.deepEqual(themes.themes[0], { id: 'gaming', label: 'Gaming', emoji: '🎮', categories: 3, channels: 9, roles: 3 });
    assert.deepEqual(themes.limits, { categories: 8, channelsPerCategory: 15, channels: 40, roles: 12, nameLength: 50, topicLength: 200 });
    assert.deepEqual(themes.channelTypes, ['text', 'voice', 'forum', 'news', 'stage']);
    assert.deepEqual(await (await get('/pending')).json(), { pending: null });
    assert.deepEqual(await (await get('/history')).json(), { builds: [] });
    assert.equal((await post('/undo/prepare', { confirmed: true })).status, 404);

    // The whole way through: theme → waiting plan → cancel → theme → apply → history → review → bongkar.
    const first = await (await post('/theme', { themeId: 'musik' })).json();
    assert.equal(first.ok, true);
    assert.equal((await (await get('/pending')).json()).pending.id, first.id);
    assert.deepEqual(await (await post('/cancel', { id: first.id })).json(), { ok: true, cancelled: true });
    assert.equal((await post('/cancel', { id: first.id })).status, 404);
    assert.deepEqual(await (await get('/pending')).json(), { pending: null });

    const draft = await (await post('/theme', { themeId: 'keluarga' })).json();
    const applied = await (await post('/apply', { id: draft.id, confirmed: true })).json();
    assert.deepEqual([applied.ok, applied.recorded, applied.counts], [true, true, { categories: 2, channels: 7, roles: 2 }]);
    const history = await (await get('/history')).json();
    assert.deepEqual(history.builds.map((build) => [build.id, build.label, build.source, build.counts]), [[applied.buildId, 'Keluarga', 'theme', { categories: 2, channels: 7, roles: 2 }]]);

    const review = await (await post('/undo/prepare', { confirmed: true })).json();
    assert.equal(review.confirmation, 'BONGKAR 11');
    assert.equal((await post('/undo/apply', { id: review.id, confirmation: 'BONGKAR 10' })).status, 400);
    assert.equal(w.deleted.length, 0);
    const undone = await (await post('/undo/apply', { id: review.id, confirmation: 'BONGKAR 11' })).json();
    assert.deepEqual([undone.ok, undone.done, undone.kept, undone.counts], [true, true, [], { categories: 2, channels: 7, roles: 2 }]);
    assert.equal(w.channels.size + w.roles.size, 0);
    assert.deepEqual(await (await get('/history')).json(), { builds: [] });

    // A build that stops half-way answers 409 with what it left behind and where it is recorded.
    const again = await (await post('/theme', { themeId: 'keluarga' })).json();
    w.state.failCreateAt = w.state.creates + 2;
    const stopped = await post('/apply', { id: again.id, confirmed: true });
    assert.equal(stopped.status, 409);
    const body = await stopped.json();
    assert.equal(body.created.length, 2);
    assert.equal(body.recorded, true);
    assert.match(body.buildId, /^[0-9a-f]{16}$/);
    assert.deepEqual(await (await post('/undo/forget', { buildId: body.buildId, confirmed: true })).json(), { ok: true, forgotten: true, remainingBuilds: 0 });
});
