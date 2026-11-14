// Scheduled AI Activities rounds: a check that fails or is missed at the scheduled minute must not cost the
// day's round, and no fault may produce a second round. Runs on a real SQLite file and, when the local test
// server is available, on PostgreSQL. Discord and the AI provider are stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import pg from 'pg';
import { ChannelType } from 'discord.js';
import { DEFAULT_ACTIVITY, SCHEDULE_LATE_MINUTES, createActivityStore, runScheduledActivity, saveActivitySettings, scheduleMatches, startActivity } from '../src/services/ai/activities.js';
import { createAIApi } from '../src/dashboard/aiApi.js';
import { openSQLiteStore } from '../src/services/storage/sqlite.js';

const GUILD = '123456789012345678', BOT = '999999999999999999', OWNER = '234567890123456789', CHANNEL = '456789012345678901';
const pgEnabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
// 18:00 WIB on Thursday 12 November 2026.
const AT = Date.parse('2026-11-12T11:00:00Z');
const minute = (n) => new Date(AT + n * 60000);
const SCHEDULED = { ...DEFAULT_ACTIVITY, enabled: true, channelId: CHANNEL, duration: 60, scheduleEnabled: true, scheduleTime: '18:00', scheduleDays: 'everyday', timeZone: 'WIB' };
const QUIZ = { question: 'Planet merah?', options: ['Venus', 'Mars', 'Bumi', 'Jupiter'], answer: 1 };
const connectionLost = () => new Error('Connection terminated unexpectedly');

/** One guild with one text channel, the bot's client, and a store on the chosen database. */
async function world(t, backend) {
    const sent = [];
    const channel = {
        id: CHANNEL, name: 'kuis', type: ChannelType.GuildText, failSend: 0,
        permissionsFor: () => ({ has: () => true }),
        send: async (payload) => {
            if (channel.failSend > 0) { channel.failSend -= 1; sent.push({ failed: true }); throw new Error('Discord did not answer'); }
            sent.push(payload);
            return { id: '567890123456789012', edit: async () => {} };
        },
    };
    const guild = { id: GUILD, channels: { cache: new Map([[CHANNEL, channel]]) }, members: { me: {} } };
    const client = { homeGuildId: GUILD, user: { id: BOT }, guilds: { cache: new Map([[GUILD, guild]]) } };
    const generated = [];
    client.aiFoundation = { generate: async (request) => { generated.push(request); return { text: JSON.stringify(QUIZ) }; } };
    if (backend === 'sqlite') {
        const dir = mkdtempSync(join(tmpdir(), 'zentix-activity-'));
        const sqlite = await openSQLiteStore({ path: join(dir, 'data.db') });
        t.after(() => { if (sqlite.isOpen()) sqlite.close(); rmSync(dir, { recursive: true, force: true }); });
        client.db = { getStatus: () => ({ isDegraded: false }), isAvailable: () => true, db: { sqlite, isAvailable: () => true } };
    } else {
        const schema = `activity_schedule_${randomBytes(6).toString('hex')}`, config = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };
        const admin = new pg.Client(config);
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await admin.query(`CREATE TABLE "${schema}".cache_data (key text primary key, value jsonb not null)`);
        const pool = new pg.Pool({ ...config, max: 5, options: `-c search_path=${schema}` });
        t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
        // The bot's pool, with a switch that makes the next queries fail the way a dropped connection does.
        const faults = { query: 0, connect: 0 };
        const flaky = {
            query: (...args) => (faults.query > 0 ? (faults.query -= 1, Promise.reject(connectionLost())) : pool.query(...args)),
            connect: () => (faults.connect > 0 ? (faults.connect -= 1, Promise.reject(connectionLost())) : pool.connect()),
        };
        client.db = { getStatus: () => ({ isDegraded: false }), isAvailable: () => true, db: { isAvailable: () => true, pool: flaky } };
        client.faults = faults;
    }
    const store = createActivityStore(client);
    await store.save(GUILD, SCHEDULED);
    // What the bot does every minute; a failure is caught by the task runner and the next minute runs again.
    const errors = [];
    const tick = async (when, use = store) => {
        try { return await runScheduledActivity(client, { store: use, now: when instanceof Date ? when : minute(when) }); }
        catch (error) { errors.push(error); return 'failed'; }
    };
    const rounds = () => sent.filter((payload) => !payload.failed).length;
    return { client, guild, channel, store, sent, generated, tick, rounds, errors };
}
/** The store with one method that fails `times` times before it works again. */
const failing = (store, method, times, make = connectionLost) => {
    const left = { n: times };
    return { ...store, [method]: async (...args) => { if (left.n > 0) { left.n -= 1; throw make(); } return store[method](...args); } };
};

