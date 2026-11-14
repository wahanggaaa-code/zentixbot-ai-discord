// Server Builder plans: what a plan may contain, the ready-made themes, and what happens when the AI gives no
// usable plan. Applying, the history and taking a build down are in tests/ai-builder-history.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { CHANNEL_TYPES, PLAN_LIMITS, createBuilder, parsePlanText, planCounts, planSizeFor, validatePlan } from '../src/services/ai/builder.js';
import { createMemoryBuilderHistory } from '../src/services/ai/builderHistory.js';
import { DEFAULT_THEME_ID, THEME_IDS, getTheme, listThemes, pickTheme } from '../src/services/ai/builderThemes.js';

const GUILD = '123456789012345678', OWNER = '234567890123456789', OTHER = '345678901234567890';
const base = () => ({ categories: [{ name: 'Komunitas', channels: [{ name: 'umum', type: 'text' }] }], roles: [] });
const withChannel = (channel) => ({ categories: [{ name: 'Komunitas', channels: [channel] }], roles: [] });
const withRole = (role) => ({ ...base(), roles: [role] });
const rejects = (plan, pattern) => assert.throws(() => validatePlan(plan), (error) => error.status === 400 && pattern.test(error.message), JSON.stringify(plan));

/** A builder whose AI answers with `answer` (a string, or a function that may throw). */
function rig({ answer = JSON.stringify(base()), maxOutputTokens, features = [] } = {}) {
    const prompts = [];
    const guild = { id: GUILD, features };
    const client = { homeGuildId: GUILD, guilds: { cache: new Map([[GUILD, guild]]) } };
    const foundation = {
        store: { read: async () => { if (maxOutputTokens === undefined) throw new Error('no settings'); return { maxOutputTokens }; } },
        generate: async ({ prompt }) => { prompts.push(prompt); return { text: typeof answer === 'function' ? answer() : answer }; },
    };
    let clock = 1_000_000;
    const builder = createBuilder({ client, foundation, now: () => clock, history: createMemoryBuilderHistory() });
    return { builder, prompts, guild, tick: (ms) => { clock += ms; } };
}
const draft = (r, description = 'server untuk ngobrol', userId = OWNER) => r.builder.draft({ guildId: GUILD, userId, description, consent: true });

test('a plan may carry emoji, topics, role colours and five channel types', () => {
    const plan = {
        categories: [
            { name: '  🎮 GAMING & Santai  ', channels: [
                { name: '💬・ngobrol-game', type: 'text', topic: '  Obrolan seputar game.  ' },
                { name: 'Mabar 1', type: 'voice' },
                { name: 'tanya-jawab', type: 'forum', topic: 'Satu pertanyaan per postingan.' },
                { name: 'pengumuman', type: 'news' },
                { name: 'Panggung Utama', type: 'stage' },
            ] },
            { name: 'Kosong', channels: [] },
        ],
        roles: ['Member', { name: '🧑‍🏫 Mentor', color: '#e67e22' }, { name: '1️⃣ Juara', color: null }],
    };
    assert.deepEqual(validatePlan(plan), {
        categories: [
            { name: '🎮 GAMING & Santai', channels: [
                { name: '💬・ngobrol-game', type: 'text', topic: 'Obrolan seputar game.' },
                { name: 'Mabar 1', type: 'voice' },
                { name: 'tanya-jawab', type: 'forum', topic: 'Satu pertanyaan per postingan.' },
                { name: 'pengumuman', type: 'news' },
                { name: 'Panggung Utama', type: 'stage' },
            ] },
            { name: 'Kosong', channels: [] },
        ],
        roles: [{ name: 'Member' }, { name: '🧑‍🏫 Mentor', color: '#E67E22' }, { name: '1️⃣ Juara' }],
    });
    assert.deepEqual(CHANNEL_TYPES, ['text', 'voice', 'forum', 'news', 'stage']);
    assert.deepEqual(planCounts(validatePlan(plan)), { categories: 2, channels: 5, roles: 3 });
    // A clean plan comes back unchanged, so validating twice changes nothing.
    assert.deepEqual(validatePlan(validatePlan(plan)), validatePlan(plan));
    // An empty topic is the same as none.
    assert.deepEqual(validatePlan(withChannel({ name: 'umum', type: 'text', topic: '   ' })).categories[0].channels[0], { name: 'umum', type: 'text' });
});

