import test from 'node:test';
import assert from 'node:assert/strict';
import {
    inspectJoinToCreate as inspect,
    readJoinToCreateState as readState,
    setupJoinToCreate as setupTrigger,
    updateJoinToCreate as update,
    removeJoinToCreateTrigger as remove,
    registerJoinToCreateChannel as register,
    transferJoinToCreateOwner as transfer,
    unregisterJoinToCreateChannel as unregister,
    unregisterJoinToCreateChannelIfPresent as unregisterIfPresent,
    reserveJoinToCreate as reserve,
    recordJoinToCreateCreated as recordCreated,
    completeJoinToCreate as complete,
    cancelJoinToCreatePending as cancel,
} from '../src/services/storage/postgresJoinToCreateTransactions.js';
import { pgEnabled as enabled, GUILD_ID as guild, TRIGGER_ID as trigger, snowflake as mid, hasCode as code, createJtcDatabase as fixture, loseCommitResponse, onSQLite } from './helpers/jtc-postgres-fixture.js';

const owner = mid(2);
const channel = mid(1);
const settled = (results, status) => results.filter((result) => result.status === status);

test('simultaneous setup of absent record allows one winner, no lost write', { skip: !enabled }, async (t) => {
    const { client, data } = await fixture(t);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => setupTrigger(client, guild, mid(i + 1), { userLimit: 0 })));
    assert.equal(settled(results, 'fulfilled').length, 1);
    assert.ok(settled(results, 'rejected').every((result) => result.reason.code === 'JTC_CONFLICT'));
    const stored = await data();
    assert.equal(stored.triggerChannels.length, 1);
    assert.equal(stored.enabled, true);
});

test('simultaneous registrations preserve all different owners; owner duplicates fail closed', { skip: !enabled }, async (t) => {
    const { client, data } = await fixture(t);
    await setupTrigger(client, guild, trigger, { nameTemplate: '{username}' });
    await Promise.all(Array.from({ length: 40 }, (_, i) => register(client, guild, mid(i + 1), mid(i + 1000), trigger, 1700000000000 + i)));
    assert.equal(Object.keys((await data()).temporaryChannels).length, 40);

    const duplicateOwner = mid(9000);
    const results = await Promise.allSettled([
        register(client, guild, mid(101), duplicateOwner, trigger, 1),
        register(client, guild, mid(102), duplicateOwner, trigger, 2),
    ]);
    assert.equal(settled(results, 'fulfilled').length, 1);
    assert.equal(settled(results, 'rejected')[0].reason.code, 'JTC_CONFLICT');
    assert.equal(Object.keys((await data()).temporaryChannels).length, 41);
});

test('config revision ignores channel churn, rejects stale config edits and preserves unknown fields', { skip: !enabled }, async (t) => {
    const { client, data, put } = await fixture(t);
    await put({ enabled: true, triggerChannels: [trigger], temporaryChannels: {}, channelOptions: { [trigger]: { userLimit: 4, extra: 'preserved' } }, custom: { flag: true } });

    const before = await inspect(client, guild);
    await register(client, guild, mid(1), mid(2), trigger, 1);
    const afterChurn = await inspect(client, guild);
    assert.notEqual(afterChurn.revision, before.revision, 'whole-record revision changes with channels');
    assert.equal(afterChurn.configRevision, before.configRevision, 'config revision does not');

    // An administrator's edit is not invalidated by members creating channels.
    assert.deepEqual(await update(client, guild, trigger, { userLimit: 0 }, before.configRevision), { nameTemplate: "{username}'s Room", userLimit: 0, bitrate: 64000 });
    assert.equal((await data()).channelOptions[trigger].extra, 'preserved');
    assert.deepEqual((await data()).custom, { flag: true });

    // …but it is by another configuration edit.
    await assert.rejects(update(client, guild, trigger, { bitrate: 8000 }, before.configRevision), code('JTC_STALE'));
    await assert.rejects(remove(client, guild, trigger, before.configRevision), code('JTC_STALE'));
    // Without an expected revision the patch touches only its own field.
    await update(client, guild, trigger, { bitrate: 96000 });
    assert.deepEqual((await data()).channelOptions[trigger], { userLimit: 0, bitrate: 96000, extra: 'preserved' });
    await assert.rejects(update(client, guild, mid(77), { bitrate: 8000 }), code('JTC_MISSING'));
    await assert.rejects(update(client, guild, trigger, { bitrate: 8000 }, 'not-a-revision'), code('JTC_INVALID'));
});

