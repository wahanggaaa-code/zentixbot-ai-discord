import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import {
    checkBirthdays,
    getTodaysBirthdays,
    getUpcomingBirthdays,
    setBirthday as serviceSetBirthday,
} from '../src/services/birthdayService.js';
import { setBirthday } from '../src/utils/database.js';
import { movePostgresBirthdayOnLeave } from '../src/services/storage/postgresBirthdays.js';
import { createBirthdayApi } from '../src/dashboard/birthdayApi.js';
import { createDashboardRouter } from '../src/dashboard/router.js';

const guildId = '123456789012345678';
const channelId = '234567890123456789';
const adminId = '345678901234567890';
const clientId = '456789012345678901';
const memberId = '555555555555555555';
const otherId = '666666666666666666';
const botId = '777777777777777777';
const goneId = '888888888888888888';
const enabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
const leftKey = `guild:${guildId}:birthdays:left`;
const utc = (year, month, day, hour = 6) => new Date(Date.UTC(year, month - 1, day, hour));

async function setup(t) {
    const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };
    const admin = new pg.Client(base);
    await admin.connect();
    const schema = `birthday_add_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
        CREATE TABLE "${schema}".guilds(
            id varchar(20) PRIMARY KEY, config jsonb DEFAULT '{}',
            created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
        CREATE TABLE "${schema}".welcome_configs(
            guild_id varchar(20) PRIMARY KEY REFERENCES "${schema}".guilds(id) ON DELETE CASCADE,
            config jsonb NOT NULL DEFAULT '{}', updated_at timestamp DEFAULT now());
        CREATE TABLE "${schema}".users(id varchar(20) PRIMARY KEY);
        CREATE TABLE "${schema}".birthdays(
            guild_id varchar(20), user_id varchar(20), month int, day int,
            updated_at timestamp DEFAULT now(), PRIMARY KEY(guild_id, user_id));
        CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY, value jsonb, expires_at timestamp);
        CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY, value jsonb, expires_at timestamp)`);
    const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 20 });
    t.after(async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });
    const backend = new PostgreSQLDatabase();
    backend.pool = pool;
    backend.isConnected = true;

    const sent = [];
    const channel = {
        id: channelId,
        name: 'birthdays',
        type: ChannelType.GuildText,
        permissionsFor: () => ({ has: () => true }),
        send: async (message) => sent.push(message),
    };
    // Who is in the server right now, as Discord would answer a forced fetch.
    const members = new Map([
        [adminId, { displayName: 'Admin', user: { bot: false } }],
        [memberId, { displayName: '<b>Rina</b>', user: { bot: false } }],
        [otherId, { displayName: 'Budi', user: { bot: false } }],
        [botId, { displayName: 'Helper', user: { bot: true } }],
    ]);
    const fetches = [];
    const guild = {
        id: guildId,
        name: 'Home',
        ownerId: '999999999999999999',
        channels: {
            cache: new Map([[channelId, channel]]),
            fetch: async (id) => (id === channelId ? channel : null),
        },
        members: {
            me: {},
            fetch: async (query) => {
                const id = typeof query === 'string' ? query : query.user;
                fetches.push(query);
                const found = members.get(id);
                if (!found) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
                return {
                    ...found,
                    id,
                    permissions: { has: (p) => p === PermissionFlagsBits.Administrator },
                    roles: { cache: new Map() },
                    toString: () => `<@${id}>`,
                };
            },
        },
    };
    const client = {
        homeGuildId: guildId,
        isReady: () => true,
        guilds: { cache: new Map([[guildId, guild]]) },
        db: {
            db: backend,
            getStatus: () => ({ connectionType: 'postgresql', isDegraded: false }),
            isAvailable: () => Boolean(backend.isAvailable()),
            get: (...args) => backend.get(...args),
            set: (...args) => backend.set(...args),
        },
    };

    const audits = [];
    const audit = async (...args) => {
        audits.push(args.slice(1));
        if (audit.fail) throw new Error('log channel unavailable');
    };
    const auth = (req, res, next) => {
        if (req.get('x-auth') !== 'yes') return res.sendStatus(401);
        req.guild = guild;
        req.session = { user: { id: adminId } };
        next();
    };
    const csrf = (req, res, next) => (req.get('x-csrf') === 'yes' ? next() : res.sendStatus(403));
    const app = express();
    app.use('/test', createBirthdayApi(client, { auth, csrf, audit }));
    const mockFetch = async (url) => ({
        ok: true,
        json: async () => (String(url).endsWith('/token')
            ? { access_token: 'mock', expires_in: 3600 }
            : { id: adminId, username: 'tester' }),
    });
    app.use('/dashboard', createDashboardRouter(client, {
        fetchImpl: mockFetch,
        env: { CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: 'fake', DASHBOARD_URL: 'http://localhost:9999' },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const req = (path, method = 'GET', body, headers = {}) => fetch(`${baseUrl}/test/birthday/${path}`, {
        method,
        headers: { 'x-auth': 'yes', 'x-csrf': 'yes', 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const rows = async () => (await pool.query(
        'SELECT user_id, month, day FROM birthdays ORDER BY user_id',
    )).rows;
    await pool.query('INSERT INTO guilds(id) VALUES($1)', [guildId]);
    return { pool, client, guild, backend, req, baseUrl, rows, members, fetches, audits, audit, sent };
}

const add = (userId, month, day) => ({ userId, month, day, confirmed: true });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('adding a birthday stores it for a current member and audits without the date', { skip: !enabled }, async (t) => {
    const { req, rows, fetches, audits } = await setup(t);

    const response = await req('member', 'POST', add(memberId, 2, 29));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(await rows(), [{ user_id: memberId, month: 2, day: 29 }]);
    // Membership came from Discord, not from the cache.
    assert.deepEqual(fetches.at(-1), { user: memberId, force: true });

    await settle();
    assert.deepEqual(audits, [[guildId, adminId, 'Added', memberId]]);
    assert.doesNotMatch(JSON.stringify(audits), /29/);

    // The new record is listed and can be managed like any other.
    const list = await (await req('list')).json();
    assert.deepEqual(list.birthdays, [{ userId: memberId, month: 2, day: 29 }]);
    assert.deepEqual(list.leapDayFallback, { month: 2, day: 28 });
    const edit = await req(`member/${memberId}`, 'PATCH', {
        expected: { month: 2, day: 29 },
        next: { month: 3, day: 1 },
    });
    assert.equal(edit.status, 200);
    const removal = await req(`member/${memberId}`, 'PATCH', { expected: { month: 3, day: 1 }, next: null });
    assert.equal(removal.status, 200);
    await settle();
    assert.deepEqual(audits.map((entry) => entry[2]), ['Added', 'Updated', 'Removed']);
    assert.deepEqual(await rows(), []);
});

test('adding requires authorization, CSRF, confirmation and an exact valid body', { skip: !enabled }, async (t) => {
    const { req, rows, audits } = await setup(t);
    const body = add(memberId, 5, 10);

    assert.equal((await req('member', 'POST', body, { 'x-auth': 'no' })).status, 401);
    assert.equal((await req('member', 'POST', body, { 'x-csrf': 'no' })).status, 403);
    const invalid = [
        { ...body, confirmed: false },
        { userId: memberId, month: 5, day: 10 },
        { ...body, extra: 1 },
        { ...body, userId: '12345' },
        { ...body, userId: 555555555555555555 },
        { ...body, month: '5' },
        { ...body, month: 13 },
        { ...body, month: 2, day: 30 },
        { ...body, month: 4, day: 31 },
        { ...body, day: 0 },
        { ...body, day: 1.5 },
        [],
        null,
    ];
    for (const bad of invalid) {
        assert.equal((await req('member', 'POST', bad)).status, 400, JSON.stringify(bad));
    }
    await settle();
    assert.deepEqual(await rows(), []);
    assert.deepEqual(audits, []);
});

test('adding is refused for bots, non-members and when Discord cannot confirm membership', { skip: !enabled }, async (t) => {
    const { req, rows, guild, audits } = await setup(t);

    const bot = await req('member', 'POST', add(botId, 5, 10));
    assert.equal(bot.status, 400);
    assert.match((await bot.json()).error, /bot/i);

    assert.equal((await req('member', 'POST', add(goneId, 5, 10))).status, 409);

    const original = guild.members.fetch;
    guild.members.fetch = async () => { throw new Error('Discord down'); };
    assert.equal((await req('member', 'POST', add(memberId, 5, 10))).status, 409);
    // A reply about somebody else is not a confirmation either.
    guild.members.fetch = async () => ({ id: otherId, user: { bot: false } });
    assert.equal((await req('member', 'POST', add(memberId, 5, 10))).status, 409);
    guild.members.fetch = original;

    await settle();
    assert.deepEqual(await rows(), []);
    assert.deepEqual(audits, []);
});

test('adding never replaces an existing date, a leave backup or legacy data', { skip: !enabled }, async (t) => {
    const { req, rows, pool, client } = await setup(t);

    // Existing record, set by the member through the bot.
    assert.equal(await setBirthday(client, guildId, memberId, 1, 5), true);
    const exists = await req('member', 'POST', add(memberId, 3, 3));
    assert.equal(exists.status, 409);
    assert.match((await exists.json()).error, /sudah memiliki tanggal/);
    assert.deepEqual(await rows(), [{ user_id: memberId, month: 1, day: 5 }]);

    // A backup written when the member left may hold a different date.
    assert.equal(await movePostgresBirthdayOnLeave(client, guildId, memberId), true);
    assert.deepEqual(await rows(), []);
    assert.equal((await req('member', 'POST', add(memberId, 3, 3))).status, 409);
    assert.deepEqual(await rows(), []);
    const backup = (await pool.query('SELECT value FROM temp_data WHERE key=$1', [leftKey])).rows[0].value;
    assert.deepEqual(backup, { [memberId]: { month: 1, day: 5 } });

    // Somebody else is not blocked by that backup.
    assert.equal((await req('member', 'POST', add(otherId, 3, 3))).status, 200);

    // Legacy keys make the stored data ambiguous: refuse.
    await pool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)', [`birthdays:${guildId}`, '{}']);
    await pool.query('DELETE FROM temp_data WHERE key=$1', [leftKey]);
    assert.equal((await req('member', 'POST', add(memberId, 3, 3))).status, 409);
    assert.deepEqual(await rows(), [{ user_id: otherId, month: 3, day: 3 }]);
});

test('concurrent adds for one member store exactly one date', { skip: !enabled }, async (t) => {
    const { req, rows, audits } = await setup(t);

    const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, i) => req('member', 'POST', add(memberId, 6, i + 1))),
    );
    const statuses = attempts.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    assert.equal(statuses.filter((status) => status === 409).length, 11);

    const stored = await rows();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].day, statuses.indexOf(200) + 1, 'the stored date is the one that was acknowledged');
    await settle();
    assert.equal(audits.length, 1);
});

