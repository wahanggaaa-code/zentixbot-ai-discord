import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync('dashboard-preview/index.html', 'utf8')
    .replace(/<script src=".*?"><\/script>/g, '');
const scripts = [
    'session.js', 'live.js', 'goodbye-live.js', 'birthday-live.js', 'modules-live.js',
    'operations-live.js', 'features.js', 'ai-studio.js', 'app.js',
];
const memberId = '555555555555555555';
const listedId = '111111111111111111';
const delay = () => new Promise((resolve) => setTimeout(resolve, 35));
const ok = (data) => ({ ok: true, json: async () => data });
const failed = (error) => ({ ok: false, json: async () => ({ error }) });

/** Dashboard page with a scripted backend. `state` can be changed mid-test. */
async function open(t, overrides = {}) {
    const dom = new JSDOM(html, {
        url: 'http://localhost/dashboard/#features/birthday',
        runScripts: 'outside-only',
    });
    const w = dom.window;
    w.scrollTo = () => {};
    t.after(() => w.close());
    const state = {
        confirm: true,
        confirmText: [],
        calls: [],
        listLoads: 0,
        lookup: ok({
            userId: memberId,
            name: '<img src=x onerror=1>',
            bot: false,
            hasBirthday: false,
            leapDayFallback: { month: 2, day: 28 },
        }),
        add: ok({ ok: true }),
        ...overrides,
    };
    w.confirm = (text) => {
        state.confirmText.push(text);
        return state.confirm;
    };
    w.fetch = async (url, options = {}) => {
        url = String(url);
        const method = options.method || 'GET';
        if (url.endsWith('/me')) {
            return ok({ user: { username: 'Tester' }, guild: { name: 'Server' }, csrf: 'csrf-value' });
        }
        if (url.endsWith('/birthday/settings')) return ok({ channelId: null, channels: [] });
        if (url.includes('/birthday/list')) {
            state.listLoads++;
            return ok({ birthdays: [{ userId: listedId, month: 1, day: 2 }], next: null });
        }
        if (url.includes('/birthday/member')) {
            state.calls.push({ url, method, headers: options.headers || {}, body: options.body });
            return method === 'POST' ? state.add : state.lookup;
        }
        return ok({});
    };
    for (const script of scripts) w.eval(fs.readFileSync(`dashboard-preview/${script}`, 'utf8'));
    await delay();
    const $ = (selector) => w.document.querySelector(selector);
    const submit = async (selector) => {
        $(selector).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await delay();
    };
    const lookUp = async (value = memberId) => {
        $('#birthdayLookupForm').elements.userId.value = value;
        await submit('#birthdayLookupForm');
    };
    const fillDate = (day, month) => {
        $('#birthdayAddForm').elements.day.value = day;
        $('#birthdayAddForm').elements.month.value = month;
    };
    const status = () => $('#birthdayAddStatus').textContent;
    return { w, $, state, submit, lookUp, fillDate, status };
}

test('the date can only be entered after the member has been identified', async (t) => {
    const { $, state, lookUp, status } = await open(t);
    assert.ok($('#birthdayLookupForm'));
    assert.equal($('#birthdayAddForm'), null);

    // Not a Discord ID: nothing is sent.
    await lookUp('rina');
    assert.equal(state.calls.length, 0);
    assert.match(status(), /17 sampai 20 digit/);
    assert.equal($('#birthdayAddForm'), null);

    await lookUp(` ${memberId} `);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].method, 'GET');
    assert.ok(state.calls[0].url.endsWith(`/dashboard/api/bot/birthday/member/${memberId}`));
    assert.equal(state.calls[0].body, undefined);

    const form = $('#birthdayAddForm');
    assert.ok(form);
    // The member's name is shown as text, never as markup.
    assert.equal(form.querySelector('img'), null);
    assert.match(form.textContent, /<img src=x onerror=1>/);
    assert.match(form.textContent, new RegExp(memberId));
    assert.match(form.textContent, /29 Februari.*28\/02/);
});