test('names: text-like channels are lower case without spaces; nothing Discord gives a meaning to gets through', () => {
    for (const name of ['Umum', 'hello world', 'a#b', '@everyone', '<#123>', 'a:b', 'a`b', 'a*b', 'a|b', 'baris\nbaru', '🎮', '---', '', 'x'.repeat(51)]) {
        rejects(withChannel({ name, type: 'text' }), /Channel ke-1 di kategori ke-1/);
    }
    for (const type of ['forum', 'news']) rejects(withChannel({ name: 'Dengan Spasi', type }), /huruf kecil tanpa spasi/);
    for (const name of ['a#b', '@here', '<@&1>', 'a:b', 'a`b', '~~x~~', '**x**', 'a|b', 'baris\nbaru', '🎮🎮', '', 'x'.repeat(51)]) {
        rejects(withChannel({ name, type: 'voice' }), /nama tidak valid/);
        rejects({ categories: [{ name, channels: [{ name: 'umum', type: 'text' }] }], roles: [] }, /Kategori ke-1: nama tidak valid/);
        rejects(withRole({ name }), /Role ke-1: nama tidak valid/);
        rejects(withRole(name), /Role ke-1/);
    }
    for (const name of ['everyone', 'Everyone', 'here', ' HERE ']) rejects(withRole(name), /Role ke-1: nama tidak valid/);
    assert.equal(validatePlan(withChannel({ name: 'x'.repeat(50), type: 'text' })).categories[0].channels[0].name.length, 50);
    assert.equal(validatePlan(withChannel({ name: 'ünïcödé-東京_2', type: 'text' })).categories[0].channels[0].name, 'ünïcödé-東京_2');
    assert.equal(validatePlan(withChannel({ name: "Ruang (A/B), Tim+ & Co. 'Santai'!?", type: 'voice' })).categories[0].channels[0].name, "Ruang (A/B), Tim+ & Co. 'Santai'!?");
});