test('an add racing a bot-side set never overwrites the member\'s own date', { skip: !enabled }, async (t) => {
    const { req, rows, client, pool } = await setup(t);

    for (let round = 0; round < 6; round++) {
        await pool.query('DELETE FROM birthdays');
        const [web, bot] = await Promise.all([
            req('member', 'POST', add(memberId, 3, 3)),
            setBirthday(client, guildId, memberId, 9, 9),
        ]);
        assert.equal(bot, true);
        assert.ok([200, 409].includes(web.status));
        // /birthday set always wins: it is the member's own statement.
        assert.deepEqual(await rows(), [{ user_id: memberId, month: 9, day: 9 }]);
    }
});

test('a database outage or a failing audit log is reported honestly', { skip: !enabled }, async (t) => {
    const { req, rows, backend, audit } = await setup(t);

    audit.fail = true;
    assert.equal((await req('member', 'POST', add(memberId, 5, 10))).status, 200, 'audit failure does not undo the save');
    assert.deepEqual(await rows(), [{ user_id: memberId, month: 5, day: 10 }]);

    backend.isConnected = false;
    assert.equal((await req('member', 'POST', add(otherId, 5, 10))).status, 503);
    assert.equal((await req(`member/${otherId}`)).status, 503);
    backend.isConnected = true;
    assert.deepEqual(await rows(), [{ user_id: memberId, month: 5, day: 10 }]);
});