test('a scheduled round is due from its minute until the grace period ends, on the same local day', () => {
    assert.equal(SCHEDULE_LATE_MINUTES, 10);
    assert.equal(scheduleMatches(SCHEDULED, minute(-1)), null, 'not before its time');
    assert.equal(scheduleMatches(SCHEDULED, minute(0)), '2026-11-12');
    assert.equal(scheduleMatches(SCHEDULED, new Date(AT + 59999)), '2026-11-12', 'any second of the minute');
    for (let late = 1; late < 10; late += 1) assert.equal(scheduleMatches(SCHEDULED, minute(late)), '2026-11-12', `${late} minutes late`);
    assert.equal(scheduleMatches(SCHEDULED, minute(10)), null, 'the grace period is over');
    assert.equal(scheduleMatches(SCHEDULED, minute(600)), null);

    // The grace period does not reach into the next day: 23:55 WIB is still due at 23:59 and not at 00:00.
    const late = { ...SCHEDULED, scheduleTime: '23:55' };
    assert.equal(scheduleMatches(late, new Date('2026-11-12T16:59:00Z')), '2026-11-12');
    assert.equal(scheduleMatches(late, new Date('2026-11-12T17:00:00Z')), null);

    // Switches, days and zones as before.
    assert.equal(scheduleMatches({ ...SCHEDULED, enabled: false }, minute(0)), null);
    assert.equal(scheduleMatches({ ...SCHEDULED, scheduleEnabled: false }, minute(3)), null);
    assert.equal(scheduleMatches({ ...SCHEDULED, scheduleDays: 'weekdays' }, minute(3)), '2026-11-12', 'Thursday is a weekday');
    assert.equal(scheduleMatches({ ...SCHEDULED, scheduleDays: 'weekend' }, minute(3)), null);
    assert.equal(scheduleMatches({ ...SCHEDULED, scheduleDays: 'weekend' }, new Date(AT + 2 * 86400000 + 180000)), '2026-11-14', 'Saturday');
    assert.equal(scheduleMatches({ ...SCHEDULED, timeZone: 'WITA' }, minute(0)), null, '18:00 WIB is 19:00 WITA');
    assert.equal(scheduleMatches({ ...SCHEDULED, timeZone: 'WITA', scheduleTime: '19:00' }, minute(4)), '2026-11-12');
    assert.equal(scheduleMatches({ ...SCHEDULED, timeZone: 'WIT', scheduleTime: '20:00' }, minute(4)), '2026-11-12');
});