test('transfer and unregister compare the owner; trigger removal retains channel records', { skip: !enabled }, async (t) => {
    const { client, data } = await fixture(t);
    await setupTrigger(client, guild, trigger, { userLimit: 4 });
    await register(client, guild, mid(1), mid(2), trigger, 1);
    await register(client, guild, mid(11), mid(12), trigger, 1);

    await assert.rejects(transfer(client, guild, mid(1), mid(2), mid(12)), code('JTC_CONFLICT'), 'new owner already owns a channel');
    await transfer(client, guild, mid(1), mid(2), mid(3));
    await assert.rejects(transfer(client, guild, mid(1), mid(2), mid(4)), code('JTC_STALE'));
    await assert.rejects(unregister(client, guild, mid(1), mid(2), trigger), code('JTC_STALE'));

    await remove(client, guild, trigger);
    let stored = await data();
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.triggerChannels, []);
    assert.equal(stored.temporaryChannels[mid(1)].ownerId, mid(3));
    await assert.rejects(remove(client, guild, trigger), code('JTC_MISSING'));

    await unregister(client, guild, mid(1), mid(3), trigger);
    assert.equal(await unregisterIfPresent(client, guild, mid(11)), true);
    assert.equal(await unregisterIfPresent(client, guild, mid(11)), false);
    stored = await data();
    assert.equal(Object.keys(stored.temporaryChannels).length, 0);
});

test('legacy, expiring, malformed and oversize state are not overwritten', { skip: !enabled }, async (t) => {
    const { client, pool, key, put, data } = await fixture(t);
    await pool.query('INSERT INTO cache_data(key,value) VALUES($1,$2)', [key, '{}']);
    await assert.rejects(setupTrigger(client, guild, trigger, { userLimit: 1 }), code('JTC_LEGACY'));
    await pool.query('DELETE FROM cache_data');
    await pool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)', [`${key}:channels`, '{}']);
    await assert.rejects(inspect(client, guild), code('JTC_LEGACY'));
    await assert.rejects(readState(client, guild), code('JTC_LEGACY'));
    await pool.query('DELETE FROM temp_data');

    await put({ enabled: false, triggerChannels: [], channelOptions: { [trigger]: { custom: 'retained' } } });
    await assert.rejects(setupTrigger(client, guild, trigger, { userLimit: 1 }), code('JTC_CONFLICT'));
    assert.equal((await data()).channelOptions[trigger].custom, 'retained');

    const cases = [
        [{ enabled: false }, new Date(Date.now() + 10000), 'JTC_EXPIRY'],
        [{ enabled: false }, new Date(Date.now() - 10000), 'JTC_EXPIRY'],
        [{ ok: true, value: {} }, null, 'JTC_INVALID'],
        [{ temporaryChannels: { bad: {} } }, null, 'JTC_INVALID'],
        [{ extra: 'x'.repeat(530000) }, null, 'JTC_INVALID'],
    ];
    for (const [value, expiry, error] of cases) {
        await put(value, expiry);
        await assert.rejects(setupTrigger(client, guild, trigger, { userLimit: 1 }), code(error));
        await assert.rejects(unregisterIfPresent(client, guild, mid(1)), code(error));
        assert.deepEqual(await data(), value);
    }
});

test('scope, invalid input, unavailable backend and SQL rollback fail closed', { skip: !enabled }, async (t) => {
    const { client, backend, pool, data } = await fixture(t);
    await assert.rejects(inspect(client, '999999999999999999'), code('JTC_SCOPE'));
    await assert.rejects(setupTrigger(client, guild, trigger, { userLimit: -1 }), code('JTC_INVALID'));
    await assert.rejects(setupTrigger(client, guild, trigger, { categoryId: trigger }), code('JTC_INVALID'));
    await assert.rejects(setupTrigger(client, guild, trigger, { nameTemplate: 'x'.repeat(101) }), code('JTC_INVALID'));
    await assert.rejects(cancel(client, guild, 'not-a-token'), code('JTC_INVALID'));
    backend.isConnected = false;
    await assert.rejects(inspect(client, guild), code('JTC_UNAVAILABLE'));
    backend.isConnected = true;

    await setupTrigger(client, guild, trigger, { userLimit: 1 });
    const before = await data();
    await pool.query("CREATE FUNCTION deny_jtc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$; CREATE TRIGGER deny BEFORE UPDATE ON temp_data FOR EACH ROW EXECUTE FUNCTION deny_jtc()");
    await assert.rejects(register(client, guild, mid(1), mid(2), trigger, 1));
    assert.deepEqual(await data(), before);
});

