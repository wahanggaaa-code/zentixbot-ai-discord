// The web server's request limits and the dashboard login, as a browser on a real host meets them:
// one page view fetches every file of the dashboard, a login can be opened twice, and the callback
// can arrive without its cookie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { createDashboardRouter } from '../src/dashboard/router.js';
import { callbackProblem, loginProblemPage } from '../src/dashboard/loginProblem.js';
import { createFixedWindowCounter, createWebRateLimit, webRateLimitBucket, WEB_RATE_LIMITS } from '../src/utils/webRateLimit.js';

const home = '123456789012345678';
const userId = '323456789012345678';
const ORIGIN = 'http://203.0.113.5:11991';
const MINUTE = 60 * 1000;

const indexHtml = readFileSync(new URL('../dashboard-preview/index.html', import.meta.url), 'utf8');
const pageFiles = [...indexHtml.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((match) => match[1]).filter((file) => !/^[a-z]+:|^\/\//i.test(file));

/** The web server as src/app.js builds it: limits first, then the dashboard, then the bot's own routes. */
async function site(t, { limits = {}, env = {} } = {}) {
    const clock = { now: Date.now() };
    const guild = {
        id: home, name: 'Home', ownerId: '999999999999999999',
        members: { fetch: async () => ({ permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator } }) },
    };
    const client = { homeGuildId: home, isReady: () => true, guilds: { cache: new Map([[home, guild]]) } };
    const fetchImpl = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/token') ? { access_token: 'mock', expires_in: 3600 } : { id: userId, username: 'tester' }) });
    const app = express();
    app.use(createWebRateLimit({ ...limits, now: () => clock.now }));
    app.use('/dashboard', createDashboardRouter(client, { fetchImpl, env: { CLIENT_ID: '456789012345678901', DISCORD_CLIENT_SECRET: 'secret', DASHBOARD_URL: ORIGIN, DASHBOARD_ALLOW_HTTP: 'true', ...env } }));
    app.get('/health', (req, res) => res.json({ status: 'healthy' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
    const begin = async (cookie) => {
        const start = await req('/dashboard/login', cookie ? { headers: { cookie } } : {});
        assert.equal(start.status, 302);
        const setCookie = start.headers.get('set-cookie');
        return { state: new URL(start.headers.get('location')).searchParams.get('state'), cookie: setCookie.split(';')[0], setCookie };
    };
    const finish = (state, cookie, query = 'code=mock') => req(`/dashboard/callback?${query}&state=${state}`, cookie ? { headers: { cookie } } : {});
    const login = async () => {
        const started = await begin();
        const callback = await finish(started.state, started.cookie);
        assert.equal(callback.status, 302);
        return callback.headers.getSetCookie().find((line) => line.startsWith('zx_session=')).split(';')[0];
    };
    return { req, begin, finish, login, clock };
}

// ---------------------------------------------------------------------------------------------
// Request limits
// ---------------------------------------------------------------------------------------------

test('the dashboard can be opened ten times within a minute without being refused', async (t) => {
    assert.ok(pageFiles.length >= 20, `index.html should reference the dashboard files, found ${pageFiles.length}`);
    const { req, login } = await site(t);
    const session = await login();
    for (let view = 1; view <= 10; view += 1) {
        const responses = await Promise.all([
            req('/dashboard/', { headers: { cookie: session } }),
            req('/dashboard/api/me', { headers: { cookie: session } }),
            ...pageFiles.map((file) => req(`/dashboard/${file}`, { headers: { cookie: session } })),
        ]);
        const refused = responses.filter((response) => response.status !== 200).map((response) => `${response.status} ${response.url}`);
        assert.deepEqual(refused, [], `page view ${view}`);
        await Promise.all(responses.map((response) => response.arrayBuffer()));
    }
});

test('the dashboard budget is finite, tells how long to wait, and opens again after its window', async (t) => {
    const { req, login, clock } = await site(t, { limits: { dashboard: { windowMs: MINUTE, max: 5 } } });
    const session = await login();
    for (let i = 0; i < 5; i += 1) assert.equal((await req('/dashboard/style.css')).status, 200);

    const page = await req('/dashboard/', { headers: { cookie: session } });
    assert.equal(page.status, 429);
    assert.equal(page.headers.get('retry-after'), '60');
    assert.match(page.headers.get('content-type'), /^text\/plain/);
    assert.equal(await page.text(), 'Terlalu banyak permintaan ke dashboard dari alamat ini. Coba lagi dalam 1 menit.');

    clock.now += 20 * 1000;
    const api = await req('/dashboard/api/me', { headers: { cookie: session } });
    assert.equal(api.status, 429);
    assert.equal(api.headers.get('retry-after'), '40');
    assert.deepEqual(await api.json(), { error: 'Terlalu banyak permintaan ke dashboard dari alamat ini. Coba lagi dalam 40 detik.' });
    // Express reaches the API whatever the letter case, so the answer is JSON there as well.
    const shouted = await req('/Dashboard/API/me', { headers: { cookie: session } });
    assert.equal(shouted.status, 429);
    assert.match(shouted.headers.get('content-type'), /^application\/json/);

    // Refused requests do not push the end of the window further away.
    clock.now += 40 * 1000;
    assert.equal((await req('/dashboard/api/me', { headers: { cookie: session } })).status, 200);
});

test('login attempts have their own tight budget, and spelling the path differently does not escape it', async (t) => {
    const { req, login, clock } = await site(t);
    const session = await login(); // two of the thirty: /login and /callback
    for (let i = 0; i < WEB_RATE_LIMITS.login.max - 2; i += 1) assert.equal((await req('/dashboard/login')).status, 302, `login ${i + 3}`);

    for (const path of ['/dashboard/login', '/dashboard/LOGIN', '/Dashboard/login/', '/dashboard/callback?code=x&state=y', '/dashboard/Callback/']) {
        const refused = await req(path);
        assert.equal(refused.status, 429, path);
        assert.equal(refused.headers.get('retry-after'), '900', path);
        assert.equal(await refused.text(), 'Terlalu banyak percobaan login dari alamat ini. Coba lagi dalam 15 menit.', path);
    }

    clock.now += 100 * 1000;
    const later = await req('/dashboard/login');
    assert.equal(later.headers.get('retry-after'), '800');
    assert.equal(await later.text(), 'Terlalu banyak percobaan login dari alamat ini. Coba lagi dalam 14 menit.', 'minutes are rounded up');
    clock.now -= 100 * 1000;

    // Someone already signed in keeps working, and the bot's own routes are counted apart as well.
    assert.equal((await req('/dashboard/', { headers: { cookie: session } })).status, 200);
    assert.equal((await req('/dashboard/api/me', { headers: { cookie: session } })).status, 200);
    assert.equal((await req('/health')).status, 200);

    clock.now += WEB_RATE_LIMITS.login.windowMs;
    assert.equal((await req('/dashboard/login')).status, 302);
});

test('paths outside the dashboard keep the configured limit and its English JSON answer', async (t) => {
    const { req, login, clock } = await site(t, { limits: { general: { windowMs: 5 * MINUTE, max: 3 } } });
    for (let i = 0; i < 3; i += 1) assert.equal((await req('/health')).status, 200);
    const refused = await req('/health');
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '300');
    assert.deepEqual(await refused.json(), { error: 'Too many requests' });
    assert.equal((await req('/nothing-here')).status, 429);

    const session = await login();
    assert.equal((await req('/dashboard/', { headers: { cookie: session } })).status, 200);

    clock.now += 5 * MINUTE;
    assert.equal((await req('/health')).status, 200);
});

test('each path is counted against the budget of the route it reaches', () => {
    const expected = {
        '/dashboard/login': 'login', '/dashboard/callback': 'login', '/DASHBOARD/Login': 'login', '/dashboard/login/': 'login', '/dashboard/callback//': 'login',
        '/dashboard': 'dashboard', '/dashboard/': 'dashboard', '/Dashboard/app.js': 'dashboard', '/dashboard/api/me': 'dashboard',
        '/dashboard/login/extra': 'dashboard', '/dashboard/loginx': 'dashboard', '/dashboard/api/login': 'dashboard',
        '/': 'general', '/health': 'general', '/ready': 'general', '/dashboardx': 'general', '/x/dashboard/login': 'general', '': 'general',
    };
    for (const [path, bucket] of Object.entries(expected)) assert.equal(webRateLimitBucket(path), bucket, JSON.stringify(path));
    assert.equal(webRateLimitBucket(undefined), 'general');
});

test('the counter is per address, lets exactly max requests through, and forgets addresses whose window ended', () => {
    let now = 1_000_000;
    const counter = createFixedWindowCounter({ windowMs: 1000, max: 2, now: () => now });
    assert.deepEqual(counter.hit('a'), { allowed: true, retryAfterSeconds: 0 });
    assert.deepEqual(counter.hit('a'), { allowed: true, retryAfterSeconds: 0 });
    assert.deepEqual(counter.hit('a'), { allowed: false, retryAfterSeconds: 1 });
    assert.deepEqual(counter.hit('b'), { allowed: true, retryAfterSeconds: 0 });

    now += 999;
    assert.deepEqual(counter.hit('a'), { allowed: false, retryAfterSeconds: 1 }, 'one millisecond before the window ends');
    now += 1;
    assert.deepEqual(counter.hit('a'), { allowed: true, retryAfterSeconds: 0 }, 'exactly when the window ends');
    assert.equal(counter.size, 1, 'the window of b ended and b did not come back');

    // A window that began shortly before a clean-up survives it, and ends on its own time.
    now = 0;
    const late = createFixedWindowCounter({ windowMs: 1000, max: 1, now: () => now });
    now = 500;
    assert.equal(late.hit('late').allowed, true);
    now = 1000;
    assert.equal(late.hit('other').allowed, true, 'this request triggers the clean-up');
    assert.deepEqual(late.hit('late'), { allowed: false, retryAfterSeconds: 1 });
    now = 1499;
    assert.equal(late.hit('late').allowed, false);
    now = 1500;
    assert.equal(late.hit('late').allowed, true, 'no clean-up happened in between');
    now = 1_000_000;

    // The wait is rounded up to whole seconds.
    const slow = createFixedWindowCounter({ windowMs: 90_500, max: 1, now: () => now });
    slow.hit('a');
    assert.equal(slow.hit('a').retryAfterSeconds, 91);
    now += 500;
    assert.equal(slow.hit('a').retryAfterSeconds, 90);

    // Many addresses that each came once do not accumulate.
    const crowd = createFixedWindowCounter({ windowMs: 1000, max: 2, now: () => now });
    for (let i = 0; i < 500; i += 1) { crowd.hit(`ip-${i}`); now += 10; }
    assert.ok(crowd.size <= 200, `kept ${crowd.size} addresses`);
});

test('unusable limit numbers fall back to the defaults instead of switching the limit off', async (t) => {
    for (const general of [undefined, {}, { windowMs: 0, max: 0 }, { windowMs: 'x', max: 2.5 }, { windowMs: -1, max: -1 }, { windowMs: Infinity, max: NaN }]) {
        let now = 5_000_000;
        const limit = createWebRateLimit({ general, login: general, dashboard: general, now: () => now });
        const count = (path) => {
            let passed = 0, status = null, retry = null;
            const res = { set: (name, value) => { retry = value; }, status: (code) => { status = code; return res; }, json: () => res, type: () => res, send: () => res };
            for (let i = 0; i < 1000; i += 1) limit({ path, ip: '198.51.100.7' }, res, () => { passed += 1; });
            return { passed, status, retry };
        };
        assert.deepEqual(count('/health'), { passed: 100, status: 429, retry: '900' }, JSON.stringify(general));
        assert.deepEqual(count('/dashboard/login'), { passed: 30, status: 429, retry: '900' }, JSON.stringify(general));
        assert.deepEqual(count('/dashboard/app.js'), { passed: 600, status: 429, retry: '60' }, JSON.stringify(general));
    }
    assert.deepEqual(WEB_RATE_LIMITS, { login: { windowMs: 15 * MINUTE, max: 30 }, dashboard: { windowMs: MINUTE, max: 600 }, general: { windowMs: 15 * MINUTE, max: 100 } });
    t.diagnostic(`one page view fetches ${pageFiles.length + 1} files; the dashboard budget is ${WEB_RATE_LIMITS.dashboard.max} per minute`);
});

test('each client address has its own count, and a request without an address is still counted', () => {
    const limit = createWebRateLimit({ general: { windowMs: MINUTE, max: 1 } });
    const passed = [];
    let refusals = 0;
    const res = { set: () => {}, status: (code) => { assert.equal(code, 429); refusals += 1; return res; }, json: () => res };
    const visit = (ip) => limit({ path: '/', ip }, res, () => passed.push(ip));
    visit('198.51.100.7'); visit('198.51.100.8'); visit('198.51.100.7'); visit('198.51.100.8');
    assert.deepEqual(passed, ['198.51.100.7', '198.51.100.8']);
    assert.equal(refusals, 2);

    visit(undefined); visit('');
    assert.deepEqual(passed, ['198.51.100.7', '198.51.100.8', undefined]);
    assert.equal(refusals, 3);
});

test('the web server applies the limits before the dashboard and the bot routes', () => {
    const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
    const limit = source.indexOf('app.use(createWebRateLimit({ general: this.config.api?.rateLimit }));');
    assert.ok(limit > 0, 'createWebRateLimit is installed with the configured general limit');
    for (const route of ["app.use('/dashboard', createDashboardRouter(this));", "app.get('/health'", "app.get('/ready'", "app.get('/', "]) {
        assert.ok(source.indexOf(route) > limit, `${route} comes after the limit`);
    }
    assert.equal(source.includes('requestCounts'), false, 'the old single limiter is gone');
});

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

const problemText = async (response) => {
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    assert.match(html, /<a href="\/dashboard\/login">Mulai login lagi<\/a>/);
    assert.match(html, /<meta name="viewport"/);
    return html.match(/<p>(.*?)<\/p>/)[1];
};

test('a callback that cannot finish the login says which of the causes it was', async (t) => {
    const { req, begin, finish } = await site(t);

    assert.equal(await problemText(await req('/dashboard/callback?code=mock')), 'Alamat ini tidak lengkap. Halaman ini hanya dibuka oleh Discord setelah kamu menekan Authorize.');
    assert.match(await problemText(await req('/dashboard/callback?code=mock&state=a&state=b')), /^Alamat ini tidak lengkap\./);

    assert.match(await problemText(await finish('f'.repeat(64), `zx_state=${'f'.repeat(64)}`)), /^Login ini sudah tidak berlaku\. .*dimuat ulang.*10 menit.*bot restart/);

    const elsewhere = await begin();
    assert.equal(
        await problemText(await finish(elsewhere.state, null)),
        `Browser ini tidak mengirim cookie login. Biasanya karena login dimulai di browser lain atau di tab private, dashboard dibuka lewat alamat selain ${ORIGIN}, atau browser memblokir cookie untuk alamat ini.`,
    );

    const first = await begin();
    const second = await begin();
    assert.notEqual(first.state, second.state);
    assert.equal(await problemText(await finish(first.state, second.cookie)), 'Ada login lain yang dimulai lebih baru di browser ini, sehingga login yang ini tidak dipakai lagi.');

    const cancelled = await begin();
    assert.equal(await problemText(await finish(cancelled.state, cancelled.cookie, 'error=access_denied&error_description=x')), 'Login dibatalkan di halaman Discord.');

    const noCode = await begin();
    assert.match(await problemText(await req(`/dashboard/callback?state=${noCode.state}`, { headers: { cookie: noCode.cookie } })), /^Alamat ini tidak lengkap\./);
    const longCode = await begin();
    assert.match(await problemText(await finish(longCode.state, longCode.cookie, `code=${'c'.repeat(2049)}`)), /^Alamat ini tidak lengkap\./);
    const longestCode = await begin();
    assert.equal((await finish(longestCode.state, longestCode.cookie, `code=${'c'.repeat(2048)}`)).status, 302);
});

test('only the browser that began a login can spend it', async (t) => {
    const { begin, finish } = await site(t);

    // Something else opens the callback address first: a link preview, or another browser.
    const mine = await begin();
    const other = await begin();
    for (const cookie of [null, 'theme=dark', 'zx_state=', other.cookie]) {
        const refused = await finish(mine.state, cookie);
        assert.equal(refused.status, 400);
        assert.deepEqual(refused.headers.getSetCookie(), [], 'neither a session nor a change to the state cookie');
    }
    assert.equal((await finish(mine.state, mine.cookie)).status, 302, 'the login is still there for its own browser');
    assert.equal((await finish(other.state, other.cookie)).status, 302, 'and so is the other one');

    // The own browser spends its login even when the attempt fails, and its cookie is cleared.
    const cancelled = await begin();
    const refused = await finish(cancelled.state, cancelled.cookie, 'error=access_denied');
    assert.equal(refused.status, 400);
    const cookies = refused.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.match(cookies[0], /^zx_state=;.*Path=\/dashboard/);
    assert.match(await problemText(await finish(cancelled.state, cancelled.cookie)), /^Login ini sudah tidak berlaku\./);

    // A stale cookie for a login the server no longer holds is cleared as well.
    const stale = await finish('e'.repeat(64), `zx_state=${'e'.repeat(64)}`);
    assert.match(stale.headers.getSetCookie()[0], /^zx_state=;/);
});

test('opening the login a second time in the same browser keeps the login begun first working', async (t) => {
    const { begin, finish } = await site(t);
    const first = await begin();
    assert.match(first.setCookie, /Max-Age=600;/);
    const again = await begin(`theme=dark; ${first.cookie}`);
    assert.equal(again.state, first.state, 'the pending state is reused');
    assert.equal(again.cookie, first.cookie);
    const maxAge = Number(again.setCookie.match(/Max-Age=(\d+)/)[1]);
    assert.ok(maxAge > 590 && maxAge <= 600, `the cookie does not outlive the state, Max-Age=${maxAge}`);

    assert.notEqual((await begin()).state, first.state, 'another browser gets its own state');
    assert.notEqual((await begin(`zx_state=${'0'.repeat(64)}`)).state, '0'.repeat(64), 'a state the server never issued is not adopted');
    assert.notEqual((await begin('zx_state=')).state, '');

    assert.equal((await finish(first.state, first.cookie)).status, 302);
    assert.notEqual((await begin(first.cookie)).state, first.state, 'a spent state is not handed out again');
});

test('when 5000 logins are pending, new ones are refused but a browser already waiting is not', async (t) => {
    const { req, begin, finish } = await site(t, { limits: { login: { windowMs: MINUTE, max: 100000 } } });
    const waiting = await begin();
    for (let done = 1; done < 5000; done += 100) await Promise.all(Array.from({ length: Math.min(100, 5000 - done) }, () => begin()));

    const refused = await req('/dashboard/login');
    assert.equal(refused.status, 503);
    assert.equal(await refused.text(), 'Terlalu banyak login yang menunggu.');
    assert.equal(refused.headers.get('set-cookie'), null);

    assert.equal((await begin(waiting.cookie)).state, waiting.state);
    assert.equal((await finish(waiting.state, waiting.cookie)).status, 302);
    assert.equal((await req('/dashboard/login')).status, 302, 'the finished login freed a place');
    assert.equal((await req('/dashboard/login')).status, 503);
});

test('a pending state is reused only until it expires, and the cookie expires with it', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { begin, finish } = await site(t);
    const first = await begin();

    t.mock.timers.tick(4 * MINUTE);
    const later = await begin(first.cookie);
    assert.equal(later.state, first.state);
    assert.match(later.setCookie, /Max-Age=360;/, 'six minutes are left');

    t.mock.timers.tick(6 * MINUTE - 1);
    const lastMoment = await begin(first.cookie);
    assert.equal(lastMoment.state, first.state);
    assert.match(lastMoment.setCookie, /Max-Age=1;/);

    t.mock.timers.tick(2);
    const fresh = await begin(first.cookie);
    assert.notEqual(fresh.state, first.state, 'ten minutes passed');
    assert.match(fresh.setCookie, /Max-Age=600;/);
    assert.match(await problemText(await finish(first.state, first.cookie)), /^Login ini sudah tidak berlaku\./);
    assert.equal((await finish(fresh.state, fresh.cookie)).status, 302);
});

test('reloading the callback after a finished login leads to the dashboard, not to an error', async (t) => {
    const { req, begin, finish } = await site(t);
    const started = await begin();
    const done = await finish(started.state, started.cookie);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), '/dashboard/');
    const session = done.headers.getSetCookie().find((line) => line.startsWith('zx_session=')).split(';')[0];

    const reloaded = await finish(started.state, session);
    assert.equal(reloaded.status, 302);
    assert.equal(reloaded.headers.get('location'), '/dashboard/');
    assert.equal(reloaded.headers.getSetCookie().some((line) => line.startsWith('zx_session=')), false, 'no new session is issued');

    // Without the session the same reload is an error, and so is an invented session.
    assert.match(await problemText(await finish(started.state, null)), /^Login ini sudah tidak berlaku\./);
    assert.match(await problemText(await finish(started.state, `zx_session=${'a'.repeat(64)}`)), /^Login ini sudah tidak berlaku\./);
    assert.match(await problemText(await req('/dashboard/callback', { headers: { cookie: 'zx_session=' } })), /^Alamat ini tidak lengkap\./);
});