test('shape: unknown keys, wrong types, bad topics and bad colours are refused with their position', () => {
    rejects(null, /categories/);
    rejects([], /categories/);
    rejects({ ...base(), permissions: 'ADMINISTRATOR' }, /saja/);
    rejects({ categories: [], roles: [] }, /1–8 kategori/);
    rejects({ categories: {}, roles: [] }, /categories/);
    rejects({ categories: [{ name: 'A', channels: [], position: 1 }], roles: [] }, /Kategori ke-1/);
    rejects({ categories: [{ name: 'A', channels: {} }], roles: [] }, /Kategori ke-1/);
    rejects(withChannel({ name: 'umum', type: 'text', permissions: 'ADMINISTRATOR' }), /Channel ke-1 di kategori ke-1/);
    rejects(withChannel({ name: 'umum', type: 'text', id: '1' }), /Channel ke-1/);
    rejects(withChannel({ name: 'umum' }), /Channel ke-1/);
    for (const type of ['category', 'TEXT', 'constructor', 'toString', 0, null]) rejects(withChannel({ name: 'umum', type }), /"type" harus salah satu/);
    rejects(withChannel({ name: 'Suara', type: 'voice', topic: 'x' }), /hanya untuk channel text, forum atau news/);
    rejects(withChannel({ name: 'Panggung', type: 'stage', topic: 'x' }), /hanya untuk channel text/);
    for (const topic of ['x'.repeat(201), 'dua\nbaris', 'halo @everyone', '<#1>', 'kode `x`', 'lihat https://example.com', 5, {}]) rejects(withChannel({ name: 'umum', type: 'text', topic }), /"topic"/);
    assert.equal(validatePlan(withChannel({ name: 'umum', type: 'text', topic: 'x'.repeat(200) })).categories[0].channels[0].topic.length, 200);
    for (const color of ['red', '#fff', '#12345g', '57F287', 5, {}, '#1234567']) rejects(withRole({ name: 'A', color }), /#RRGGBB/);
    rejects(withRole({ name: 'A', permissions: '8' }), /Role ke-1/);
    rejects(withRole({ name: 'A', hoist: true }), /Role ke-1/);
    rejects(withRole(5), /Role ke-1/);
    rejects({ categories: base().categories, roles: {} }, /roles/);
});

test('limits and duplicates', () => {
    const channels = (n, prefix = 'c') => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, type: 'text' }));
    const categories = (sizes) => sizes.map((n, i) => ({ name: `K${i}`, channels: channels(n, `k${i}c`) }));
    assert.deepEqual(PLAN_LIMITS, { categories: 8, channelsPerCategory: 15, channels: 40, roles: 12, nameLength: 50, topicLength: 200 });
    assert.deepEqual(planCounts(validatePlan({ categories: categories([15, 15, 10, 0, 0, 0, 0, 0]), roles: Array.from({ length: 12 }, (_, i) => `R${i}`) })), { categories: 8, channels: 40, roles: 12 });
    rejects({ categories: categories([1, 1, 1, 1, 1, 1, 1, 1, 1]), roles: [] }, /1–8 kategori/);
    rejects({ categories: categories([16]), roles: [] }, /15 channel per kategori/);
    rejects({ categories: categories([15, 15, 11]), roles: [] }, /1–40 channel/);
    rejects({ categories: categories([0, 0]), roles: [] }, /1–40 channel/);
    rejects({ categories: categories([1]), roles: Array.from({ length: 13 }, (_, i) => `R${i}`) }, /12 role/);
    rejects({ categories: [{ name: 'Sama', channels: channels(1) }, { name: 'SAMA', channels: [] }], roles: [] }, /Kategori ke-2: nama kategori dipakai dua kali/);
    // A channel name must be unique across the whole plan, whatever its type or case.
    rejects({ categories: [{ name: 'A', channels: [{ name: 'umum', type: 'text' }] }, { name: 'B', channels: [{ name: 'Umum', type: 'voice' }] }], roles: [] }, /Channel ke-1 di kategori ke-2: nama channel dipakai dua kali/);
    rejects({ ...base(), roles: ['member', { name: 'Member' }] }, /Role ke-2: nama role dipakai dua kali/);
});

