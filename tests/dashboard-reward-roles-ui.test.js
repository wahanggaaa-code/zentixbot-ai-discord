import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('dashboard-preview/index.html', 'utf8')
    .replace(/<script src=".*?"><\/script>/g, '');
const scripts = [
    'session.js', 'live.js', 'goodbye-live.js', 'birthday-live.js', 'core-live.js', 'giveaway-live.js',
    'modules-live.js', 'operations-live.js', 'features.js', 'ai-studio.js', 'app.js',
];
const delay = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (data) => ({ ok: true, json: async () => data });
const failed = (error) => ({ ok: false, json: async () => ({ error }) });

const summary = {
    scannedGuilds: 1, prunedRewardEntries: 0, missingRewardEntries: 1, unusableRewardEntries: 2,
    membersChecked: 14, rolesReAwarded: 5, errors: 3,
};
const finished = { running: false, failed: false, startedAt: '2026-11-13T01:00:00.000Z', finishedAt: '2026-11-13T01:00:05.000Z', summary };
const idle = { running: false, failed: false, startedAt: null, finishedAt: null, summary: null };
const running = { running: true, failed: false, startedAt: '2026-11-13T01:00:00.000Z', finishedAt: null, summary: null };

/** Leveling settings page with a scripted backend. */
async function open(t, overrides = {}) {
    const dom = new JSDOM(html, { url: 'http://localhost/dashboard/#features/economy', runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    const state = {
        confirm: true,
        confirmText: [],
        posts: [],
        patches: [],
        settingsLoads: 0,
        revision: 'a'.repeat(24),
        patch: null,
        rewardRoles: [
            { level: 5, roleId: '600000000000000001', name: '<img src=x onerror=alert(1)>', ok: true, code: null, reason: null },
            { level: 9, roleId: '600000000000000002', name: null, ok: false, code: 'ROLE_MISSING', reason: 'Role sudah tidak ada di server.' },
        ],
        rewardSync: idle,
        start: ok({ ok: true, status: running }),
        poll: ok({ status: finished }),
        ...overrides,
    };
    w.confirm = (text) => {
        state.confirmText.push(text);
        return state.confirm;
    };
    w.fetch = async (url, options = {}) => {
        url = String(url);
        if (url.endsWith('/me')) return ok({ user: { username: 'Tester' }, guild: { name: 'Server' }, csrf: 'csrf-value' });
        if (url.endsWith('/settings/leveling') && options.method === 'PATCH') {
            state.patches.push(JSON.parse(options.body));
            return state.patch ?? ok({ ok: true });
        }
        if (url.endsWith('/settings/leveling')) {
            state.settingsLoads++;
            return ok({
                settings: { enabled: true, roleRewards: { 5: '600000000000000001', 9: '600000000000000002' } },
                channels: [], categories: [], roles: [], events: [], groups: [],
                rewardRoles: state.rewardRoles, rewardSync: state.rewardSync, revision: state.revision,
            });
        }
        if (url.endsWith('/leveling/reward-sync') && options.method === 'POST') {
            state.posts.push({ headers: options.headers, body: JSON.parse(options.body) });
            return state.start;
        }
        if (url.endsWith('/leveling/reward-sync')) return state.poll;
        return ok({});
    };
    for (const script of scripts) w.eval(fs.readFileSync(`dashboard-preview/${script}`, 'utf8'));
    await delay();
    const doc = w.document;
    return { w, doc, state, box: () => doc.querySelector('#rewardRoleBox'), toast: () => doc.querySelector('#toast').textContent };
}

test('leveling page lists each stored reward with its state, escaped', async (t) => {
    const { doc, box } = await open(t);
    assert.ok(box(), 'the reward box is shown on the leveling tab');
    const rows = [...doc.querySelectorAll('#rewardRoleList li')];
    assert.equal(rows.length, 2);
    assert.equal(doc.querySelector('#rewardRoleList img'), null);
    assert.match(rows[0].textContent, /Level 5 · @ <img src=x onerror=alert\(1\)> — Dapat diberikan/);
    assert.match(rows[1].textContent, /Level 9 · ID 600000000000000002 — Tidak diberikan: Role sudah tidak ada di server\./);
    assert.equal(rows[1].dataset.ok, '0');
    assert.match(doc.querySelector('#rewardSyncStatus').textContent, /belum dijalankan/);

    const page = doc.querySelector('#moduleLive').textContent;
    assert.match(page, /Role hanya ditambahkan dan tidak pernah dicabut/);
    assert.doesNotMatch(page, /tidak menyinkronkan role lama/);
});

test('sync button asks first, posts the confirmation with the CSRF token and shows the result', async (t) => {
    const { doc, state, toast } = await open(t, { confirm: false });
    const button = doc.querySelector('#rewardSyncStart');

    button.click();
    await delay();
    assert.equal(state.posts.length, 0, 'declining the question sends nothing');
    assert.match(state.confirmText[0], /Role tidak ada yang dicabut/);

    state.confirm = true;
    button.click();
    await delay();
    assert.deepEqual(state.posts[0].body, { confirmed: true });
    assert.equal(state.posts[0].headers['x-csrf-token'], 'csrf-value');
    assert.match(toast(), /dimulai/);
    assert.equal(button.disabled, true);
    assert.match(doc.querySelector('#rewardSyncStatus').textContent, /sedang berjalan/);

    // The page polls until the run is over.
    await delay(3200);
    const status = doc.querySelector('#rewardSyncStatus').textContent;
    assert.match(status, /14 anggota diperiksa, 5 role diberikan, 1 role hadiah sudah tidak ada, 2 role hadiah tidak dapat diberikan bot, 3 galat/);
    assert.equal(button.disabled, false);
});

test('a refused sync shows the server message and frees the button', async (t) => {
    const { doc, state, toast } = await open(t, { start: failed('Sinkronisasi baru saja selesai. Tunggu satu menit.') });
    const button = doc.querySelector('#rewardSyncStart');
    button.click();
    await delay();
    assert.equal(state.posts.length, 1);
    assert.match(toast(), /Tunggu satu menit/);
    assert.equal(button.disabled, false);
});

test('a failed last run is shown as failed; saving refreshes the reward list', async (t) => {
    const { doc, state } = await open(t, { rewardSync: { ...finished, failed: true, summary: null } });
    assert.match(doc.querySelector('#rewardSyncStatus').textContent, /gagal\. Periksa log bot/);

    state.rewardRoles = [{ level: 5, roleId: '600000000000000001', name: 'Aktif', ok: true, code: null, reason: null }];
    doc.querySelector('#moduleForm').dispatchEvent(new doc.defaultView.Event('submit', { cancelable: true, bubbles: true }));
    await delay();
    assert.deepEqual(state.patches[0].roleRewards, { 5: '600000000000000001', 9: '600000000000000002' });
    assert.equal(doc.querySelectorAll('#rewardRoleList li').length, 1);
    assert.equal(state.settingsLoads, 2);
});

test('saving sends the revision that was loaded and takes the new one afterwards', async (t) => {
    const { w, doc, state, toast } = await open(t);
    const submit = async () => {
        doc.querySelector('#moduleForm').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
        await delay();
    };

    state.revision = 'b'.repeat(24);
    await submit();
    assert.equal(state.patches[0].revision, 'a'.repeat(24));
    await submit();
    assert.equal(state.patches[1].revision, 'b'.repeat(24), 'the revision read after the first save');

    // The server refuses an out-of-date page; its text reaches the admin.
    state.patch = { ok: false, status: 409, json: async () => ({ error: 'Pengaturan leveling sudah diubah di tempat lain.' }) };
    await submit();
    assert.match(toast(), /sudah diubah di tempat lain/);
    assert.equal(state.settingsLoads, 3, 'a refused save does not reload the settings');
});

test('member level form tells what happened to reward roles', async (t) => {
    const { w, doc, toast } = await open(t);
    const memberId = '700000000000000001';
    let answer = { ok: true, rewardRoles: { added: [{ level: 2 }, { level: 4 }], notGiven: [{ level: 6 }] } };
    const posts = [];
    const base = w.fetch;
    w.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/settings/economy')) return ok({ settings: { premiumRoleId: null }, roles: [] });
        if (String(url).endsWith(`/members/${memberId}`) && options.method === 'POST') {
            posts.push(JSON.parse(options.body));
            return ok(answer);
        }
        if (String(url).endsWith(`/members/${memberId}`)) {
            return ok({ member: { id: memberId, name: 'Member#0001' }, economy: null, level: { level: 1, xp: 0, totalXp: 50 } });
        }
        return base(url, options);
    };

    doc.querySelector('[data-tab="economy"]').click();
    await delay();
    const search = doc.querySelector('#memberSearch');
    search.elements.id.value = memberId;
    const submit = (form) => form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
    search.requestSubmit = () => submit(search);
    submit(search);
    await delay();

    assert.match(doc.querySelector('#memberResult').textContent, /Menurunkan level tidak mencabut role/);
    const levelForm = () => doc.querySelector('#memberResult [data-edit="level"]');
    levelForm().elements.value.value = '6';
    submit(levelForm());
    await delay();
    assert.deepEqual(posts[0], { type: 'level', value: 6, expected: 1, confirmed: true });
    assert.match(toast(), /Level disimpan\. Role hadiah diberikan: 2, tidak diberikan: 1\. Role lama tidak dicabut\./);

    // The level was stored but the roles could not be checked.
    answer = { ok: true, rewardRoles: null };
    levelForm().elements.value.value = '7';
    submit(levelForm());
    await delay();
    assert.match(toast(), /Level disimpan\. Role hadiah tidak dapat diperiksa\./);
});
