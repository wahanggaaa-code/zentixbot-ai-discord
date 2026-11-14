import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GIVEAWAY_PENDING_SETTLE_MS,
    claimPostgresGiveaway,
    completePostgresGiveawayDelivery,
    duePostgresGiveaways,
    inspectPostgresGiveaway,
    joinPostgresGiveaway,
} from '../src/services/storage/postgresGiveawayTransactions.js';
import { checkPostgresGiveaways, deliverPostgresGiveaway } from '../src/services/postgresGiveawayRuntime.js';
import gdelete from '../src/commands/Giveaway/gdelete.js';
import {
    adminId, botId, channelId, createGiveawayFixture, entrant, guildId, hasCode,
    missingPermissions, pgEnabled, settle, strangerId, voiceId, onSQLite,
} from './helpers/giveaway-postgres-fixture.js';

const skip = { skip: !pgEnabled };
const form = (overrides = {}) => ({
    channelId, prize: 'Nitro', winnerCount: 2, duration: '1h', confirmed: true, ...overrides,
});

/** A stored, active giveaway with `entries` participants, created through the API. */
async function createGiveaway(fx, entries = 0, overrides = {}) {
    const response = await fx.call('create', 'POST', form(overrides));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { messageId } = response.body;
    for (let i = 0; i < entries; i++) await joinPostgresGiveaway(fx.client, guildId, messageId, entrant(i));
    return messageId;
}