test('competing config edits, transfer/delete and registration/trigger removal serialize safely', { skip: !enabled }, async (t) => {
    const { client, data } = await fixture(t);
    await setupTrigger(client, guild, trigger, { userLimit: 1 });
    const view = await inspect(client, guild);

    let outcomes = await Promise.allSettled([
        update(client, guild, trigger, { userLimit: 2 }, view.configRevision),
        update(client, guild, trigger, { userLimit: 3 }, view.configRevision),
    ]);
    assert.equal(settled(outcomes, 'fulfilled').length, 1);
    assert.equal(settled(outcomes, 'rejected')[0].reason.code, 'JTC_STALE');

    await register(client, guild, mid(1), mid(2), trigger, 1);
    outcomes = await Promise.allSettled([transfer(client, guild, mid(1), mid(2), mid(3)), unregister(client, guild, mid(1), mid(2), trigger)]);
    assert.equal(settled(outcomes, 'fulfilled').length, 1);
    assert.equal(settled(outcomes, 'rejected')[0].reason.code, 'JTC_STALE');

    outcomes = await Promise.allSettled([register(client, guild, mid(4), mid(5), trigger, 1), remove(client, guild, trigger)]);
    const stored = await data();
    // Either order is valid; a channel is never registered under a removed trigger.
    assert.ok(stored.enabled === false);
    if (Object.hasOwn(stored.temporaryChannels, mid(4))) assert.equal(settled(outcomes, 'fulfilled').length, 2);
    else assert.equal(settled(outcomes, 'rejected')[0].reason.code, 'JTC_STALE');
});

test('reservation blocks every other write, returns effective settings and is released by complete or cancel', { skip: !enabled }, async (t) => {
    const { client, data, put } = await fixture(t);
    await put({ enabled: true, triggerChannels: [trigger], channelNameTemplate: '{username} default', userLimit: 7, bitrate: 96000, channelOptions: { [trigger]: { userLimit: 3 } } });

    const { token, options } = await reserve(client, guild, owner, trigger);
    assert.deepEqual(options, { nameTemplate: '{username} default', userLimit: 3, bitrate: 96000 });
    let stored = await data();
    assert.deepEqual(Object.keys(stored.pendingCreates), [token]);
    assert.equal(stored.pendingCreates[token].stage, 'reserved');

    // Dashboards see a count only; the runtime snapshot carries the details.
    const summary = await inspect(client, guild);
    assert.equal(summary.pendingCreateCount, 1);
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(`${owner}|${token}`));
    assert.deepEqual((await readState(client, guild)).pending.map((p) => [p.token, p.ownerId, p.triggerId, p.stage]), [[token, owner, trigger, 'reserved']]);

    await assert.rejects(reserve(client, guild, owner, trigger), code('JTC_CONFLICT'));
    await assert.rejects(reserve(client, guild, mid(50), trigger), code('JTC_PENDING'));
    await assert.rejects(register(client, guild, channel, owner, trigger, 1), code('JTC_CONFLICT'));
    await assert.rejects(register(client, guild, channel, mid(50), trigger, 1), code('JTC_PENDING'));
    await assert.rejects(update(client, guild, trigger, { userLimit: 2 }), code('JTC_PENDING'));
    await assert.rejects(remove(client, guild, trigger), code('JTC_PENDING'));
    await assert.rejects(complete(client, guild, mid(50), trigger, token, channel), code('JTC_STALE'), 'wrong owner');

    await complete(client, guild, owner, trigger, token, channel);
    stored = await data();
    assert.deepEqual(stored.pendingCreates, {});
    assert.equal(stored.temporaryChannels[channel].ownerId, owner);
    assert.equal(stored.temporaryChannels[channel].triggerChannelId, trigger);
    await assert.rejects(complete(client, guild, owner, trigger, token, channel), code('JTC_STALE'), 'a reservation completes once');
    await assert.rejects(reserve(client, guild, owner, trigger), code('JTC_CONFLICT'), 'one channel per owner');

    const second = await reserve(client, guild, mid(50), trigger);
    assert.equal(await cancel(client, guild, second.token), true);
    assert.equal(await cancel(client, guild, second.token), false);
    assert.deepEqual((await data()).pendingCreates, {});
    await update(client, guild, trigger, { userLimit: 2 });
});

