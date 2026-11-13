import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('dashboard-preview/index.html', 'utf8').replace(/<script src=".*?"><\/script>/g, '');
const scripts = ['session.js', 'live.js', 'goodbye-live.js', 'birthday-live.js', 'core-live.js', 'giveaway-live.js', 'join-to-create-settings.js', 'join-to-create-live.js', 'modules-live.js', 'operations-live.js', 'features.js', 'ai-studio.js', 'app.js'];
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
const SETTINGS = '/dashboard/api/bot/join-to-create/settings';
const REVISION = 'a'.repeat(64);
const TRIGGER = '444444444444444444';

const inventory = { state: 'missing', otherData: false };
const baseSettings = {
    configRevision: REVISION, enabled: true, busy: false, temporaryCount: 0, triggers: [], voiceChannels: [], voiceChannelsTruncated: false,
    placeholders: ['{username}', '{display_name}'], limits: { nameTemplate: 100, guildBitrate: 96000 },
};
const withTrigger = (extra = {}) => ({
    ...baseSettings,
    triggers: [{ channelId: TRIGGER, channelName: 'Lobby', botCanManage: true, nameTemplate: "{username}'s Room", userLimit: 4, bitrate: 64000, ...extra }],
});

/** Dashboard page on the Join to Create feature with a scripted backend. */
async function open(t, { settings, respond, url = 'http://localhost/dashboard/#features/join-to-create', confirm = true } = {}) {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    const calls = [];
    const confirms = [];
    w.confirm = (message) => { confirms.push(message); return confirm; };
    w.fetch = async (target, options = {}) => {
        const path = String(target);
        const call = { path, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined };
        calls.push(call);
        if (path.endsWith('/me')) return { ok: true, json: async () => ({ user: { username: 'Tester' }, guild: { name: 'Server' }, csrf: 'csrf-token' }) };
        if (path.startsWith(SETTINGS)) {
            if (call.method !== 'GET') return respond ? respond(call) : { ok: true, json: async () => ({ ok: true }) };
            const data = typeof settings === 'function' ? settings() : settings;
            return data instanceof Error ? { ok: false, json: async () => ({ error: data.message }) } : { ok: true, json: async () => data };
        }
        if (path.includes('/join-to-create')) return { ok: true, json: async () => inventory };
        return { ok: true, json: async () => ({}) };
    };
    scripts.forEach((name) => w.eval(fs.readFileSync(`dashboard-preview/${name}`, 'utf8')));
    await delay();
    const slot = () => w.document.querySelector('#jtcSettings');
    const submit = async (form) => { form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await delay(); };
    const writes = () => calls.filter((call) => call.method !== 'GET');
    return { w, calls, confirms, slot, submit, writes };
}

test('trigger settings are shown escaped and a save sends only the changed fields with revision, confirmation and CSRF', async (t) => {
    let loads = 0;
    const page = await open(t, { settings: () => { loads += 1; return withTrigger({ channelName: '<img src=x onerror=alert(1)>', nameTemplate: '"><svg onload=alert(1)>' }); } });
    const slot = page.slot();
    assert.ok(slot);
    assert.equal(slot.querySelector('img,svg'), null, 'server data is never parsed as HTML');
    assert.match(slot.textContent, /<img src=x/);
    const form = slot.querySelector('form[data-trigger]');
    assert.equal(form.elements.nameTemplate.value, '"><svg onload=alert(1)>');
    assert.equal(form.elements.userLimit.value, '4');
    assert.equal(form.elements.bitrateKbps.value, '64');
    assert.match(slot.textContent, /mengizinkan sampai 96/);
    assert.match(page.w.document.body.textContent, /PENGATURAN TRIGGER TERHUBUNG KE BOT · BUKAN STATUS DISCORD/);
    assert.equal(page.writes().length, 0, 'loading the page changes nothing');

    // Nothing changed → nothing sent, no confirmation asked.
    await page.submit(form);
    assert.match(slot.textContent, /Tidak ada perubahan/);
    assert.deepEqual([page.writes().length, page.confirms.length], [0, 0]);

    form.elements.userLimit.value = '10';
    const before = loads;
    await page.submit(form);
    assert.equal(page.confirms.length, 1);
    assert.deepEqual(page.writes().map((call) => [call.method, call.path, call.body, call.headers['x-csrf-token']]), [
        ['PATCH', `${SETTINGS}/triggers/${TRIGGER}`, { userLimit: 10, revision: REVISION, confirmed: true }, 'csrf-token'],
    ]);
    assert.ok(loads > before, 'settings are read again after saving');
    assert.match(page.slot().textContent, /Pengaturan disimpan/);
    assert.ok(page.calls.filter((call) => call.path.endsWith('/join-to-create')).length >= 2, 'the inventory below is refreshed too');
});