/** End a giveaway while Discord fails, leaving its delivery unfinished. */
async function leavePending(fx, messageId, failAt = 'edit') {
    fx.hooks[failAt] = async () => { throw new Error('Discord timeout'); };
    await assert.rejects(deliverPostgresGiveaway(fx.client, guildId, messageId, 'manual_end', adminId));
    delete fx.hooks[failAt];
    assert.equal((await fx.read(messageId)).deliveryStatus, 'pending');
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

test('create posts one message, stores a valid record and audits it', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const before = Date.now();
    const response = await fx.call('create', 'POST', form({ prize: '  Nitro @everyone  ' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { messageId } = response.body;

    assert.deepEqual(fx.sent(), [messageId]);
    const posted = fx.messages.get(messageId).payload;
    assert.deepEqual(posted.allowedMentions, { parse: [] });
    assert.match(posted.embeds[0].data.title, /Nitro @everyone$/);

    const stored = await fx.read(messageId);
    assert.equal(stored.prize, 'Nitro @everyone');
    assert.equal(stored.hostId, adminId, 'the host is the logged-in administrator');
    assert.equal(stored.channelId, channelId);
    assert.equal(stored.winnerCount, 2);
    assert.deepEqual(stored.participants, []);
    assert.equal(stored.ended, false);
    assert.ok(stored.endsAt >= before + 3_600_000 && stored.endsAt <= Date.now() + 3_600_000);
    assert.equal(response.body.endAt, stored.endsAt);

    // The record is accepted by the same protocol the bot uses.
    assert.equal((await joinPostgresGiveaway(fx.client, guildId, messageId, entrant(1))).status, 'joined');
    const listed = (await fx.call('list')).body.giveaways;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'active');
    assert.equal(listed[0].deleting, false);
    assert.equal(listed[0].dataReview, false);

    await settle();
    assert.equal(fx.audits.length, 1);
    assert.deepEqual(fx.audits[0].slice(0, 3), [guildId, adminId, 'create']);
    assert.equal(fx.audits[0][3].messageId, messageId);
});

test('create rejects bad input and missing authorization before anything is posted', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    assert.equal((await fx.call('create', 'POST', form(), { 'x-auth': 'no' })).status, 401);
    assert.equal((await fx.call('create', 'POST', form(), { 'x-csrf': 'no' })).status, 403);
    const invalid = [
        form({ confirmed: false }),
        form({ extra: 1 }),
        { channelId, prize: 'Nitro', winnerCount: 2, duration: '1h' },
        form({ channelId: 'abc' }),
        form({ prize: '' }),
        form({ prize: '   ' }),
        form({ prize: 'x'.repeat(257) }),
        form({ prize: 5 }),
        form({ winnerCount: 0 }),
        form({ winnerCount: 11 }),
        form({ winnerCount: '2' }),
        form({ winnerCount: 1.5 }),
        form({ duration: '10s' }),
        form({ duration: '0m' }),
        form({ duration: '4m' }),
        form({ duration: '31d' }),
        form({ duration: '1000m' }),
        form({ duration: '1h ' }),
        form({ duration: 60 }),
        [],
    ];
    for (const body of invalid) {
        assert.equal((await fx.call('create', 'POST', body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
    // The limits of the bot itself: 5 minutes and 30 days are accepted.
    assert.equal((await fx.call('create', 'POST', form({ duration: '5m' }))).status, 200);
    assert.equal((await fx.call('create', 'POST', form({ duration: '30d' }))).status, 200);
    assert.equal(fx.sent().length, 2);
    assert.equal((await fx.rows()).length, 2);
});

test('create refuses channels the bot cannot post in and legacy data, posting nothing', skip, async (t) => {
    const fx = await createGiveawayFixture(t);

    const options = (await fx.call('options')).body;
    assert.deepEqual(options.channels, [{ id: channelId, name: 'giveaways' }]);
    assert.equal(options.limits.minWinners, 1);
    assert.equal(options.limits.maxWinners, 10);
    assert.equal(options.limits.minDurationMs, 300_000);
    assert.equal(options.limits.pendingSettleMs, GIVEAWAY_PENDING_SETTLE_MS);
    assert.equal((await fx.call('options?x=1')).status, 400);

    for (const id of [voiceId, '499999999999999999']) {
        const response = await fx.call('create', 'POST', form({ channelId: id }));
        assert.equal(response.status, 409);
        assert.equal(response.body.code, 'GIVEAWAY_CHANNEL');
    }
    // Permission is checked again at the moment of creation, not only when listing.
    fx.permissions.allowed = false;
    assert.deepEqual((await fx.call('options')).body.channels, []);
    assert.equal((await fx.call('create', 'POST', form())).body.code, 'GIVEAWAY_CHANNEL');
    fx.permissions.allowed = true;

    // PostgreSQL only: giveaways left in the old key and value table. On SQLite that row is the storage itself.
    if (!onSQLite) {
        await fx.pool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)', [`guild:${guildId}:giveaways`, '{}']);
        assert.equal((await fx.call('create', 'POST', form())).body.code, 'GIVEAWAY_LEGACY');
        await fx.pool.query('DELETE FROM temp_data');
    }

    fx.backend.isConnected = false;
    assert.equal((await fx.call('create', 'POST', form())).status, 503);
    fx.backend.isConnected = true;

    assert.deepEqual(fx.sent(), []);
    assert.deepEqual(await fx.rows(), []);
});

test('a refused or timed-out Discord send leaves no record and is reported differently', skip, async (t) => {
    const fx = await createGiveawayFixture(t);

    fx.hooks.send = async () => { throw missingPermissions(); };
    const refused = await fx.call('create', 'POST', form());
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, 'GIVEAWAY_CREATE_FAILED');

    fx.hooks.send = async () => { throw new Error('socket hang up'); };
    const unknown = await fx.call('create', 'POST', form());
    assert.equal(unknown.status, 502);
    assert.equal(unknown.body.code, 'GIVEAWAY_SEND_UNKNOWN');
    assert.equal(unknown.body.channelId, channelId);
    assert.match(unknown.body.error, /mungkin terkirim atau tidak/);

    assert.deepEqual(await fx.rows(), []);
    await settle();
    assert.deepEqual(fx.audits, []);
});

test('when the record cannot be stored, the posted message is removed again', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    await fx.pool.query(`ALTER TABLE giveaways ADD CONSTRAINT refuse CHECK (data->>'prize' <> 'Blocked')`);

    const response = await fx.call('create', 'POST', form({ prize: 'Blocked' }));
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'GIVEAWAY_CREATE_FAILED');
    assert.match(response.body.error, /Tidak ada pesan atau catatan yang tertinggal/);

    assert.equal(fx.sent().length, 1);
    assert.equal(fx.messages.size, 0, 'nobody can join a giveaway that does not exist');
    assert.deepEqual(await fx.rows(), []);
});

test('when storage becomes unreachable after posting, the orphan message is named, not deleted', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    fx.hooks.afterSend = async () => { fx.backend.isConnected = false; };

    const response = await fx.call('create', 'POST', form());
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'GIVEAWAY_CREATE_ORPHAN');
    const [messageId] = fx.sent();
    assert.equal(response.body.messageId, messageId);
    assert.equal(response.body.channelId, channelId);
    // Whether the record exists is unknown, so the message is left for a person to judge.
    assert.equal(fx.messages.has(messageId), true);

    fx.backend.isConnected = true;
    assert.deepEqual(await fx.rows(), []);
});