test('every theme is a valid plan that needs no Community server, and the list matches the picker', () => {
    const themes = listThemes();
    assert.equal(themes.length, 15);
    assert.deepEqual(themes.map((theme) => theme.id), [...THEME_IDS]);
    assert.deepEqual([...THEME_IDS], ['gaming', 'komunitas', 'aesthetic', 'study', 'musik', 'seni', 'teknologi', 'crypto', 'anime', 'roleplay', 'bisnis', 'coding', 'kesehatan', 'keluarga', 'startup']);
    assert.equal(new Set(themes.map((theme) => theme.label)).size, 15);
    for (const summary of themes) {
        const theme = getTheme(summary.id);
        const plan = validatePlan(theme.plan);
        assert.deepEqual(plan, theme.plan, `${summary.id} is already in its clean form`);
        assert.deepEqual(planCounts(plan), { categories: summary.categories, channels: summary.channels, roles: summary.roles });
        const all = plan.categories.flatMap((category) => category.channels);
        assert.ok(all.every((channel) => ['text', 'voice'].includes(channel.type)), `${summary.id} uses text and voice only`);
        assert.ok(all.some((channel) => channel.type === 'text') && all.some((channel) => channel.type === 'voice'), `${summary.id} has text and voice`);
        assert.ok(plan.categories.length >= 2 && all.length >= 6 && all.length <= 12 && plan.roles.length >= 2, `${summary.id} has a usable size`);
        assert.ok(plan.roles.every((role) => /^#[0-9A-F]{6}$/.test(role.color)), `${summary.id} roles have colours`);
        assert.ok(/\p{Extended_Pictographic}/u.test(summary.emoji) && summary.label.length > 0);
    }
    assert.equal(getTheme('tidak-ada'), null);
    assert.equal(getTheme(undefined), null);
    assert.equal(getTheme('constructor'), null);
    // The copy handed out can be changed without changing the theme.
    getTheme('gaming').plan.categories[0].channels[0].name = 'diubah';
    getTheme('gaming').plan.roles.length = 0;
    assert.equal(getTheme('gaming').plan.categories[0].channels[0].name, 'pengumuman');
    assert.equal(getTheme('gaming').plan.roles.length, 3);
});

test('the closest theme: whole words only, most keywords wins, community when nothing fits', () => {
    assert.equal(DEFAULT_THEME_ID, 'komunitas');
    assert.deepEqual(pickTheme('server buat mabar Valorant sama temen'), { id: 'gaming', hits: 2 });
    assert.equal(pickTheme('tempat belajar bareng buat ujian kuliah').id, 'study');
    assert.equal(pickTheme('komunitas pecinta ANIME dan manga').id, 'anime');
    assert.equal(pickTheme('toko online shop untuk pelanggan').id, 'bisnis');
    assert.equal(pickTheme('ngoding python dan javascript').id, 'coding');
    assert.equal(pickTheme('trading bitcoin').id, 'crypto');
    // "rp" inside "kerja" or "sherpa", "art" inside "kartu", "eth" inside "method" do not count.
    assert.deepEqual(pickTheme('sherpa method kartu'), { id: 'komunitas', hits: 0 });
    assert.equal(pickTheme('rp fantasi').id, 'roleplay');
    assert.deepEqual(pickTheme(''), { id: 'komunitas', hits: 0 });
    assert.deepEqual(pickTheme(undefined), { id: 'komunitas', hits: 0 });
    assert.deepEqual(pickTheme('qwerty zxcv'), { id: 'komunitas', hits: 0 });
    // A tie goes to the theme listed first.
    assert.equal(pickTheme('game anime').id, 'gaming');
    assert.equal(pickTheme('anime game manga').id, 'anime');
    for (const id of THEME_IDS) assert.ok(THEME_IDS.includes(pickTheme(id).id));
});

test('a theme draft costs no AI request and is bound to the person who asked', async () => {
    const r = rig();
    const d = await r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'musik' });
    assert.equal(r.prompts.length, 0);
    assert.equal(d.source, 'theme');
    assert.deepEqual(d.theme, { id: 'musik', label: 'Musik', emoji: '🎵' });
    assert.equal(d.note, null);
    assert.deepEqual(d.plan, getTheme('musik').plan);
    assert.deepEqual(d.counts, { categories: 3, channels: 9, roles: 3 });
    assert.equal(d.expiresInSeconds, 300);
    assert.match(d.id, /^[0-9a-f]{40}$/);
    await assert.rejects(r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'tidak-ada' }), { status: 404 });
    await assert.rejects(r.builder.draftFromTheme({ guildId: '999999999999999999', userId: OWNER, themeId: 'musik' }), { status: 403 });
    assert.equal(r.builder.pending({ guildId: GUILD, userId: OTHER }), null);
    assert.equal(r.builder.pending({ guildId: '999999999999999999', userId: OWNER }), null);
    r.tick(60_000);
    const waiting = r.builder.pending({ guildId: GUILD, userId: OWNER });
    assert.equal(waiting.id, d.id);
    assert.equal(waiting.expiresInSeconds, 240);
    assert.equal(waiting.source, 'theme');
    r.tick(240_000);
    assert.equal(r.builder.pending({ guildId: GUILD, userId: OWNER }), null);
});

