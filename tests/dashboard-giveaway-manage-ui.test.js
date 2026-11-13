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
const channelId = '444444444444444444';
const messageId = '111111111111111111';
const revision = 'a'.repeat(64);
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
const ok = (data) => ({ ok: true, json: async () => data });
const failed = (error, code) => ({ ok: false, json: async () => ({ error, code }) });

const limits = {
    minWinners: 1, maxWinners: 10, minDurationMs: 300_000, maxDurationMs: 2_592_000_000,
    prizeMaxLength: 256, pendingSettleMs: 120_000,
};
const row = (overrides = {}) => ({
    messageId, channelId, hostId: '555555555555555555', prize: 'Nitro', status: 'active',
    delivery: 'not_recorded', deleting: false, entries: 3, winnerCount: 1, endAt: 1_900_000_000_000,
    warnings: [], review: false, dataReview: false, ...overrides,
});
const prepared = (overrides = {}) => ({
    messageId, channelId, prize: 'Nitro', entries: 3, ended: false, deliveryStatus: null,
    canReroll: false, deleting: false, canResolve: false, canDelete: true, revision, ...overrides,
});

/** Dashboard giveaway page with a scripted backend; `state` can be changed mid-test. */
async function open(t, overrides = {}) {
    const dom = new JSDOM(html, { url: 'http://localhost/dashboard/#features/giveaway', runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    const state = {
        confirm: true,
        confirmText: [],
        posts: [],
        prepares: 0,
        listLoads: 0,
        giveaways: [row()],
        legacyDetected: false,
        prepare: ok(prepared()),
        action: ok({ ok: true, winners: 1, entries: 3 }),
        create: ok({ ok: true, messageId: '999999999999999999', channelId, endAt: 1 }),
        options: ok({ channels: [{ id: channelId, name: '<b>hadiah</b>' }], channelsTruncated: false, limits }),
        ...overrides,
    };
    w.confirm = (text) => {
        state.confirmText.push(text);
        return state.confirm;
    };
    w.fetch = async (url, options = {}) => {
        url = String(url);
        if (url.endsWith('/me')) return ok({ user: { username: 'Tester' }, guild: { name: 'Server' }, csrf: 'csrf-value' });
        if (url.includes('/giveaway/list')) {
            state.listLoads++;
            return ok({ legacyDetected: state.legacyDetected, next: null, giveaways: state.giveaways });
        }
        if (url.includes('/giveaway/prepare')) {
            state.prepares++;
            return state.prepare;
        }
        if (url.endsWith('/giveaway/options')) return state.options;
        if (url.endsWith('/giveaway/action') || url.endsWith('/giveaway/create')) {
            state.posts.push({ url, headers: options.headers, body: JSON.parse(options.body) });
            return url.endsWith('/create') ? state.create : state.action;
        }
        return ok({});
    };
    for (const script of scripts) w.eval(fs.readFileSync(`dashboard-preview/${script}`, 'utf8'));
    await delay();
    const $ = (selector) => w.document.querySelector(selector);
    const click = async (selector) => {
        $(selector).click();
        await delay();
    };
    const actions = () => [...w.document.querySelectorAll('[data-gw-action]')].map((b) => b.dataset.gwAction);
    const notice = () => $('#giveawayNotice').textContent;
    const fill = (values) => {
        const fields = $('#giveawayCreateForm').elements;
        for (const [name, value] of Object.entries(values)) fields[name].value = value;
    };
    const submitCreate = async () => {
        $('#giveawayCreateForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await delay();
    };
    const createStatus = () => $('#giveawayCreateStatus').textContent;
    return { w, $, state, click, actions, notice, fill, submitCreate, createStatus };
}

const validForm = { channelId, prize: '  Nitro  ', winnerCount: '2', amount: '3', unit: 'h' };

// ---- Create -----------------------------------------------------------------

test('the create form sends the exact body after confirmation and refreshes the list', async (t) => {
    const page = await open(t);
    assert.ok(page.$('#giveawayCreateForm'));
    // Channel names are text, never markup.
    assert.equal(page.$('#giveawayCreateForm b b'), null);
    assert.match(page.$('#giveawayCreateForm select[name="channelId"]').textContent, /# <b>hadiah<\/b>/);
    assert.match(page.$('#giveawayCreateForm').textContent, /5 menit sampai 30 hari/);

    page.fill(validForm);
    page.state.confirm = false;
    await page.submitCreate();
    assert.equal(page.state.posts.length, 0);
    assert.match(page.state.confirmText[0], /“Nitro” di #<b>hadiah<\/b>, 2 pemenang, durasi 3 jam/);
    assert.match(page.state.confirmText[0], /pesan publik/);

    page.state.confirm = true;
    const loadsBefore = page.state.listLoads;
    await page.submitCreate();
    assert.equal(page.state.posts.length, 1);
    const sent = page.state.posts[0];
    assert.ok(sent.url.endsWith('/dashboard/api/bot/giveaway/create'));
    assert.equal(sent.headers['x-csrf-token'], 'csrf-value');
    assert.deepEqual(sent.body, { channelId, prize: 'Nitro', winnerCount: 2, duration: '3h', confirmed: true });

    assert.match(page.createStatus(), /Giveaway dibuat.*pesan 999999999999999999/);
    assert.equal(page.$('#giveawayCreateForm').elements.prize.value, '');
    assert.equal(page.state.listLoads, loadsBefore + 1);
    assert.match(page.notice(), /Giveaway baru dibuat/);
});

test('the create form stops invalid input in the browser', async (t) => {
    const page = await open(t);
    const cases = [
        [{ channelId: '' }, /Pilih channel/],
        [{ prize: '   ' }, /Hadiah harus/],
        [{ winnerCount: '0' }, /Jumlah pemenang harus 1–10/],
        [{ winnerCount: '11' }, /Jumlah pemenang/],
        [{ winnerCount: '1.5' }, /Jumlah pemenang/],
        [{ amount: '4', unit: 'm' }, /Durasi harus 5 menit sampai 30 hari/],
        [{ amount: '31', unit: 'd' }, /Durasi harus/],
        [{ amount: '0' }, /Durasi harus/],
        [{ amount: '1.5' }, /Durasi harus/],
    ];
    for (const [change, message] of cases) {
        page.fill({ ...validForm, ...change });
        await page.submitCreate();
        assert.match(page.createStatus(), message, JSON.stringify(change));
    }
    assert.equal(page.state.posts.length, 0);
    assert.equal(page.state.confirmText.length, 0);
});

test('a failed creation shows what the server says was left behind and keeps the input', async (t) => {
    const page = await open(t, {
        create: failed('Pesan Giveaway terkirim, tetapi catatannya tidak dapat dipastikan tersimpan.', 'GIVEAWAY_CREATE_ORPHAN'),
    });
    page.fill(validForm);
    const loadsBefore = page.state.listLoads;
    await page.submitCreate();

    assert.match(page.createStatus(), /catatannya tidak dapat dipastikan/);
    assert.equal(page.$('#giveawayCreateForm').elements.prize.value, '  Nitro  ');
    assert.equal(page.$('#giveawayCreateForm fieldset').disabled, false);
    assert.equal(page.state.listLoads, loadsBefore);
});

test('without a usable channel there is no form, only an explanation and a reload', async (t) => {
    const page = await open(t, { options: ok({ channels: [], channelsTruncated: false, limits }) });
    assert.equal(page.$('#giveawayCreateForm'), null);
    assert.match(page.$('#giveawayCreate').textContent, /Tidak ada channel teks yang dapat dipakai/);

    page.state.options = ok({ channels: [{ id: channelId, name: 'umum' }], channelsTruncated: true, limits });
    await page.click('#giveawayCreate button');
    assert.ok(page.$('#giveawayCreateForm'));
    assert.match(page.$('#giveawayCreateForm').textContent, /Daftar dipotong/);
});

// ---- Row actions ------------------------------------------------------------

test('each stored state offers only the actions that fit it', async (t) => {
    const states = [
        [row(), ['end', 'delete']],
        [row({ status: 'ended', delivery: 'delivered' }), ['reroll', 'delete']],
        [row({ status: 'ended', delivery: 'delivered', entries: 0 }), ['delete']],
        [row({ status: 'ended', delivery: 'not_recorded' }), ['delete']],
        [row({ status: 'ended', delivery: 'pending', review: true, warnings: ['Pengiriman tertunda.'] }), ['mark_delivered', 'redeliver', 'delete']],
        [row({ deleting: true, review: true, warnings: ['Penghapusan belum selesai.'] }), ['delete', 'delete_record']],
        [row({ status: 'review', review: true, dataReview: true, warnings: ['Hadiah tidak valid.'] }), []],
        // Rows from an older server without the new flags: "review" still blocks everything.
        [{ ...row({ review: true }), dataReview: undefined }, []],
    ];
    for (const [giveaway, expected] of states) {
        const page = await open(t, { giveaways: [giveaway] });
        assert.deepEqual(page.actions(), expected, JSON.stringify(giveaway).slice(0, 120));
    }

    const unfinished = await open(t, { giveaways: [row({ deleting: true, review: true, warnings: [] })] });
    assert.match(unfinished.$('#giveawayLive').textContent, /PENGHAPUSAN BELUM SELESAI/);
    assert.equal(unfinished.$('[data-gw-action="delete"]').textContent, 'LANJUTKAN HAPUS');

    const legacy = await open(t, { legacyDetected: true });
    assert.deepEqual(legacy.actions(), []);
});

test('delete checks fresh data, explains what is lost, and sends the shown revision', async (t) => {
    const page = await open(t);
    page.state.confirm = false;
    await page.click('[data-gw-action="delete"]');
    assert.equal(page.state.prepares, 1);
    assert.equal(page.state.posts.length, 0);
    assert.match(page.state.confirmText[0], /Hapus giveaway “Nitro” \(pesan 111111111111111111, 3 entri tersimpan\)/);
    assert.match(page.state.confirmText[0], /Semua entri hilang dan tidak dapat dikembalikan/);
    assert.match(page.state.confirmText[0], /Pengumuman pemenang yang sudah ada tidak dihapus/);
    assert.match(page.notice(), /Dibatalkan/);
    assert.equal(page.$('[data-gw-action="delete"]').disabled, false);

    page.state.confirm = true;
    page.state.action = ok({ ok: true, discord: 'deleted', entries: 3 });
    await page.click('[data-gw-action="delete"]');
    assert.equal(page.state.posts.length, 1);
    assert.equal(page.state.posts[0].headers['x-csrf-token'], 'csrf-value');
    assert.deepEqual(page.state.posts[0].body, { messageId, action: 'delete', revision, confirmed: true });
    assert.match(page.notice(), /Giveaway dihapus: pesan dan catatan/);
});

test('a delivery that may still be running blocks delete and repair before any dialog', async (t) => {
    const pending = row({ status: 'ended', delivery: 'pending', review: true, warnings: [] });
    const page = await open(t, {
        giveaways: [pending],
        prepare: ok(prepared({ ended: true, deliveryStatus: 'pending', canDelete: false, canResolve: false })),
    });
    for (const action of ['delete', 'mark_delivered', 'redeliver']) {
        await page.click(`[data-gw-action="${action}"]`);
        assert.match(page.notice(), /mungkin masih berjalan.*dua menit/, action);
    }
    assert.equal(page.state.confirmText.length, 0);
    assert.equal(page.state.posts.length, 0);
});

test('repairing an unfinished delivery states exactly what the bot will and will not do', async (t) => {
    const pending = row({ status: 'ended', delivery: 'pending', review: true, warnings: [] });
    const page = await open(t, {
        giveaways: [pending],
        prepare: ok(prepared({ ended: true, deliveryStatus: 'pending', canResolve: true })),
    });

    await page.click('[data-gw-action="mark_delivered"]');
    assert.match(page.state.confirmText[0], /hanya jika Anda sudah melihat pengumuman pemenangnya di Discord/);
    assert.match(page.state.confirmText[0], /Bot tidak mengirim apa pun/);
    assert.deepEqual(page.state.posts[0].body, { messageId, action: 'mark_delivered', revision, confirmed: true });
    assert.match(page.notice(), /Ditandai terkirim/);

    await page.click('[data-gw-action="redeliver"]');
    assert.match(page.state.confirmText[1], /tanpa undian baru/);
    assert.match(page.state.confirmText[1], /akan ada dua pengumuman/);
    assert.equal(page.state.posts[1].body.action, 'redeliver');
    assert.match(page.notice(), /Hasil dikirim ulang: 1 pemenang tersimpan/);
});

test('when the bot cannot reach the message, removing only the record is offered separately', async (t) => {
    const page = await open(t, {
        action: failed('Pesan Giveaway di Discord tidak dapat diperiksa atau dihapus oleh bot. Tidak ada yang diubah.', 'GIVEAWAY_DISCORD_UNVERIFIED'),
    });
    assert.equal(page.$('#giveawayRecordOnly'), null);
    await page.click('[data-gw-action="delete"]');
    assert.match(page.notice(), /Tidak ada yang diubah/);
    assert.doesNotMatch(page.notice(), /Hasil mungkin tidak diketahui/);
    assert.ok(page.$('#giveawayRecordOnly'));
    // The row buttons stay off until the list is reloaded.
    assert.equal(page.$('[data-gw-action="delete"]').disabled, true);

    page.state.action = ok({ ok: true, discord: 'untouched', entries: 3 });
    await page.click('#giveawayRecordOnly');
    assert.equal(page.state.prepares, 2, 'fresh data is loaded again');
    assert.match(page.state.confirmText.at(-1), /Hapus HANYA catatan/);
    assert.match(page.state.confirmText.at(-1), /Discord tidak disentuh/);
    assert.deepEqual(page.state.posts.at(-1).body, { messageId, action: 'delete_record', revision, confirmed: true });
    assert.match(page.notice(), /Catatan dihapus\. Discord tidak disentuh/);
});

test('other delete failures do not offer the record-only shortcut', async (t) => {
    const page = await open(t, {
        action: failed('Penghapusan belum selesai: catatan ditandai dan masih ada.', 'GIVEAWAY_DELETE_UNFINISHED'),
    });
    await page.click('[data-gw-action="delete"]');
    assert.match(page.notice(), /Penghapusan belum selesai/);
    assert.equal(page.$('#giveawayRecordOnly'), null);
});

test('the offline preview has no create form and sends nothing', async (t) => {
    const dom = new JSDOM(html, { url: 'http://localhost/preview/#features/giveaway', runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    let calls = 0;
    w.fetch = async () => {
        calls++;
        throw new Error('unexpected');
    };
    for (const script of scripts) w.eval(fs.readFileSync(`dashboard-preview/${script}`, 'utf8'));
    await delay();
    assert.equal(w.document.querySelector('#giveawayCreate'), null);
    assert.equal(w.document.querySelector('#giveawayCreateForm'), null);
    assert.equal(calls, 0);
});