// PostgreSQL only: a SQLite commit happens in this process and its answer cannot get lost.
test('a commit whose reply is lost still counts as created, with one message', onSQLite ? { skip: true } : skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    fx.hooks.afterSend = async () => { fx.lost.commits = 1; };

    const response = await fx.call('create', 'POST', form());
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(fx.lost.commits, 0, 'the commit reply really was lost');
    assert.equal(fx.messages.has(response.body.messageId), true);
    assert.equal((await fx.rows()).length, 1);
    assert.equal((await fx.read(response.body.messageId)).prize, 'Nitro');
});

test('two creations at once post one giveaway; the other is told to wait', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    fx.hooks.send = () => gate;

    const first = fx.call('create', 'POST', form());
    await settle();
    const second = await fx.call('create', 'POST', form());
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'GIVEAWAY_BUSY');
    release();
    assert.equal((await first).status, 200);

    assert.equal(fx.sent().length, 1);
    assert.equal((await fx.rows()).length, 1);
    // The guard is released afterwards.
    delete fx.hooks.send;
    assert.equal((await fx.call('create', 'POST', form())).status, 200);
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

test('delete removes the message and the record, and nothing else', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const keep = await createGiveaway(fx, 1, { prize: 'Keep' });
    const target = await createGiveaway(fx, 3);
    fx.audits.length = 0;

    const response = await fx.act(target, 'delete');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { ok: true, discord: 'deleted', entries: 3 });

    assert.equal(fx.messages.has(target), false);
    assert.equal(await fx.read(target), null);
    assert.equal(fx.messages.has(keep), true);
    assert.equal((await fx.read(keep)).participants.length, 1);

    await assert.rejects(joinPostgresGiveaway(fx.client, guildId, target, entrant(9)), hasCode('GIVEAWAY_MISSING'));
    assert.equal((await fx.call(`prepare?messageId=${target}`)).status, 409);

    await settle();
    assert.equal(fx.audits.length, 1);
    assert.deepEqual(fx.audits[0].slice(0, 3), [guildId, adminId, 'delete']);
    assert.match(fx.audits[0][3].note, /3 entries/);
});

test('deleting an ended giveaway leaves the winner announcement in the channel', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 2);
    await deliverPostgresGiveaway(fx.client, guildId, messageId, 'manual_end', adminId);
    const announcement = (await fx.read(messageId)).winnerPingMessageId;
    assert.equal(fx.messages.has(announcement), true);

    assert.equal((await fx.act(messageId, 'delete')).status, 200);
    assert.equal(fx.messages.has(messageId), false);
    assert.equal(fx.messages.has(announcement), true);
    assert.equal(await fx.read(messageId), null);
});

test('delete needs authorization, confirmation and the revision that was shown', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 1);
    const fresh = await fx.prepare(messageId);
    const body = { messageId, action: 'delete', revision: fresh.revision, confirmed: true };

    assert.equal((await fx.call('action', 'POST', body, { 'x-auth': 'no' })).status, 401);
    assert.equal((await fx.call('action', 'POST', body, { 'x-csrf': 'no' })).status, 403);
    assert.equal((await fx.call('action', 'POST', { ...body, confirmed: false })).status, 400);
    assert.equal((await fx.call('action', 'POST', { ...body, action: 'purge' })).status, 400);
    assert.equal((await fx.call('action', 'POST', { ...body, revision: 'x' })).status, 400);

    // Somebody joins after the administrator looked: the confirmation no longer describes the data.
    await joinPostgresGiveaway(fx.client, guildId, messageId, entrant(5));
    const stale = await fx.call('action', 'POST', body);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'GIVEAWAY_STALE');

    assert.equal(fx.messages.has(messageId), true);
    const stored = await fx.read(messageId);
    assert.equal(stored.participants.length, 2);
    assert.equal(stored.deletion, undefined);
});