test('a confirmed add sends the exact body with CSRF and refreshes the list', async (t) => {
    const { $, state, lookUp, fillDate, submit, status } = await open(t);
    await lookUp();
    const loadsBefore = state.listLoads;

    // Declining the confirmation sends nothing and keeps the input.
    state.confirm = false;
    fillDate('29', '2');
    await submit('#birthdayAddForm');
    assert.equal(state.calls.length, 1);
    assert.match(state.confirmText[0], /29\/02/);
    assert.match(state.confirmText[0], new RegExp(memberId));
    assert.equal($('#birthdayAddForm').elements.day.value, '29');

    state.confirm = true;
    await submit('#birthdayAddForm');
    const sent = state.calls[1];
    assert.equal(sent.method, 'POST');
    assert.ok(sent.url.endsWith('/dashboard/api/bot/birthday/member'));
    assert.equal(sent.headers['x-csrf-token'], 'csrf-value');
    assert.equal(sent.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(sent.body), { userId: memberId, month: 2, day: 29, confirmed: true });

    // Back to the ID step, with a result message, and the list reloaded once.
    assert.equal($('#birthdayAddForm'), null);
    assert.ok($('#birthdayLookupForm'));
    assert.equal($('#birthdayLookupForm').elements.userId.value, '');
    assert.match(status(), /29\/02 ditambahkan/);
    assert.equal($('#birthdayAddStatus img'), null);
    assert.equal(state.listLoads, loadsBefore + 1);
});

test('dates that do not exist are stopped in the browser', async (t) => {
    const { state, lookUp, fillDate, submit, status } = await open(t);
    await lookUp();
    for (const [day, month] of [['30', '2'], ['31', '4'], ['0', '5'], ['5', '13'], ['1.5', '3'], ['', '3'], ['1e1', '3']]) {
        fillDate(day, month);
        await submit('#birthdayAddForm');
        assert.match(status(), /tidak ada di kalender/, `${day}/${month}`);
    }
    assert.equal(state.calls.length, 1, 'only the lookup was sent');
    assert.equal(state.confirmText.length, 0);
});

test('bots and members who already have a date never reach the date form', async (t) => {
    const page = await open(t);
    const base = { userId: memberId, name: 'Rina', leapDayFallback: { month: 2, day: 28 } };

    page.state.lookup = ok({ ...base, bot: true, hasBirthday: false });
    await page.lookUp();
    assert.match(page.status(), /akun bot/);
    assert.equal(page.$('#birthdayAddForm'), null);

    page.state.lookup = ok({ ...base, bot: false, hasBirthday: true });
    await page.lookUp();
    assert.match(page.status(), /sudah memiliki tanggal/);
    assert.equal(page.$('#birthdayAddForm'), null);

    page.state.lookup = failed('Keanggotaan tidak dapat diverifikasi.');
    await page.lookUp();
    assert.match(page.status(), /tidak dapat diverifikasi/);
    assert.equal(page.$('#birthdayAddForm'), null);
    assert.equal(page.$('#birthdayLookupForm button').disabled, false);
    assert.equal(page.state.calls.every((call) => call.method === 'GET'), true);
});

test('a refused add keeps the input, says the outcome may be unknown, and can be cancelled', async (t) => {
    const { $, state, lookUp, fillDate, submit, status } = await open(t, {
        add: failed('Anggota ini sudah memiliki tanggal.'),
    });
    await lookUp();
    const loadsBefore = state.listLoads;
    fillDate('10', '5');
    await submit('#birthdayAddForm');

    assert.match(status(), /sudah memiliki tanggal/);
    assert.match(status(), /muat ulang daftar dan periksa/);
    assert.equal($('#birthdayAddForm').elements.day.value, '10');
    assert.equal($('#birthdayAddForm fieldset').disabled, false);
    assert.equal(state.listLoads, loadsBefore);

    $('#birthdayAddCancel').click();
    assert.equal($('#birthdayAddForm'), null);
    assert.ok($('#birthdayLookupForm'));
});

test('adding does not discard an edit that is open in the list', async (t) => {
    const { $, state, lookUp, fillDate, submit } = await open(t);
    $('[data-edit="0"]').click();
    $('#birthdayMemberForm').elements.day.value = '9';
    const loadsBefore = state.listLoads;

    await lookUp();
    fillDate('10', '5');
    await submit('#birthdayAddForm');

    assert.equal(state.calls.at(-1).method, 'POST');
    assert.equal(state.listLoads, loadsBefore);
    assert.equal($('#birthdayMemberForm').elements.day.value, '9');
});

test('the offline preview shows no add form and sends nothing', async (t) => {
    const dom = new JSDOM(html, {
        url: 'http://localhost/preview/#features/birthday',
        runScripts: 'outside-only',
    });
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
    assert.equal(w.document.querySelector('#birthdayLookupForm'), null);
    assert.equal(w.document.querySelector('#liveBirthdayAdd'), null);
    assert.equal(calls, 0);
});
