/**
 * The logged-in dashboard, page by page, against the real dashboard routers and a real PostgreSQL schema
 * (Discord is a fake). Two questions:
 *   1. does every tab load from the bot without a script error and without a mock form;
 *   2. does every control of every form reach the server — changing it must change the request that is sent.
 * A control that is drawn but never sent is exactly the "looks real, is a simulation" case this guards against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { ChannelType } from 'discord.js';
import { JSDOM } from 'jsdom';
import { createLevelingFixture, adminId } from './helpers/leveling-postgres-fixture.js';
import { createBotApiRouter } from '../src/dashboard/botApi.js';
import { createGoodbyeApi } from '../src/dashboard/goodbyeApi.js';
import { createBirthdayApi } from '../src/dashboard/birthdayApi.js';
import { createCoreApi } from '../src/dashboard/coreApi.js';
import { createGiveawayApi } from '../src/dashboard/giveawayApi.js';
import { createJoinToCreateApi } from '../src/dashboard/joinToCreateApi.js';
import { createJoinToCreateSettingsApi } from '../src/dashboard/joinToCreateSettingsApi.js';
import { createModulesApi } from '../src/dashboard/modulesApi.js';
import { createOperationsApi } from '../src/dashboard/operationsApi.js';
import { createHostingApi } from '../src/dashboard/hostingApi.js';
import { createAIApi } from '../src/dashboard/aiApi.js';
import { createSettingsApi } from '../src/dashboard/settingsApi.js';
import { createServerStatsApi } from '../src/dashboard/serverStatsApi.js';
import { createReactionRolesApi } from '../src/dashboard/reactionRolesApi.js';
import { createCountingApi } from '../src/dashboard/countingApi.js';
import { createApplicationsApi } from '../src/dashboard/applicationsApi.js';

const dir = 'dashboard-preview/';
const raw = fs.readFileSync(dir + 'index.html', 'utf8');
const scripts = [...raw.matchAll(/<script src="(.*?)"><\/script>/g)].map((m) => m[1]);
const html = raw.replace(/<script src=".*?"><\/script>/g, '');
const tick = (ms = 4) => new Promise((resolve) => setTimeout(resolve, ms));
const MOCK = '[data-form],[data-ai-form],[data-sim-action],[data-ai-action]';
const SNOWFLAKE = '423456789012345678';

// Controls whose effect cannot be shown here, each for a stated reason. Anything else that does not change the
// request fails the test.
const NEEDS_PRECONDITION = {
    // Sent as a second request, only after the loop request succeeded; that needs an active Lavalink player.
    '#features/music/player musicSettings.always': 'needs an active player',
    // Both forms refuse to send anything until a file is chosen, which jsdom cannot do.
    '#ai/knowledge/library knowledgeUpload.ocrPdf': 'needs a chosen file',
    '#ai/knowledge/library knowledgeUpload.pageNumber': 'needs a chosen file',
    '#ai/image/edit aiImageForm.prompt': 'needs a chosen image',
    '#ai/image/edit aiImageForm.size': 'needs a chosen image',
    '#ai/image/edit aiImageForm.style': 'needs a chosen image',
};
// Controls that only count under another choice in the same form; the page says so next to each of them.
const CONTEXT = {
    'aiManualForm.permission': { action: 'permissions' }, // "hanya tindakan atur izin"
    // A panel offers at least one role; the page sends nothing before one is ticked.
    'reactRolesCreateForm.channelId': { roleIds: true },
    'reactRolesCreateForm.title': { roleIds: true },
    'reactRolesCreateForm.description': { roleIds: true },
};
// Pages left to their own tests, with the reason.
const COVERED_ELSEWHERE = {
    // The setup form turns into a trigger form after its first successful save, so it cannot be flipped field by
    // field here. tests/dashboard-jointocreate-settings-ui.test.js asserts the exact bodies both forms send.
    '#features/join-to-create': 'tests/dashboard-jointocreate-settings-ui.test.js',
};
// Reads that legitimately answer with an error in this fixture.
const EXPECTED_READ_ERRORS = { 'bot/logs': 404 }; // no audit channel is configured

async function openDashboard(t) {
    const fx = await createLevelingFixture(t);
    const { client, guild } = fx;
    const env = { OWNER_IDS: adminId };
    client.isReady = () => true;
    // One of each kind of thing a form lets the user pick, so that every select has a real choice.
    fx.addRole('623456789012345001', { name: 'Member', position: 5 });
    // Two categories the bot may manage, so the server stats form has a category to pick and another to switch to.
    guild.channels.cache.set('623456789012345002', { id: '623456789012345002', name: 'Tiket', type: ChannelType.GuildCategory, permissionsFor: () => ({ has: () => true }) });
    guild.channels.cache.set('623456789012345005', { id: '623456789012345005', name: 'Statistik', type: ChannelType.GuildCategory, permissionsFor: () => ({ has: () => true }) });
    // Creating a channel is refused here: the walk compares requests, and a counter that really got created would
    // change the form between the two submits of a comparison.
    guild.channels.create = async () => { throw new Error('channel creation is not available in this walk'); };
    guild.channels.cache.set('623456789012345003', { id: '623456789012345003', name: 'Musik', type: ChannelType.GuildVoice });
    // A text channel that reports its permissions; the giveaway form only offers channels the bot may post in.
    // Sending is refused, like channel creation above: a reaction role panel that really got posted would change
    // the page between the two submits of a comparison.
    guild.channels.cache.set('623456789012345004', {
        id: '623456789012345004', name: 'umum', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
        send: async () => { throw new Error('sending is not available in this walk'); },
    });
    // A running counting game, so that the page offers its reset form as well as its settings form.
    await fx.query('INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb)', [`countingGame:${guild.id}`, JSON.stringify({
        enabled: true, channelId: '623456789012345004', system: 'decimal', nextNumber: 4, lastUserId: null, currentStreak: 3, bestStreak: 3, leaderboard: {},
    })]);
    // Two application forms, so the page has forms to change, and two more roles, so its role picker has another
    // role to switch to. Creating a form must be refused throughout: a form that really got created would change the
    // page between the two submits of a comparison. It is: the picker's first role is the bot's own, which cannot be
    // applied for, and with another role the name this walk types ("uji") is taken. The walk checks this at its end.
    fx.addRole('623456789012345006', { name: 'Helper', position: 4 });
    fx.addRole('623456789012345007', { name: 'Staff', position: 3 });
    const applications = `guild:${guild.id}:applications:`;
    for (const [key, value] of [
        ['settings', { enabled: true }],
        ['roles', [{ roleId: '623456789012345006', name: 'uji', enabled: true }, { roleId: '623456789012345007', name: 'ujiz', enabled: true }]],
        ['role:623456789012345006:settings', { questions: ['Why?'], logChannelId: null }],
        ['role:623456789012345007:settings', { questions: ['Why?'], logChannelId: null }],
    ]) await fx.query('INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb)', [applications + key, JSON.stringify(value)]);
    client.commands = new Map([
        ['ping', { data: { name: 'ping', description: 'Ping' }, category: 'Core' }],
        ['balance', { data: { name: 'balance', description: 'Balance' }, category: 'Economy' }],
    ]);
    const app = express();
    const auth = (req, res, next) => {
        req.guild = guild;
        req.member = { id: adminId, user: { id: adminId } };
        req.session = { user: { id: adminId, username: 'Tester' }, csrf: 'c' };
        next();
    };
    const csrf = (req, res, next) => next();
    app.get('/dashboard/api/me', (req, res) => res.json({ user: { username: 'Tester' }, guild: { name: 'Home' }, csrf: 'c', botOwner: true }));
    for (const create of [createBotApiRouter, createGoodbyeApi, createBirthdayApi, createCoreApi, createGiveawayApi, createJoinToCreateSettingsApi, createServerStatsApi, createReactionRolesApi, createCountingApi, createApplicationsApi, createModulesApi, createOperationsApi]) {
        app.use('/dashboard/api/bot', create(client, { auth, csrf }));
    }
    app.use('/dashboard/api/bot', createJoinToCreateApi(client, { auth }));
    app.use('/dashboard/api/bot', createHostingApi({ auth, env }));
    app.use('/dashboard/api/bot', createSettingsApi(client, { auth, env }));
    app.use('/dashboard/api/ai', createAIApi(client, { auth, csrf, env }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;

    const dom = new JSDOM(html, { url: 'http://localhost/dashboard/', runScripts: 'outside-only' });
    const w = dom.window;
    w.scrollTo = () => {};
    w.confirm = () => true;
    const state = { inflight: 0, reads: [], writes: [], errors: [] };
    w.fetch = async (url, options = {}) => {
        const path = String(url).replace('/dashboard/api/', '');
        const method = options.method || 'GET';
        state.inflight++;
        try {
            const response = await fetch(origin + url, { method, headers: options.headers, body: options.body });
            const text = await response.text();
            if (method === 'GET') state.reads.push({ path, status: response.status });
            else state.writes.push(`${method} ${path} ${typeof options.body === 'string' ? options.body : '[binary]'}`);
            return { ok: response.ok, status: response.status, json: async () => JSON.parse(text), text: async () => text };
        } finally {
            state.inflight--;
        }
    };
    const onError = (error) => state.errors.push(String(error?.stack ?? error).split('\n').slice(0, 2).join(' | '));
    process.on('unhandledRejection', onError);
    t.after(() => { process.off('unhandledRejection', onError); w.close(); });
    for (const name of scripts) w.eval(fs.readFileSync(dir + name, 'utf8'));

    const main = w.document.querySelector('main');
    /** Waits until no request is in flight for a few consecutive ticks. */
    async function settle() {
        for (let quiet = 0, spent = 0; quiet < 4 && spent < 1500; spent++) {
            await tick();
            quiet = state.inflight === 0 ? quiet + 1 : 0;
        }
    }
    async function openTab(hash, attr, tab) {
        // Through the index page, which requests nothing, so that the tab is rendered and loaded afresh.
        w.location.hash = hash.split('/')[0];
        await tick();
        w.location.hash = hash;
        await settle();
        const button = tab && main.querySelector(`.f-tabs [${attr}="${tab}"]`);
        if (button && !button.classList.contains('active')) { button.click(); await settle(); }
    }
    async function tabsOf(hash, attr) {
        w.location.hash = hash;
        await settle();
        return [...main.querySelectorAll(`.f-tabs [${attr}]`)].map((b) => b.getAttribute(attr));
    }
    await settle();
    return { w, main, state, settle, openTab, tabsOf };
}