test('a message or channel that is already gone still lets the record be removed', skip, async (t) => {
    const fx = await createGiveawayFixture(t);

    const first = await createGiveaway(fx, 1);
    fx.messages.delete(first);
    const response = await fx.act(first, 'delete');
    assert.equal(response.status, 200);
    assert.equal(response.body.discord, 'already_gone');
    assert.equal(await fx.read(first), null);

    const second = await createGiveaway(fx, 1);
    fx.channels.delete(channelId);
    assert.equal((await fx.act(second, 'delete')).body.discord, 'already_gone');
    assert.equal(await fx.read(second), null);
});

test('when Discord cannot be checked, nothing changes; the record alone can then be removed', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 2);

    fx.hooks.fetch = async () => { throw new Error('Discord unreachable'); };
    const unreadable = await fx.act(messageId, 'delete');
    assert.equal(unreadable.status, 409);
    assert.equal(unreadable.body.code, 'GIVEAWAY_DISCORD_UNVERIFIED');
    delete fx.hooks.fetch;

    // A record pointing at somebody else's message must never delete that message.
    fx.messages.get(messageId).author.id = strangerId;
    assert.equal((await fx.act(messageId, 'delete')).body.code, 'GIVEAWAY_DISCORD_UNVERIFIED');

    let stored = await fx.read(messageId);
    assert.equal(stored.deletion, undefined, 'the giveaway is not frozen');
    assert.equal(stored.participants.length, 2);
    assert.equal(fx.messages.has(messageId), true);

    const deletesBefore = fx.log.filter(([kind]) => kind === 'delete').length;
    fx.hooks.fetch = async () => { throw new Error('Discord must not be contacted'); };
    fx.hooks.channelFetch = fx.hooks.fetch;
    const recordOnly = await fx.act(messageId, 'delete_record');
    assert.equal(recordOnly.status, 200, JSON.stringify(recordOnly.body));
    assert.equal(recordOnly.body.discord, 'untouched');
    assert.equal(await fx.read(messageId), null);
    assert.equal(fx.messages.has(messageId), true);
    assert.equal(fx.log.filter(([kind]) => kind === 'delete').length, deletesBefore);
    stored = await fx.rows();
    assert.deepEqual(stored, []);
});

test('a deletion Discord refuses is undone, so the giveaway keeps working', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 1);
    fx.hooks.delete = async () => { throw missingPermissions(); };

    const response = await fx.act(messageId, 'delete');
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'GIVEAWAY_DISCORD_UNVERIFIED');
    assert.equal((await fx.read(messageId)).deletion, undefined);
    assert.equal((await joinPostgresGiveaway(fx.client, guildId, messageId, entrant(7))).status, 'joined');
});

test('an interrupted deletion freezes the giveaway and can be continued', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 2, { duration: '5m' });
    fx.hooks.delete = async () => { throw new Error('Discord timeout'); };

    const interrupted = await fx.act(messageId, 'delete');
    assert.equal(interrupted.status, 502);
    assert.equal(interrupted.body.code, 'GIVEAWAY_DELETE_UNFINISHED');
    delete fx.hooks.delete;

    const marked = await fx.read(messageId);
    assert.equal(marked.deletion.by, adminId);
    assert.equal(marked.participants.length, 2, 'entries are kept until the deletion is finished');

    // Frozen for everybody: entrants, moderators, the scheduler.
    await assert.rejects(joinPostgresGiveaway(fx.client, guildId, messageId, entrant(8)), hasCode('GIVEAWAY_DELETING'));
    await assert.rejects(claimPostgresGiveaway(fx.client, guildId, messageId, 'manual_end', adminId), hasCode('GIVEAWAY_DELETING'));
    assert.equal((await fx.act(messageId, 'end')).status, 503);
    await fx.pool.query(`UPDATE giveaways SET ends_at = now() - interval '1 day' WHERE message_id=$1`, [messageId]);
    assert.deepEqual(await duePostgresGiveaways(fx.client, guildId), []);
    const sendsBefore = fx.sent().length;
    await checkPostgresGiveaways(fx.client);
    assert.equal(fx.sent().length, sendsBefore);
    await fx.pool.query(`UPDATE giveaways SET ends_at = to_timestamp((data->>'endsAt')::double precision/1000) AT TIME ZONE 'UTC' WHERE message_id=$1`, [messageId]);

    const listed = (await fx.call('list')).body.giveaways[0];
    assert.equal(listed.deleting, true);
    assert.equal(listed.dataReview, false);
    const fresh = await fx.prepare(messageId);
    assert.equal(fresh.deleting, true);
    assert.equal(fresh.canDelete, true);

    const resumed = await fx.act(messageId, 'delete');
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.discord, 'deleted');
    assert.equal(await fx.read(messageId), null);
    assert.equal(fx.messages.has(messageId), false);
});

