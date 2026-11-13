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

const SAFE = '600000000000000001';
const ADMIN = '600000000000000002';
const HIGH = '600000000000000003';
const roles = [
    { id: SAFE, name: '<img src=x onerror=alert(1)>', ok: true, reason: null },
    { id: ADMIN, name: 'Admin', ok: false, reason: 'Role memiliki izin pengelolaan atau moderasi server.' },
    { id: HIGH, name: 'Tinggi', ok: false, reason: 'Posisi role tidak di bawah role tertinggi bot.' },
];
const unsafeState = {
    roleId: ADMIN, name: 'Admin', ok: false, code: 'ROLE_DANGEROUS',
    reason: 'Role memiliki izin <b>pengelolaan</b> atau moderasi server.',
};
const safeState = { roleId: SAFE, name: 'Premium', ok: true, code: null, reason: null };

/** Economy tab of the dashboard with a scripted backend. */
async function open(t, overrides = {}) {
    const dom = new JSDOM(html, { url: 'http://localhost/dashboard/#features/economy', runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    const state = { premiumRoleId: ADMIN, premiumRole: unsafeState, patches: [], patch: null, loads: 0, ...overrides };
    w.confirm = () => true;
    w.fetch = async (url, options = {}) => {
        url = String(url);
        if (url.endsWith('/me')) return ok({ user: { username: 'Tester' }, guild: { name: 'Server' }, csrf: 'csrf-value' });
        if (url.endsWith('/settings/economy') && options.method === 'PATCH') {
            state.patches.push({ headers: options.headers, body: JSON.parse(options.body) });
            return state.patch ?? ok({ ok: true });
        }
        if (url.endsWith('/settings/economy')) {
            state.loads++;
            return ok({ settings: { premiumRoleId: state.premiumRoleId }, roles, premiumRole: state.premiumRole });
        }
        return ok({});
    };
    for (const script of scripts) w.eval(fs.readFileSync(`dashboard-preview/${script}`, 'utf8'));
    await delay();
    const doc = w.document;
    doc.querySelector('[data-tab="economy"]').click();
    await delay();
    const form = () => doc.querySelector('#economyConfig');
    const submit = () => form().dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
    return {
        w, doc, state, form, submit,
        text: () => doc.querySelector('#premiumRoleState').textContent,
        option: (id) => form().querySelector(`option[value="${id}"]`),
        toast: () => doc.querySelector('#toast').textContent,
    };
}

test('economy page marks roles that cannot be sold and explains the stored one', async (t) => {
    const { doc, form, option, text } = await open(t);
    assert.ok(form(), 'the premium role form is shown');
    assert.equal(form().querySelector('img'), null, 'role names are escaped');
    assert.equal(doc.querySelector('#premiumRoleState b'), null, 'the reason is escaped');

    assert.equal(option(SAFE).disabled, false);
    assert.equal(option(SAFE).textContent, '<img src=x onerror=alert(1)>');
    // The stored role stays selectable so the form shows what is saved.
    assert.equal(option(ADMIN).selected, true);
    assert.equal(option(ADMIN).disabled, false);
    assert.match(option(ADMIN).textContent, /^Admin — tidak dapat dijual$/);
    assert.equal(option(HIGH).disabled, true);
    assert.match(option(HIGH).textContent, /tidak dapat dijual/);

    assert.match(text(), /tidak dapat dijual: Role memiliki izin <b>pengelolaan<\/b> atau moderasi server\./);
    assert.match(text(), /Pembelian ditolak tanpa memotong saldo/);
    assert.match(form().textContent, /harus berada di bawah role bot/);
});

test('economy page states when no premium role is chosen or the stored one is usable', async (t) => {
    const none = await open(t, { premiumRoleId: null, premiumRole: null });
    assert.equal(none.form().elements.premiumRoleId.value, '');
    assert.match(none.text(), /belum dipilih.*tidak dapat dibeli/);
    assert.equal(none.option(ADMIN).disabled, true);

    const usable = await open(t, { premiumRoleId: SAFE, premiumRole: safeState });
    assert.equal(usable.option(SAFE).selected, true);
    assert.match(usable.text(), /dapat diberikan bot: Premium\./);
});

test('saving the premium role sends it with the CSRF token and refreshes the state line', async (t) => {
    const { state, form, submit, text, toast } = await open(t);
    const loadsBefore = state.loads;

    form().elements.premiumRoleId.value = SAFE;
    state.premiumRoleId = SAFE;
    state.premiumRole = safeState;
    submit();
    await delay();
    assert.deepEqual(state.patches[0].body, { premiumRoleId: SAFE });
    assert.equal(state.patches[0].headers['x-csrf-token'], 'csrf-value');
    assert.match(toast(), /disimpan/);
    assert.equal(state.loads, loadsBefore + 1, 'the state is read again after saving');
    assert.match(text(), /dapat diberikan bot: Premium\./);

    form().elements.premiumRoleId.value = '';
    state.premiumRole = null;
    submit();
    await delay();
    assert.deepEqual(state.patches[1].body, { premiumRoleId: null });
    assert.match(text(), /belum dipilih/);
});

test('a refused save shows the server reason and leaves the state line alone', async (t) => {
    const { state, submit, text, toast } = await open(t, {
        patch: failed('Role premium tidak dapat dipakai: Role memiliki izin pengelolaan atau moderasi server.'),
    });
    const before = text();
    const loadsBefore = state.loads;
    submit();
    await delay();
    assert.equal(state.patches.length, 1);
    assert.match(toast(), /Role premium tidak dapat dipakai: Role memiliki izin pengelolaan/);
    assert.equal(text(), before);
    assert.equal(state.loads, loadsBefore);
});