for (const backend of ['sqlite', 'postgresql']) {
    const skip = backend === 'postgresql' && !pgEnabled;

    test(`${backend}: the database read fails at the scheduled minute, and the round still goes out a minute later, once`, { skip }, async (t) => {
        const w = await world(t, backend);
        assert.equal(await w.tick(-1), false);
        // 18:00: the settings cannot be read (the failure seen in the owner's log).
        if (backend === 'postgresql') { w.client.faults.query = 1; assert.equal(await w.tick(0), 'failed'); }
        else assert.equal(await w.tick(0, failing(w.store, 'read', 1)), 'failed');
        assert.equal(w.errors[0].message, 'Connection terminated unexpectedly');
        assert.equal(w.rounds(), 0);
        // 18:01: the database answers again.
        assert.equal(await w.tick(1), true);
        assert.equal(w.rounds(), 1);
        assert.match(w.sent[0].embeds[0].description, /Planet merah\?/);
        // The rest of the grace period and the rest of the day do not send a second round.
        for (const later of [1, 2, 5, 9, 10, 11, 300]) assert.equal(await w.tick(later), false, `minute ${later}`);
        assert.equal(w.rounds(), 1);
        assert.equal(w.generated.length, 1, 'one AI request');
    });

    test(`${backend}: the daily claim cannot be taken at the scheduled minute, and the next minute takes it`, { skip }, async (t) => {
        const w = await world(t, backend);
        if (backend === 'postgresql') { w.client.faults.connect = 1; assert.equal(await w.tick(0), 'failed'); }
        else assert.equal(await w.tick(0, failing(w.store, 'claimSchedule', 1)), 'failed');
        assert.equal(w.rounds(), 0);
        assert.equal(await w.tick(1), true);
        assert.equal(await w.tick(2), false);
        assert.equal(w.rounds(), 1);
    });

    test(`${backend}: a bot that was not running at the scheduled minute sends the round when it is back within the grace period`, { skip }, async (t) => {
        const back = await world(t, backend);
        assert.equal(await back.tick(9), true, 'nine minutes late');
        assert.equal(back.rounds(), 1);

        const tooLate = await world(t, backend);
        assert.equal(await tooLate.tick(10), false, 'ten minutes late is skipped');
        assert.equal(await tooLate.tick(11), false);
        assert.equal(tooLate.rounds(), 0);
        // The next day runs at its time again.
        assert.equal(await tooLate.tick(1440), true);
        assert.equal(tooLate.rounds(), 1);
    });

    test(`${backend}: the database fails after the day was claimed but before anything was sent, and the next minute tries again`, { skip }, async (t) => {
        const w = await world(t, backend);
        // The claim succeeds, then reserving the round fails.
        assert.equal(await w.tick(0, failing(w.store, 'reserve', 1)), 'failed');
        assert.equal(w.rounds(), 0);
        assert.equal(await w.tick(1), true, 'the claim was given back');
        assert.equal(w.rounds(), 1);
        assert.equal(await w.tick(2), false);

        // The same when the question cannot be stored: the reservation is cancelled and the next minute starts over.
        const second = await world(t, backend);
        assert.equal(await second.tick(0, failing(second.store, 'open', 1)), 'failed');
        assert.equal(second.rounds(), 0);
        assert.equal(await second.tick(1), true);
        assert.equal(await second.tick(2), false);
        assert.equal(second.rounds(), 1);
    });

    test(`${backend}: a fault that keeps coming back is retried only until the grace period ends`, { skip }, async (t) => {
        const w = await world(t, backend);
        const broken = failing(w.store, 'reserve', 1000);
        for (let m = 0; m < 10; m += 1) assert.equal(await w.tick(m, broken), 'failed', `minute ${m}`);
        assert.equal(await w.tick(10, broken), false, 'no further attempt');
        assert.equal(w.errors.length, 10);
        assert.equal(w.rounds(), 0);
    });

    test(`${backend}: when Discord's answer to the round is unknown, the day stays claimed and nothing is sent twice`, { skip }, async (t) => {
        const w = await world(t, backend);
        w.channel.failSend = 1;
        assert.equal(await w.tick(0), 'failed');
        assert.equal(w.errors[0].status, 409);
        assert.match(w.errors[0].message, /tidak pasti/);
        for (const later of [1, 2, 9]) assert.equal(await w.tick(later), false, `minute ${later}`);
        assert.equal(w.sent.length, 1, 'one attempt to send, no retry');
        assert.equal(w.rounds(), 0);
    });

    test(`${backend}: a round that is already running at the scheduled minute is not followed by a scheduled one`, { skip }, async (t) => {
        const w = await world(t, backend);
        // The owner starts a round by hand shortly before the scheduled time. (The stores count time by the real clock.)
        await startActivity({ client: w.client, guild: w.guild, actorId: OWNER, store: w.store });
        assert.equal(w.rounds(), 1);
        assert.equal(await w.tick(0), 'failed');
        assert.equal(w.errors[0].status, 409);
        assert.match(w.errors[0].message, /Masih ada ronde yang berjalan/);
        for (const later of [1, 5, 9]) assert.equal(await w.tick(later), false, `minute ${later}`);
        assert.equal(w.rounds(), 1, 'only the manual round');
    });

    test(`${backend}: giving a claim back only frees that day, and only for the next taker`, { skip }, async (t) => {
        const w = await world(t, backend);
        assert.equal(await w.store.claimSchedule(GUILD, '2026-11-12'), true);
        assert.equal(await w.store.claimSchedule(GUILD, '2026-11-12'), false);
        assert.equal(await w.store.releaseSchedule(GUILD, '2026-11-11'), false, 'another day is not the current claim');
        assert.equal(await w.store.claimSchedule(GUILD, '2026-11-12'), false);
        assert.equal(await w.store.releaseSchedule(GUILD, '2026-11-12'), true);
        assert.equal(await w.store.releaseSchedule(GUILD, '2026-11-12'), false, 'nothing left to give back');
        assert.deepEqual(await Promise.all([w.store.claimSchedule(GUILD, '2026-11-12'), w.store.claimSchedule(GUILD, '2026-11-12'), w.store.claimSchedule(GUILD, '2026-11-12')]).then((list) => list.filter(Boolean).length), 1);
        const fresh = await world(t, backend);
        assert.equal(await fresh.store.releaseSchedule(GUILD, '2026-11-12'), false, 'no claim was ever made');
    });

    test(`${backend}: a schedule saved after its time has passed starts on the next day, not a minute later`, { skip }, async (t) => {
        const w = await world(t, backend);
        await w.store.save(GUILD, { ...SCHEDULED, scheduleEnabled: false });
        // 18:04: the owner switches the schedule on with 18:00 as its time.
        assert.deepEqual(await saveActivitySettings({ store: w.store, guildId: GUILD, settings: SCHEDULED, now: minute(4) }), SCHEDULED);
        assert.deepEqual(await w.store.read(GUILD), SCHEDULED);
        for (const later of [4, 5, 9, 10]) assert.equal(await w.tick(later), false, `minute ${later}`);
        assert.equal(w.rounds(), 0);
        assert.equal(await w.tick(1440), true, 'the next day at 18:00');
        assert.equal(w.rounds(), 1);

        // Changing the time to a minute that is still ahead runs today.
        const ahead = await world(t, backend);
        await saveActivitySettings({ store: ahead.store, guildId: GUILD, settings: { ...SCHEDULED, scheduleTime: '18:07' }, now: minute(4) });
        assert.equal(await ahead.tick(6), false);
        assert.equal(await ahead.tick(7), true);
        assert.equal(ahead.rounds(), 1);

        // Saving something else while today's round is still waiting for the database does not cancel it.
        const waiting = await world(t, backend);
        await saveActivitySettings({ store: waiting.store, guildId: GUILD, settings: { ...SCHEDULED, rewardPoints: 5, duration: 90, kind: 'emoji', language: 'en' }, now: minute(2) });
        assert.equal(await waiting.tick(3), true);
        assert.equal(waiting.rounds(), 1);

        // The settings could not be stored: nothing changed, so today's round under the old settings still runs.
        const unsaved = await world(t, backend);
        await unsaved.store.save(GUILD, { ...SCHEDULED, scheduleTime: '18:06' });
        await assert.rejects(saveActivitySettings({ store: failing(unsaved.store, 'save', 1), guildId: GUILD, settings: SCHEDULED, now: minute(4) }));
        assert.equal((await unsaved.store.read(GUILD)).scheduleTime, '18:06');
        assert.equal(await unsaved.tick(6), true);
        assert.equal(unsaved.rounds(), 1);

        // The day could not be claimed: the new schedule is not stored either, so it cannot start a round a minute later.
        const unclaimed = await world(t, backend);
        await unclaimed.store.save(GUILD, { ...SCHEDULED, scheduleEnabled: false });
        await assert.rejects(saveActivitySettings({ store: failing(unclaimed.store, 'claimSchedule', 1), guildId: GUILD, settings: SCHEDULED, now: minute(4) }));
        assert.equal((await unclaimed.store.read(GUILD)).scheduleEnabled, false);
        assert.equal(await unclaimed.tick(5), false);
        assert.equal(unclaimed.rounds(), 0);

        // Each schedule field counts as a change of the schedule.
        for (const [name, before] of [['enabled', false], ['scheduleEnabled', false], ['scheduleTime', '17:00'], ['scheduleDays', 'weekend'], ['timeZone', 'WITA']]) {
            const changed = await world(t, backend);
            // `enabled: false` is only valid to store, not to run; the store accepts it.
            await changed.store.save(GUILD, { ...SCHEDULED, [name]: before });
            await saveActivitySettings({ store: changed.store, guildId: GUILD, settings: SCHEDULED, now: minute(4) });
            assert.equal(await changed.tick(5), false, name);
            assert.equal(changed.rounds(), 0, name);
        }
    });
}