test('if the record cannot be removed after the message is gone, repeating finishes the job', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 1);
    fx.hooks.afterDelete = async () => { fx.backend.isConnected = false; };

    const response = await fx.act(messageId, 'delete');
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'GIVEAWAY_DELETE_UNFINISHED');
    fx.backend.isConnected = true;
    delete fx.hooks.afterDelete;

    assert.equal(fx.messages.has(messageId), false);
    assert.ok((await fx.read(messageId)).deletion);

    const again = await fx.act(messageId, 'delete');
    assert.equal(again.status, 200);
    assert.equal(again.body.discord, 'already_gone');
    assert.equal(await fx.read(messageId), null);
});

test('delete racing an end never announces winners of a deleted giveaway', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    for (let round = 0; round < 8; round++) {
        const messageId = await createGiveaway(fx, 3);
        const sendsBefore = fx.sent().length;
        // The administrator confirmed deleting an ACTIVE giveaway; the end starts after that.
        const fresh = await fx.prepare(messageId);
        const [removal, ending] = await Promise.all([
            fx.call('action', 'POST', { messageId, action: 'delete', revision: fresh.revision, confirmed: true }),
            deliverPostgresGiveaway(fx.client, guildId, messageId, 'manual_end', adminId).then(() => 'ended', () => 'refused'),
        ]);
        const stored = await fx.read(messageId);
        const announced = fx.sent().length - sendsBefore;
        if (removal.status === 200) {
            assert.equal(stored, null);
            assert.equal(ending, 'refused');
            assert.equal(announced, 0, `round ${round}: winners announced for a deleted giveaway`);
        } else {
            assert.ok(stored, `round ${round}: record lost without a successful delete`);
            assert.equal(stored.deletion, undefined);
        }
    }
});

test('delete racing joins ends with the record gone or intact, never half', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 0);
    const fresh = await fx.prepare(messageId);
    const joins = Array.from({ length: 20 }, (_, i) => joinPostgresGiveaway(fx.client, guildId, messageId, entrant(i))
        .then((r) => r.status, (e) => e.code));
    const removal = fx.call('action', 'POST', { messageId, action: 'delete', revision: fresh.revision, confirmed: true });
    const [outcomes, response] = await Promise.all([Promise.all(joins), removal]);

    for (const outcome of outcomes) {
        assert.ok(['joined', 'GIVEAWAY_DELETING', 'GIVEAWAY_MISSING'].includes(outcome), outcome);
    }
    if (response.status === 200) {
        assert.equal(await fx.read(messageId), null);
        assert.equal(fx.messages.has(messageId), false);
    } else {
        // A join changed the record first: the stale confirmation was refused and nothing was deleted.
        assert.equal(response.body.code, 'GIVEAWAY_STALE');
        assert.equal(fx.messages.has(messageId), true);
        assert.equal((await fx.read(messageId)).deletion, undefined);
    }
});

test('/gdelete on PostgreSQL deletes through the same path and reports honestly', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 2);
    const replies = [];
    const interaction = (id) => ({
        id: '923456789012345678',
        guildId,
        channelId,
        user: { id: adminId, tag: 'Admin' },
        inGuild: () => true,
        member: { permissions: { has: () => true } },
        client: fx.client,
        options: { getString: () => id },
        deferReply: async function () { this.deferred = true; },
        reply: async (x) => replies.push(x),
        editReply: async (x) => replies.push(x),
        followUp: async (x) => replies.push(x),
    });

    await assert.rejects(gdelete.execute(interaction('199999999999999999')), (e) => /Nothing was deleted/.test(e.userMessage));
    await assert.rejects(gdelete.execute(interaction('not-an-id')), (e) => /valid message ID/.test(e.userMessage));
    assert.equal(fx.messages.has(messageId), true);

    await gdelete.execute(interaction(messageId));
    assert.equal(await fx.read(messageId), null);
    assert.equal(fx.messages.has(messageId), false);
    assert.match(JSON.stringify(replies.at(-1)), /Deleted the giveaway for \*\*Nitro\*\* and its 2 stored entries/);
});