test('a dashboard whose login is not configured says so on the callback as well', async (t) => {
    const { req } = await site(t, { env: { DASHBOARD_ALLOW_HTTP: '' } });
    const response = await req('/dashboard/callback?code=mock&state=x');
    assert.equal(response.status, 503);
    assert.match(await response.text(), /^Login belum dikonfigurasi: DASHBOARD_URL memakai http:\/\//);
});

test('the reasons are decided in a fixed order and the page escapes what it shows', () => {
    const fine = { state: 's', known: true, sent: 's', code: 'c', denied: false };
    assert.equal(callbackProblem(fine), null);
    assert.equal(callbackProblem({ ...fine, state: ['s'] }), 'incomplete');
    assert.equal(callbackProblem({ ...fine, state: undefined, known: false, sent: undefined }), 'incomplete');
    assert.equal(callbackProblem({ ...fine, known: false, sent: undefined, denied: true }), 'spent');
    assert.equal(callbackProblem({ ...fine, sent: undefined, denied: true }), 'no_cookie');
    assert.equal(callbackProblem({ ...fine, sent: '', denied: true }), 'no_cookie');
    assert.equal(callbackProblem({ ...fine, sent: 'x', denied: true }), 'other_login');
    assert.equal(callbackProblem({ ...fine, denied: true }), 'denied');
    assert.equal(callbackProblem({ ...fine, code: undefined }), 'incomplete');
    assert.equal(callbackProblem({ ...fine, code: ['c'] }), 'incomplete');

    const html = loginProblemPage('no_cookie', `http://x"><script>alert('1')</script>&`);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /selain http:\/\/x&#34;&#62;&#60;script&#62;alert\(&#39;1&#39;\)&#60;\/script&#62;&#38;,/);
    for (const problem of ['incomplete', 'spent', 'no_cookie', 'other_login', 'denied']) assert.match(loginProblemPage(problem, ORIGIN), /^<!doctype html><html lang="id">/);
});