test('member lookup identifies the account without revealing the date', { skip: !enabled }, async (t) => {
    const { req, client } = await setup(t);
    assert.equal(await setBirthday(client, guildId, otherId, 7, 21), true);

    const fresh = await req(`member/${memberId}`);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await fresh.json(), {
        userId: memberId,
        name: '<b>Rina</b>',
        bot: false,
        hasBirthday: false,
        leapDayFallback: { month: 2, day: 28 },
    });

    const existing = await (await req(`member/${otherId}`)).json();
    assert.equal(existing.hasBirthday, true);
    assert.equal('month' in existing || 'day' in existing, false);
    assert.equal((await (await req(`member/${botId}`)).json()).bot, true);

    assert.equal((await req(`member/${goneId}`)).status, 409);
    assert.equal((await req('member/abc')).status, 400);
    assert.equal((await req(`member/${memberId}?x=1`)).status, 400);
    assert.equal((await req(`member/${memberId}`, 'GET', undefined, { 'x-auth': 'no' })).status, 401);
});

test('the real dashboard router enforces login, origin and CSRF on add and lookup', { skip: !enabled }, async (t) => {
    const { baseUrl, rows } = await setup(t);
    const request = (path, options = {}) => fetch(baseUrl + path, { redirect: 'manual', ...options });
    const addPath = '/dashboard/api/bot/birthday/member';
    const json = { 'content-type': 'application/json' };
    const body = JSON.stringify(add(memberId, 5, 10));

    // Not logged in.
    assert.equal((await request(`${addPath}/${memberId}`)).status, 401);
    assert.equal((await request(addPath, { method: 'POST', headers: json, body })).status, 401);

    const start = await request('/dashboard/login');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/dashboard/callback?code=mock&state=${state}`, {
        headers: { cookie: stateCookie },
    });
    const cookie = callback.headers.getSetCookie().find((x) => x.startsWith('zx_session=')).split(';')[0];
    const me = await (await request('/dashboard/api/me', { headers: { cookie } })).json();

    const post = (origin, token) => request(addPath, {
        method: 'POST',
        headers: { ...json, cookie, origin, 'x-csrf-token': token },
        body,
    });
    assert.equal((await post('http://evil.example', me.csrf)).status, 403);
    assert.equal((await post('http://localhost:9999', 'wrong')).status, 403);
    assert.deepEqual(await rows(), []);

    assert.equal((await request(`${addPath}/${memberId}`, { headers: { cookie } })).status, 200);
    assert.equal((await post('http://localhost:9999', me.csrf)).status, 200);
    assert.deepEqual(await rows(), [{ user_id: memberId, month: 5, day: 10 }]);
});

test('/birthday set accepts 29 February in a non-leap year and rejects impossible dates', { skip: !enabled }, async (t) => {
    const { client, rows } = await setup(t);

    // The sandbox clock is in 2026, a year without 29 February.
    const result = await serviceSetBirthday(client, guildId, memberId, 2, 29);
    assert.deepEqual(result.data, { month: 2, day: 29, monthName: 'February' });
    assert.deepEqual(await rows(), [{ user_id: memberId, month: 2, day: 29 }]);

    await assert.rejects(serviceSetBirthday(client, guildId, otherId, 2, 30), /Invalid date/);
    await assert.rejects(serviceSetBirthday(client, guildId, otherId, 4, 31), /Invalid date/);
    assert.equal((await rows()).length, 1);
});

test('the daily check announces a 29 February birthday once per year, on the documented day', { skip: !enabled }, async (t) => {
    const { client, req, sent } = await setup(t);
    assert.equal((await req('settings', 'PATCH', { channelId, expectedChannelId: null })).status, 200);
    assert.equal(await setBirthday(client, guildId, memberId, 2, 29), true);
    assert.equal(await setBirthday(client, guildId, otherId, 2, 28), true);

    const announcedOn = async (date) => {
        sent.length = 0;
        await checkBirthdays(client, date);
        return sent.map((message) => message.embeds[0].description).join(' ');
    };
    const leap = new RegExp(memberId);
    const ordinary = new RegExp(otherId);

    // 2027 has no 29 February: both are announced on the 28th, nobody on 1 March.
    assert.equal(await announcedOn(utc(2027, 2, 27)), '');
    const fallbackDay = await announcedOn(utc(2027, 2, 28));
    assert.match(fallbackDay, leap);
    assert.match(fallbackDay, ordinary);
    assert.equal(await announcedOn(utc(2027, 3, 1)), '');

    // 2028 has it: the 28th is for the ordinary birthday only.
    const before = await announcedOn(utc(2028, 2, 28));
    assert.match(before, ordinary);
    assert.doesNotMatch(before, leap);
    const realDay = await announcedOn(utc(2028, 2, 29));
    assert.match(realDay, leap);
    assert.doesNotMatch(realDay, ordinary);
    assert.equal(await announcedOn(utc(2028, 3, 1)), '');
});

test('today and upcoming agree with the daily check', { skip: !enabled }, async (t) => {
    const { client } = await setup(t);
    assert.equal(await setBirthday(client, guildId, memberId, 2, 29), true);
    assert.equal(await setBirthday(client, guildId, otherId, 3, 1), true);

    // Late on 28 February 2027 UTC: the leap-day birthday is today.
    const late = new Date('2027-02-28T23:30:00Z');
    assert.deepEqual((await getTodaysBirthdays(client, guildId, late)).map((b) => b.userId), [memberId]);
    const upcoming = await getUpcomingBirthdays(client, guildId, 5, late);
    assert.deepEqual(
        upcoming.map((b) => [b.userId, b.month, b.day, b.daysUntil]),
        [[memberId, 2, 29, 0], [otherId, 3, 1, 1]],
    );

    // One day later it is the other member's turn; leap day is next seen in 2028.
    const next = new Date('2027-03-01T00:10:00Z');
    assert.deepEqual((await getTodaysBirthdays(client, guildId, next)).map((b) => b.userId), [otherId]);
    const later = await getUpcomingBirthdays(client, guildId, 5, next);
    assert.deepEqual(later.map((b) => [b.userId, b.daysUntil]), [[otherId, 0], [memberId, 365]]);
    assert.equal(later[1].date.toISOString(), '2028-02-29T00:00:00.000Z');
});