// ---------------------------------------------------------------------------
// Unfinished delivery
// ---------------------------------------------------------------------------

test('an unfinished delivery cannot be touched while it may still be running', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 3);
    await leavePending(fx, messageId);

    const fresh = await fx.prepare(messageId);
    assert.equal(fresh.deliveryStatus, 'pending');
    assert.equal(fresh.canResolve, false);
    assert.equal(fresh.canDelete, false);
    for (const action of ['mark_delivered', 'redeliver', 'delete', 'delete_record']) {
        const response = await fx.act(messageId, action);
        assert.equal(response.status, 409, action);
        assert.equal(response.body.code, 'GIVEAWAY_IN_PROGRESS', action);
    }
    const stored = await fx.read(messageId);
    assert.equal(stored.deliveryStatus, 'pending');
    assert.equal(stored.deletion, undefined);
    assert.equal(fx.messages.has(messageId), true);

    // Just under the limit is still too early; past it is allowed.
    await fx.ageDelivery(messageId, GIVEAWAY_PENDING_SETTLE_MS - 20_000);
    assert.equal((await fx.prepare(messageId)).canResolve, false);
    await fx.ageDelivery(messageId, 30_000);
    const later = await fx.prepare(messageId);
    assert.equal(later.canResolve, true);
    assert.equal(later.canDelete, true);
});

test('mark delivered records the administrator\'s finding without contacting Discord', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 3);
    await leavePending(fx, messageId, 'send');
    await fx.ageDelivery(messageId);
    const winners = (await fx.read(messageId)).winnerIds;
    const logBefore = fx.log.length;
    fx.audits.length = 0;

    const response = await fx.act(messageId, 'mark_delivered');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { ok: true, winners: 2, entries: 3 });
    assert.equal(fx.log.length, logBefore, 'no Discord request');

    const stored = await fx.read(messageId);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.deepEqual(stored.winnerIds, winners, 'no new draw');
    assert.equal(stored.deliveryResolvedBy, adminId);
    await settle();
    assert.deepEqual(fx.audits[0].slice(0, 3), [guildId, adminId, 'mark_delivered']);

    // The giveaway is usable again: it can be rerolled.
    assert.equal((await fx.prepare(messageId)).canReroll, true);
    assert.equal((await fx.act(messageId, 'reroll')).status, 200);
    // And resolving twice is refused.
    assert.equal((await fx.act(messageId, 'mark_delivered')).body.code, 'GIVEAWAY_STATE');
});

test('redeliver announces the saved winners again, without a new draw', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 5);
    await leavePending(fx, messageId, 'send');
    await fx.ageDelivery(messageId);
    const before = await fx.read(messageId);
    const sendsBefore = fx.sent().length;

    const response = await fx.act(messageId, 'redeliver');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, { ok: true, winners: 2, entries: 5 });

    const after = await fx.read(messageId);
    assert.deepEqual(after.winnerIds, before.winnerIds);
    assert.equal(after.deliveryStatus, 'delivered');
    assert.equal(after.deliveryRetriedBy, adminId);
    assert.notEqual(after.deliveryToken, before.deliveryToken);

    const sends = fx.sent().slice(sendsBefore);
    assert.equal(sends.length, 1);
    assert.equal(after.winnerPingMessageId, sends[0]);
    const announcement = fx.messages.get(sends[0]).payload;
    for (const winner of before.winnerIds) assert.match(announcement.content, new RegExp(winner));
    assert.deepEqual(announcement.allowedMentions, { parse: [], users: before.winnerIds });
    assert.match(fx.messages.get(messageId).payload.content, /GIVEAWAY ENDED/);
});

test('a re-delivery that fails stays pending, and the first attempt can no longer complete', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 3);
    await leavePending(fx, messageId, 'send');
    const first = await fx.read(messageId);
    await fx.ageDelivery(messageId);

    fx.hooks.send = async () => { throw new Error('Discord timeout'); };
    const response = await fx.act(messageId, 'redeliver');
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'GIVEAWAY_DELIVERY_UNKNOWN');
    delete fx.hooks.send;

    const stored = await fx.read(messageId);
    assert.equal(stored.deliveryStatus, 'pending');
    assert.deepEqual(stored.winnerIds, first.winnerIds);
    // A delivery from before the retry that finishes late is not recorded as the result.
    await assert.rejects(
        completePostgresGiveawayDelivery(fx.client, guildId, messageId, first.deliveryToken, '899999999999999999'),
        hasCode('GIVEAWAY_STALE'),
    );
    // The new attempt is itself "possibly running" for a while.
    assert.equal((await fx.act(messageId, 'redeliver')).body.code, 'GIVEAWAY_IN_PROGRESS');
});