test('one waiting plan per person: a new draft replaces the old one, cancelling drops it', async () => {
    const r = rig();
    const first = await r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'musik' });
    const theirs = await r.builder.draftFromTheme({ guildId: GUILD, userId: OTHER, themeId: 'seni' });
    const second = await r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'anime' });
    await assert.rejects(r.builder.edit({ guildId: GUILD, userId: OWNER, id: first.id, plan: base() }), { status: 404 });
    assert.equal(r.builder.pending({ guildId: GUILD, userId: OWNER }).id, second.id);
    assert.equal(r.builder.pending({ guildId: GUILD, userId: OTHER }).id, theirs.id);
    await assert.rejects(r.builder.cancel({ guildId: GUILD, userId: OTHER, id: second.id }), { status: 404 });
    await assert.rejects(r.builder.cancel({ guildId: GUILD, userId: OWNER, id: 'tidak-ada' }), { status: 404 });
    await assert.rejects(r.builder.cancel({ guildId: GUILD, userId: OWNER, id: undefined }), { status: 404 });
    assert.deepEqual(await r.builder.cancel({ guildId: GUILD, userId: OWNER, id: second.id }), { cancelled: true });
    assert.equal(r.builder.pending({ guildId: GUILD, userId: OWNER }), null);
    await assert.rejects(r.builder.cancel({ guildId: GUILD, userId: OWNER, id: second.id }), { status: 404 });
    assert.equal(r.builder.pending({ guildId: GUILD, userId: OTHER }).id, theirs.id);
});

test('at most 50 plans wait at once; a person who already has one may still replace it', async () => {
    const r = rig();
    for (let i = 0; i < 50; i++) await r.builder.draftFromTheme({ guildId: GUILD, userId: String(500000000000000000n + BigInt(i)), themeId: 'musik' });
    await assert.rejects(r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'musik' }), { status: 429 });
    await assert.rejects(draft(r), { status: 429 });
    assert.equal(r.prompts.length, 0, 'no AI request is spent on a plan that could not be kept');
    await r.builder.draftFromTheme({ guildId: GUILD, userId: '500000000000000007', themeId: 'seni' });
    assert.equal((await draft(r, 'server musik', '500000000000000008')).source, 'ai');
    r.tick(300_000);
    assert.equal((await r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'musik' })).source, 'theme');
});