async function listTabs(page) {
    const list = [];
    for (const [index, attr] of [['#features', 'data-tab'], ['#ai', 'data-ai-tab']]) {
        page.w.location.hash = index;
        await page.settle();
        const rooms = [...page.main.querySelectorAll('.f-index-card')].map((a) => a.getAttribute('href'));
        for (const hash of rooms) {
            const tabs = await page.tabsOf(hash, attr);
            for (const tab of tabs.length ? tabs : [null]) list.push({ hash, attr, tab, where: `${hash}/${tab ?? '-'}` });
        }
    }
    return list;
}

test('live dashboard: every tab loads from the bot, without mock forms or script errors', async (t) => {
    const page = await openDashboard(t);
    const tabs = await listTabs(page);
    assert.equal(tabs.length, 21 + 15 + 1);
    let seenReportChannel = 0;

    for (const { hash, attr, tab, where } of tabs) {
        page.state.reads.length = 0;
        await page.openTab(hash, attr, tab);
        assert.equal(page.main.querySelectorAll(MOCK).length, 0, `${where} renders a mock control`);
        for (const read of page.state.reads) {
            assert.equal(read.status, EXPECTED_READ_ERRORS[read.path] ?? 200, `${where}: GET ${read.path}`);
        }
        const text = page.main.querySelector('.f-content')?.textContent ?? '';
        assert.doesNotMatch(text, /Memuat…|Memeriksa data bot…/, `${where} is still loading`);
        // Live modules catch their own failures and print the message; a script error must not hide in there.
        assert.doesNotMatch(text, /Cannot read|is not a function|is not defined|is not iterable|\[object |\bundefined\b|\bNaN\b/, `${where} shows a script error`);
        // The features index sends managers here for the channel of /report.
        if (hash === '#features/logging' && tab === 'setup') {
            seenReportChannel = page.main.querySelectorAll('.f-content form select[name="reports"]').length;
        }
    }
    assert.equal(seenReportChannel, 1, 'the logging page offers the report channel');
    assert.deepEqual(page.state.errors, []);
});

test('live dashboard: every control of every form changes the request that is sent', async (t) => {
    const page = await openDashboard(t);
    const { w, main, state } = page;
    const tabs = await listTabs(page);

    const forms = () => [...main.querySelectorAll('.f-content form')];
    const controlsOf = (form) => [...form.querySelectorAll('input,select,textarea')].filter((x) => !x.disabled && x.type !== 'file');
    const isId = (x) => /id$/i.test(x.name) || Boolean(x.pattern);
    /** Gives required fields a value that passes the page's own validation. A flipped control is left alone. */
    function fill(form) {
        for (const x of controlsOf(form)) {
            if (x.dataset.flipped || x.type === 'checkbox' || x.type === 'radio') continue;
            if (x.name === 'roleRewards') { if (!x.value) x.value = `5:${SNOWFLAKE}`; continue; }
            if (x.tagName === 'SELECT') { if (!x.value && x.options.length > 1) x.value = x.options[1].value; continue; }
            if (x.value) continue;
            x.value = x.type === 'number' ? '5' : x.type === 'time' ? '18:00' : x.type === 'color' ? '#112233'
                : x.type === 'url' || /image/i.test(x.name) ? 'https://example.com/a.png' : isId(x) ? SNOWFLAKE : 'uji';
        }
    }
    /** Changes one control to another valid value. Returns false if it has no other value to take. */
    function flip(x) {
        x.dataset.flipped = '1';
        if (x.name === 'roleRewards') x.value = `6:${SNOWFLAKE}`;
        else if (x.tagName === 'SELECT') {
            const others = [...x.options].filter((o) => o.value !== x.value && !o.disabled);
            const other = others.find((o) => o.value) ?? others[0];
            if (!other) return false;
            x.value = other.value;
        } else if (x.type === 'checkbox') x.checked = !x.checked;
        else if (x.type === 'number') x.value = String(Number(x.value || 5) + 1);
        else if (x.type === 'time') x.value = '19:30';
        else if (x.type === 'color') x.value = '#445566';
        else if (isId(x)) x.value = '423456789012345679';
        else x.value = (x.value || '') + 'z';
        x.dispatchEvent(new w.Event('input', { bubbles: true }));
        x.dispatchEvent(new w.Event('change', { bubbles: true }));
        return true;
    }
    /** Puts the form into the state in which `control` counts, if it only counts under another choice. */
    function prepare(form, control) {
        for (const [name, value] of Object.entries(CONTEXT[`${form.id}.${control?.name}`] ?? {})) {
            const found = form.elements[name];
            const other = found instanceof w.RadioNodeList ? [...found].find((entry) => !entry.disabled) : found;
            if (other.type === 'checkbox') other.checked = value;
            else other.value = value;
            other.dataset.flipped = '1';
            other.dispatchEvent(new w.Event('change', { bubbles: true }));
        }
    }
    /** Submits form `n` of the open tab and returns everything it caused: writes with bodies, and read URLs. */
    async function submit(n) {
        const form = forms()[n];
        fill(form);
        state.writes.length = 0;
        state.reads.length = 0;
        form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
        await page.settle();
        return JSON.stringify([state.writes, state.reads.map((read) => read.path)]);
    }

    const unsent = [];
    let checked = 0, formCount = 0;
    for (const { hash, attr, tab, where } of tabs) {
        if (COVERED_ELSEWHERE[hash]) continue;
        await page.openTab(hash, attr, tab);
        const shape = forms().map((form, n) => ({ id: form.id || form.getAttribute('data-form-name') || `form${n}`, size: controlsOf(form).length }));
        formCount += shape.length;
        for (const [n, { id, size }] of shape.entries()) {
            for (let i = 0; i < size; i++) {
                // A fresh page for every control, so nothing saved by an earlier flip leaks into the comparison.
                await page.openTab(hash, attr, tab);
                prepare(forms()[n], controlsOf(forms()[n])[i]);
                const before = await submit(n);
                await page.openTab(hash, attr, tab);
                const form = forms()[n];
                const control = controlsOf(form)[i];
                prepare(form, control);
                fill(form);
                const name = `${where} ${id}.${control.name || '#' + control.id}${control.type === 'checkbox' && control.value !== 'on' ? '=' + control.value : ''}`;
                checked++;
                if (process.env.WALK_LIST) console.log(`WALK ${name}`); // lists what was walked, for when the count below changes
                if (!flip(control)) { unsent.push(`${name} (no other value)`); continue; }
                const after = await submit(n);
                if (after === before) unsent.push(name);
            }
        }
    }

    assert.deepEqual(unsent.sort(), Object.keys(NEEDS_PRECONDITION).sort());
    assert.equal(formCount, 37, 'forms on the live dashboard');
    assert.equal(checked, 235, 'controls on the live dashboard');
    assert.deepEqual(state.errors, []);
    const applications = await (await w.fetch('/dashboard/api/bot/applications')).json();
    assert.equal(applications.forms.length, 2, 'no application form was created along the way');
});