test('dashboard: saving the Activities form goes through the same rule', async (t) => {
    const w = await world(t, 'sqlite');
    await w.store.save(GUILD, { ...SCHEDULED, scheduleEnabled: false });
    const app = express();
    const auth = (req, res, next) => { req.session = { user: { id: OWNER } }; req.guild = w.guild; next(); };
    app.use('/ai', createAIApi(w.client, { auth, csrf: (req, res, next) => next(), env: { OWNER_IDS: OWNER }, foundation: w.client.aiFoundation, activityStore: w.store }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const patch = (body) => fetch(`http://127.0.0.1:${server.address().port}/ai/activities`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // The route uses the real clock: schedule "now" in WIB, which is already due when it is saved.
    const wib = () => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    let before, after;
    do {
        before = wib();
        await w.store.save(GUILD, { ...SCHEDULED, scheduleEnabled: false });
        const settings = { ...SCHEDULED, scheduleTime: `${before.hour}:${before.minute}` };
        const response = await patch(settings);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, settings });
        after = wib();
    } while (before.day !== after.day); // midnight in WIB passed in between: try once more
    assert.equal(await w.store.claimSchedule(GUILD, `${after.year}-${after.month}-${after.day}`), false, 'today is already taken');
    assert.equal(await w.tick(new Date()), false);
    assert.equal(w.rounds(), 0);
    // A refused body stores nothing and claims nothing.
    assert.equal((await patch({ ...SCHEDULED, scheduleTime: '25:00' })).status, 400);
});