test('an AI plan is taken from the answer, also when it is wrapped in a code block or a sentence', async () => {
    assert.deepEqual(parsePlanText('{"a":1}'), { a: 1 });
    assert.deepEqual(parsePlanText('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
    assert.deepEqual(parsePlanText('Berikut rancangannya:\n{"a":1}\nSemoga membantu.'), { a: 1 });
    assert.throws(() => parsePlanText('tidak ada json'));
    assert.throws(() => parsePlanText('}{'));
    assert.throws(() => parsePlanText('{"a":'));
    assert.throws(() => parsePlanText(undefined));

    const plan = { categories: [{ name: '💬 Obrolan', channels: [{ name: 'ngobrol', type: 'text', topic: 'Santai.' }] }], roles: [{ name: 'Member', color: '#57f287' }] };
    const r = rig({ answer: '```json\n' + JSON.stringify(plan) + '\n```' });
    const d = await draft(r);
    assert.equal(d.source, 'ai');
    assert.equal(d.theme, null);
    assert.equal(d.note, null);
    assert.deepEqual(d.plan, { categories: plan.categories, roles: [{ name: 'Member', color: '#57F287' }] });
});

test('the request is sized to the owner\'s output limit and names only the channel types the server has', async () => {
    assert.deepEqual(planSizeFor(256), { topics: false, channels: 6, categories: 2, roles: 2 });
    assert.deepEqual(planSizeFor(512), { topics: false, channels: 14, categories: 4, roles: 4 });
    assert.deepEqual(planSizeFor(2048), { topics: true, channels: 32, categories: 8, roles: 10 });
    assert.deepEqual(planSizeFor(16), { topics: false, channels: 4, categories: 1, roles: 1 });
    assert.deepEqual(planSizeFor(undefined), planSizeFor(256));
    assert.deepEqual(planSizeFor('2048'), planSizeFor(256));
    for (let tokens = 16; tokens <= 2048; tokens += 8) {
        const size = planSizeFor(tokens);
        assert.ok(size.channels >= 4 && size.channels <= 40 && size.categories >= 1 && size.categories <= 8 && size.roles >= 1 && size.roles <= 12, String(tokens));
    }

    const small = rig({ maxOutputTokens: 256 });
    await draft(small, 'server untuk <b>komunitas</b> kecil');
    assert.equal(small.prompts.length, 1);
    assert.match(small.prompts[0], /Paling banyak 2 kategori, 6 channel seluruhnya dan 2 role/);
    assert.match(small.prompts[0], /"type" hanya text atau voice\./);
    assert.match(small.prompts[0], /Jangan sertakan "topic"/);
    assert.doesNotMatch(small.prompts[0], /"topic":/);
    assert.ok(small.prompts[0].endsWith('Deskripsi:\nserver untuk <b>komunitas</b> kecil'));

    const large = rig({ maxOutputTokens: 2048, features: ['COMMUNITY'] });
    await draft(large, 'x'.repeat(1000));
    assert.match(large.prompts[0], /Paling banyak 8 kategori, 32 channel seluruhnya dan 10 role/);
    assert.match(large.prompts[0], /"type" hanya text, voice, forum, news \(pengumuman\) atau stage\./);
    assert.match(large.prompts[0], /"topic" opsional/);
    assert.ok(large.prompts[0].length <= 4000, `the AI layer takes at most 4000 characters, got ${large.prompts[0].length}`);
    // The example in the prompt is itself a valid plan.
    const example = large.prompts[0].split('\n')[1];
    assert.doesNotThrow(() => validatePlan(JSON.parse(example)));

    // Settings that cannot be read fall back to the smallest size rather than failing the draft.
    const unknown = rig();
    await draft(unknown);
    assert.match(unknown.prompts[0], /Paling banyak 2 kategori, 6 channel/);
});

test('when the AI gives no usable plan, the closest theme is used and the answer says so', async () => {
    const cases = [
        ['cut off', '{"categories":[{"name":"A","channels":[{"name":"umu', /AI tidak menghasilkan rancangan yang valid/],
        ['no JSON', 'Maaf, saya tidak dapat membantu.', /AI tidak menghasilkan rancangan yang valid/],
        ['wrong shape', JSON.stringify({ ...base(), permissions: 'ADMINISTRATOR' }), /AI tidak menghasilkan rancangan yang valid/],
        ['unsafe name', JSON.stringify(withRole('@everyone')), /AI tidak menghasilkan rancangan yang valid/],
        ['provider down', () => { throw Object.assign(new Error('Semua provider gagal atau timeout.'), { status: 503, code: 'PROVIDERS_UNAVAILABLE' }); }, /Provider AI tidak dapat dihubungi\./],
        ['database down', () => { throw new Error('connection terminated: secret-host:5432'); }, /Provider AI tidak dapat dihubungi\./],
        ['AI switched off', () => { throw Object.assign(new Error('AI belum diaktifkan atau belum disetujui.'), { status: 403, code: 'DISABLED' }); }, /AI belum diaktifkan atau belum disetujui\./],
        ['daily limit', () => { throw Object.assign(new Error('Batas permintaan AI harian telah tercapai.'), { status: 429, code: 'LIMIT_REACHED' }); }, /Batas permintaan AI harian telah tercapai\./],
        ['filtered', () => { throw Object.assign(new Error('Respons diblokir oleh kebijakan provider.'), { status: 422, code: 'FILTERED' }); }, /Respons diblokir/],
    ];
    for (const [name, answer, reason] of cases) {
        const r = rig({ answer });
        const d = await draft(r, 'server mabar valorant dan minecraft');
        assert.equal(d.source, 'fallback', name);
        assert.deepEqual(d.theme, { id: 'gaming', label: 'Gaming', emoji: '🎮' }, name);
        assert.deepEqual(d.plan, getTheme('gaming').plan, name);
        assert.match(d.note, reason, name);
        assert.match(d.note, /Sebagai gantinya dipakai tema terdekat: 🎮 Gaming\./, name);
        assert.doesNotMatch(d.note, /secret-host/, name);
        assert.equal(r.builder.pending({ guildId: GUILD, userId: OWNER }).id, d.id, name);
        assert.equal(r.builder.pending({ guildId: GUILD, userId: OWNER }).note, d.note, name);
    }
    const nothing = rig({ answer: 'bukan json' });
    assert.equal((await draft(nothing, 'qwerty')).theme.id, 'komunitas');
});

test('a wrong server, a missing consent or a bad description is refused, not replaced by a theme', async () => {
    const r = rig();
    await assert.rejects(r.builder.draft({ guildId: '999999999999999999', userId: OWNER, description: 'x', consent: true }), { status: 403 });
    for (const consent of [false, undefined, 'true', 1]) await assert.rejects(r.builder.draft({ guildId: GUILD, userId: OWNER, description: 'x', consent }), { status: 403 });
    for (const description of ['', '   ', 'x'.repeat(1001), 5, null, undefined]) await assert.rejects(r.builder.draft({ guildId: GUILD, userId: OWNER, description, consent: true }), { status: 400 });
    assert.equal(r.prompts.length, 0);
    for (const code of ['FORBIDDEN', 'CONSENT_REQUIRED']) {
        const refused = rig({ answer: () => { throw Object.assign(new Error('Ditolak.'), { status: 403, code }); } });
        await assert.rejects(draft(refused), { status: 403, code });
        assert.equal(refused.builder.pending({ guildId: GUILD, userId: OWNER }), null);
    }
});

test('an edited plan keeps its five minutes and is the plan that gets applied', async () => {
    const r = rig();
    const created = [];
    const guild = {
        id: GUILD, features: [], members: { me: { permissions: { has: () => true } } },
        channels: { cache: new Map(), create: async (options) => { created.push(options); return { id: String(600000000000000000n + BigInt(created.length)), ...options }; } },
        roles: { cache: new Map(), create: async (options) => { created.push(options); return { id: String(700000000000000000n + BigInt(created.length)), ...options }; } },
    };
    const d = await r.builder.draftFromTheme({ guildId: GUILD, userId: OWNER, themeId: 'musik' });
    r.tick(100_000);
    const edited = { categories: [{ name: '🎧 Studio', channels: [{ name: 'obrolan', type: 'text', topic: 'Santai.' }, { name: 'Ruang 1', type: 'voice' }] }], roles: [{ name: '🎵 Pendengar', color: '#1abc9c' }, 'Tamu'] };
    const saved = await r.builder.edit({ guildId: GUILD, userId: OWNER, id: d.id, plan: edited });
    assert.equal(saved.expiresInSeconds, 200);
    assert.deepEqual(saved.counts, { categories: 1, channels: 2, roles: 2 });
    assert.deepEqual(r.builder.pending({ guildId: GUILD, userId: OWNER }).plan, saved.plan);
    const result = await r.builder.apply({ guild, userId: OWNER, id: d.id, confirmed: true });
    assert.deepEqual(result.counts, { categories: 1, channels: 2, roles: 2 });
    assert.deepEqual(created.map(({ reason, ...rest }) => rest), [
        { name: '🎧 Studio', type: ChannelType.GuildCategory },
        { name: 'obrolan', type: ChannelType.GuildText, parent: '600000000000000001', topic: 'Santai.' },
        { name: 'Ruang 1', type: ChannelType.GuildVoice, parent: '600000000000000001' },
        { name: '🎵 Pendengar', permissions: 0n, mentionable: false, hoist: false, colors: { primaryColor: '#1ABC9C' } },
        { name: 'Tamu', permissions: 0n, mentionable: false, hoist: false },
    ]);
    assert.ok(created.every((options) => options.reason === 'AI builder: owner confirmed'));
});