test('recorded channel ID must match when completing from the created stage', { skip: !enabled }, async (t) => {
    const { client, data } = await fixture(t);
    await setupTrigger(client, guild, trigger, { userLimit: 1 });
    const { token } = await reserve(client, guild, owner, trigger);
    await recordCreated(client, guild, owner, trigger, token, channel);
    assert.deepEqual((await readState(client, guild)).pending.map((p) => [p.stage, p.channelId]), [['created', channel]]);
    await assert.rejects(recordCreated(client, guild, owner, trigger, token, channel), code('JTC_STALE'));
    await assert.rejects(complete(client, guild, owner, trigger, token, mid(999)), code('JTC_STALE'));
    await complete(client, guild, owner, trigger, token, channel);
    assert.equal((await data()).temporaryChannels[channel].ownerId, owner);
});

test('a reservation is refused when there is no room left to register its channel', { skip: !enabled }, async (t) => {
    const { client, pool, data } = await fixture(t);
    await setupTrigger(client, guild, trigger, { userLimit: 1 });

    const full = {};
    for (let i = 0; i < 5000; i++) full[String(10000000000000000n + BigInt(i))] = { ownerId: String(20000000000000000n + BigInt(i)), triggerChannelId: trigger };
    await pool.query("UPDATE temp_data SET value=jsonb_set(value,'{temporaryChannels}',$1::jsonb)", [JSON.stringify(full)]);
    await assert.rejects(reserve(client, guild, owner, trigger), code('JTC_INVALID'), 'channel count limit');
    assert.deepEqual((await data()).pendingCreates, {});

    // Fill the record so that only the bare reservation would still fit.
    const stored = await data();
    stored.temporaryChannels = {};
    stored.padding = '';
    const token = '11111111-2222-4333-8444-555555555555';
    const withReservation = structuredClone(stored);
    withReservation.pendingCreates = { [token]: { ownerId: owner, triggerId: trigger, createdAt: Date.now(), stage: 'reserved' } };
    const size = (await pool.query('SELECT octet_length($1::jsonb::text) AS bytes', [JSON.stringify(withReservation)])).rows[0].bytes;
    stored.padding = 'x'.repeat(512 * 1024 - size - 1);
    await pool.query('UPDATE temp_data SET value=$1::jsonb', [JSON.stringify(stored)]);
    await assert.rejects(reserve(client, guild, owner, trigger), code('JTC_INVALID'), 'byte limit including the future registration');
    assert.deepEqual((await data()).pendingCreates, {});
    assert.equal((await inspect(client, guild)).pendingCreateCount, 0, 'the record itself is still within the limit');
});

// PostgreSQL only: a SQLite commit happens in this process and its answer cannot get lost.
test('a lost COMMIT response leaves a state the caller can read back', { skip: !enabled || onSQLite }, async (t) => {
    const { client, pool, data } = await fixture(t);
    await setupTrigger(client, guild, trigger, { userLimit: 1 });

    await assert.rejects(reserve(loseCommitResponse(client, pool, 1), guild, owner, trigger), /lost COMMIT/);
    const [pending] = (await readState(client, guild)).pending;
    assert.equal(pending.ownerId, owner, 'the reservation was committed although the call failed');

    await assert.rejects(complete(loseCommitResponse(client, pool, 1), guild, owner, trigger, pending.token, channel), /lost COMMIT/);
    const stored = await data();
    assert.deepEqual(stored.pendingCreates, {});
    assert.equal(stored.temporaryChannels[channel].ownerId, owner);
});