test('redeliver verifies the message first and refuses when nothing is pending', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const active = await createGiveaway(fx, 2);
    for (const action of ['mark_delivered', 'redeliver']) {
        const response = await fx.act(active, action);
        assert.equal(response.status, 409, action);
        assert.equal(response.body.code, 'GIVEAWAY_STATE', action);
    }

    const pending = await createGiveaway(fx, 2);
    await leavePending(fx, pending);
    await fx.ageDelivery(pending);
    const token = (await fx.read(pending)).deliveryToken;
    fx.messages.delete(pending);
    const response = await fx.act(pending, 'redeliver');
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'GIVEAWAY_DISCORD_UNVERIFIED');
    assert.equal((await fx.read(pending)).deliveryToken, token, 'no retry was started');

    // With the message gone, the remaining way out is deleting the record.
    assert.equal((await fx.act(pending, 'delete')).body.discord, 'already_gone');
    assert.equal(await fx.read(pending), null);
});

test('records from before claim times existed are treated as settled', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const messageId = await createGiveaway(fx, 2);
    await leavePending(fx, messageId, 'send');
    await fx.pool.query(
        `UPDATE giveaways SET data = (data - 'deliveryClaimedAt') || '{"endedAt":"2020-01-01T00:00:00.000Z"}' WHERE message_id=$1`,
        [messageId],
    );
    assert.equal((await inspectPostgresGiveaway(fx.client, guildId, messageId)).pendingSettled, true);
    assert.equal((await fx.act(messageId, 'mark_delivered')).status, 200);
});

// ---------------------------------------------------------------------------
// Real router
// ---------------------------------------------------------------------------

test('the real dashboard router enforces login, origin and CSRF on create and delete', skip, async (t) => {
    const fx = await createGiveawayFixture(t);
    const request = (path, options = {}) => fetch(fx.baseUrl + path, { redirect: 'manual', ...options });
    const api = '/dashboard/api/bot/giveaway';
    const json = { 'content-type': 'application/json' };

    assert.equal((await request(`${api}/options`)).status, 401);
    assert.equal((await request(`${api}/create`, { method: 'POST', headers: json, body: JSON.stringify(form()) })).status, 401);

    const start = await request('/dashboard/login');
    const stateCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/dashboard/callback?code=mock&state=${state}`, { headers: { cookie: stateCookie } });
    const cookie = callback.headers.getSetCookie().find((x) => x.startsWith('zx_session=')).split(';')[0];
    const me = await (await request('/dashboard/api/me', { headers: { cookie } })).json();
    const post = (path, body, origin, token) => request(`${api}/${path}`, {
        method: 'POST',
        headers: { ...json, cookie, origin, 'x-csrf-token': token },
        body: JSON.stringify(body),
    });

    assert.equal((await post('create', form(), 'http://evil.example', me.csrf)).status, 403);
    assert.equal((await post('create', form(), 'http://localhost:9999', 'wrong')).status, 403);
    assert.deepEqual(fx.sent(), []);

    assert.equal((await request(`${api}/options`, { headers: { cookie } })).status, 200);
    const created = await post('create', form(), 'http://localhost:9999', me.csrf);
    assert.equal(created.status, 200);
    const { messageId } = await created.json();
    assert.equal((await fx.read(messageId)).hostId, adminId);

    const fresh = await (await request(`${api}/prepare?messageId=${messageId}`, { headers: { cookie } })).json();
    const removal = { messageId, action: 'delete', revision: fresh.revision, confirmed: true };
    assert.equal((await post('action', removal, 'http://evil.example', me.csrf)).status, 403);
    assert.equal(fx.messages.has(messageId), true);
    assert.equal((await post('action', removal, 'http://localhost:9999', me.csrf)).status, 200);
    assert.equal(await fx.read(messageId), null);
    assert.equal(fx.messages.has(messageId), false);
});