test('declining the confirmation or entering invalid values sends nothing', async (t) => {
    const page = await open(t, { settings: withTrigger(), confirm: false });
    const form = page.slot().querySelector('form[data-trigger]');

    form.elements.userLimit.value = '10';
    await page.submit(form);
    page.slot().querySelector('[data-remove]').click();
    await delay();
    assert.equal(page.confirms.length, 2);
    assert.equal(page.writes().length, 0);

    for (const [field, value, message] of [['userLimit', '100', /0 sampai 99/], ['userLimit', '2.5', /0 sampai 99/], ['userLimit', '', /0 sampai 99/], ['bitrateKbps', '7', /8 sampai 384/], ['bitrateKbps', '1e2', /8 sampai 384/], ['nameTemplate', '   ', /tidak boleh kosong/]]) {
        const fresh = page.slot().querySelector('form[data-trigger]');
        fresh.elements.userLimit.value = '4';
        fresh.elements.bitrateKbps.value = '64';
        fresh.elements.nameTemplate.value = 'room';
        fresh.elements[field].value = value;
        await page.submit(fresh);
        assert.match(page.slot().querySelector('#jtcSettingsStatus').textContent, message, `${field}=${value}`);
    }
    assert.equal(page.confirms.length, 2, 'invalid input is refused before asking for confirmation');
    assert.equal(page.writes().length, 0);
});

test('a refused save shows the reason safely, keeps what was typed and does not claim success', async (t) => {
    const page = await open(t, {
        settings: withTrigger(),
        respond: () => ({ ok: false, json: async () => ({ error: 'Pengaturan berubah sejak halaman dimuat. <img src=x>' }) }),
    });
    const form = page.slot().querySelector('form[data-trigger]');
    form.elements.nameTemplate.value = 'Ruang {username}';
    form.elements.bitrateKbps.value = '96';
    await page.submit(form);

    assert.deepEqual(page.writes()[0].body, { nameTemplate: 'Ruang {username}', bitrate: 96000, revision: REVISION, confirmed: true });
    const status = page.slot().querySelector('#jtcSettingsStatus');
    assert.match(status.textContent, /berubah sejak halaman dimuat/);
    assert.match(status.textContent, /muat ulang sebelum mencoba lagi/);
    assert.equal(page.slot().querySelector('img'), null);
    assert.doesNotMatch(page.slot().textContent, /Pengaturan disimpan/);
    const same = page.slot().querySelector('form[data-trigger]');
    assert.equal(same.elements.nameTemplate.value, 'Ruang {username}');
    assert.equal(same.elements.nameTemplate.disabled, false);
});

test('releasing a trigger explains what stays in Discord and sends the revision', async (t) => {
    const page = await open(t, { settings: withTrigger({ botCanManage: false }) });
    assert.match(page.slot().textContent, /tidak memiliki izin/);
    page.slot().querySelector('[data-remove]').click();
    await delay();
    assert.match(page.confirms[0], /Channel di Discord tidak dihapus/);
    assert.match(page.confirms[0], /tetap dihapus saat kosong/);
    assert.deepEqual(page.writes().map((call) => [call.method, call.path, call.body]), [
        ['DELETE', `${SETTINGS}/triggers/${TRIGGER}`, { revision: REVISION, confirmed: true }],
    ]);
});

test('without a trigger the page offers setup with channels the bot can manage', async (t) => {
    const voiceChannels = [
        { id: '111111111111111111', name: 'Lobby', category: 'Voice', usable: true },
        { id: '222222222222222222', name: '<b>Locked</b>', category: null, usable: false },
    ];
    const page = await open(t, { settings: { ...baseSettings, enabled: false, voiceChannels } });
    const form = page.slot().querySelector('form[data-setup]');
    assert.ok(form);
    assert.equal(form.querySelector('b b'), null);
    const options = [...form.elements.channel.options];
    assert.deepEqual(options.map((option) => [option.textContent, option.disabled]), [
        ['Pilih channel suara', false], ['Voice / Lobby', false], ['<b>Locked</b> (izin bot kurang)', true],
    ]);
    assert.equal(form.elements.nameTemplate.value, "{username}'s Room");

    await page.submit(form);
    assert.match(page.slot().textContent, /Pilih channel suara yang dapat dikelola bot/);
    assert.equal(page.writes().length, 0);

    form.elements.channel.value = '0';
    form.elements.userLimit.value = '5';
    await page.submit(form);
    assert.match(page.confirms[0], /Lobby/);
    assert.deepEqual(page.writes().map((call) => [call.method, call.path, call.body]), [
        ['POST', `${SETTINGS}/triggers`, { nameTemplate: "{username}'s Room", userLimit: 5, bitrate: 64000, channelId: '111111111111111111', confirmed: true }],
    ]);
});

test('no voice channels, a busy bot and a failed read are explained; the static preview stays offline', async (t) => {
    await t.test('no voice channels', async (t) => {
        const page = await open(t, { settings: { ...baseSettings, enabled: false } });
        assert.match(page.slot().textContent, /tidak melihat channel suara/);
        assert.equal(page.slot().querySelector('form'), null);
    });
    await t.test('busy', async (t) => {
        const page = await open(t, { settings: { ...withTrigger(), busy: true } });
        assert.match(page.slot().textContent, /sedang membuat channel sementara/);
    });
    await t.test('failed read can be retried', async (t) => {
        let attempt = 0;
        const page = await open(t, { settings: () => (++attempt === 1 ? new Error('Ada data berformat lama. <img src=x>') : withTrigger()) });
        assert.match(page.slot().textContent, /format lama/);
        assert.equal(page.slot().querySelector('img,form'), null);
        page.slot().querySelector('button').click();
        await delay();
        assert.ok(page.slot().querySelector('form[data-trigger]'));
    });
    await t.test('static preview', async (t) => {
        const page = await open(t, { settings: withTrigger(), url: 'http://localhost/preview/#features/join-to-create' });
        assert.equal(page.slot(), null);
        assert.equal(page.calls.length, 0);
    });
});
