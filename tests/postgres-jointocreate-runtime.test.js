import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import {
    joinToCreateTiming,
    handleJoinToCreateVoiceState as handleVoice,
    handleJoinToCreateChannelDelete as handleChannelDelete,
    reconcileJoinToCreate as reconcile,
} from '../src/services/joinToCreateRuntime.js';
import {
    setupJoinToCreate,
    reserveJoinToCreate,
    recordJoinToCreateCreated,
    registerJoinToCreateChannel,
    removeJoinToCreateTrigger,
} from '../src/services/storage/postgresJoinToCreateTransactions.js';
import { initializeJoinToCreate, updateChannelConfig, removeTriggerChannel, getConfiguration, getChannelConfiguration } from '../src/services/joinToCreateService.js';
import { pgEnabled as enabled, GUILD_ID, TRIGGER_ID, snowflake, hasCode, createJtcDatabase, loseCommitResponse } from './helpers/jtc-postgres-fixture.js';
import { createFakeGuild, discordError } from './helpers/fake-discord-guild.js';

const EVERYONE = GUILD_ID;
const STAFF_ROLE = '700000000000000001';
const user = (n) => snowflake(1000 + n);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const originalTiming = { ...joinToCreateTiming };
test.beforeEach(() => Object.assign(joinToCreateTiming, { pendingStaleMs: 250, createTimeoutMs: 100, discordTimeoutMs: 200, cooldownMs: 0 }));
test.after(() => Object.assign(joinToCreateTiming, originalTiming));

/** PostgreSQL + fake guild with a private category, a trigger inside it and a configured Join to Create. */
async function world(t, { configure = true } = {}) {
    const db = await createJtcDatabase(t, 'jtc_rt');
    const discord = createFakeGuild({ id: GUILD_ID });
    db.client.guilds = { cache: new Map([[GUILD_ID, discord.guild]]) };

    const category = discord.addChannel({
        type: ChannelType.GuildCategory,
        name: 'Staff voice',
        overwrites: [
            { id: EVERYONE, type: OverwriteType.Role, deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect },
            { id: STAFF_ROLE, type: OverwriteType.Role, allow: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect },
        ],
    });
    const trigger = discord.addChannel({ name: 'Join to Create', parentId: category.id, channelId: TRIGGER_ID });
    if (configure) await setupJoinToCreate(db.client, GUILD_ID, TRIGGER_ID, { nameTemplate: "{username}'s Room", userLimit: 5, bitrate: 128000 });

    // Moves made by the bot come back as gateway events, like in production.
    const echoes = [];
    discord.hooks.onVoiceChange = (oldState, newState) => echoes.push(handleVoice(db.client, oldState, newState));
    const idle = async () => { while (echoes.length) await echoes.shift(); };

    /** Member changes voice channel (null = disconnect); resolves when the bot finished reacting. */
    const moveTo = async (member, channelId, client = db.client) => {
        const { oldState, newState } = discord.voiceStates(member, channelId);
        const result = await handleVoice(client, oldState, newState);
        await idle();
        return result;
    };
    const tempChannels = async () => (await db.data()).temporaryChannels;
    const pending = async () => Object.values((await db.data()).pendingCreates ?? {});

    return { ...db, discord, guild: discord.guild, category, trigger, moveTo, idle, tempChannels, pending };
}

test('joining the trigger creates a registered channel that mirrors the category, then moves the member in', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1), { username: 'alice' });

    const result = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(result.joined.status, 'created');
    const channel = w.discord.channels.get(result.joined.channelId);
    assert.equal(alice.voice.channelId, channel.id);
    assert.deepEqual(await w.tempChannels(), { [channel.id]: { ownerId: alice.id, triggerChannelId: TRIGGER_ID, createdAt: (await w.tempChannels())[channel.id].createdAt } });
    assert.deepEqual(await w.pending(), []);

    const [options] = w.discord.calls.create;
    assert.equal(options.name, "alice's Room");
    assert.equal(options.type, ChannelType.GuildVoice);
    assert.equal(options.parent, w.category.id);
    assert.equal(options.userLimit, 5);
    assert.equal(options.bitrate, 96000, 'clamped to what the guild allows');
    assert.match(options.reason, /^Join to Create [0-9a-f-]{36}$/);

    // Category overwrites are copied; nothing opens the channel to @everyone.
    const overwrites = Object.fromEntries(options.permissionOverwrites.map((o) => [o.id, o]));
    assert.deepEqual(Object.keys(overwrites).sort(), [EVERYONE, STAFF_ROLE, alice.id].sort());
    assert.ok(new PermissionsBitField(overwrites[EVERYONE].deny).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]));
    assert.equal(new PermissionsBitField(overwrites[EVERYONE].allow).bitfield, 0n);
    assert.equal(overwrites[alice.id].type, OverwriteType.Member);
    assert.ok(new PermissionsBitField(overwrites[alice.id].allow).has([PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers]));
});

test('simultaneous joins: every member gets exactly one channel and no record is lost', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const members = Array.from({ length: 20 }, (_, i) => w.discord.addMember(user(i + 1)));
    // A slow Discord makes overlapping creates the norm rather than the exception.
    w.discord.hooks.create = async (options, make) => { await sleep(2); return make(); };

    const results = await Promise.all(members.map((member) => w.moveTo(member, TRIGGER_ID)));
    assert.ok(results.every((result) => result.joined.status === 'created'));

    const stored = await w.tempChannels();
    assert.equal(Object.keys(stored).length, 20);
    assert.equal(new Set(Object.values(stored).map((info) => info.ownerId)).size, 20);
    assert.equal(w.discord.calls.create.length, 20);
    for (const member of members) assert.equal(stored[member.voice.channelId].ownerId, member.id);
    assert.deepEqual(await w.pending(), []);
});

test('a member who owns a channel is moved back to it; a record whose channel vanished is replaced', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    const bob = w.discord.addMember(user(2));
    const lobby = w.discord.addChannel({ name: 'Lobby' });
    const owned = (await w.moveTo(alice, TRIGGER_ID)).joined.channelId;
    await w.moveTo(bob, owned); // keeps the channel alive

    // Alice ends up in the trigger again while she still owns a channel
    // (for example because an earlier leave event was never delivered).
    alice.voice.channelId = lobby.id;
    const again = await w.moveTo(alice, TRIGGER_ID);
    assert.deepEqual(again.joined, { status: 'existing', channelId: owned });
    assert.equal(alice.voice.channelId, owned);
    assert.equal(w.discord.calls.create.length, 1);

    // The channel disappears without the bot seeing the delete event.
    w.discord.channels.delete(owned);
    alice.voice.channelId = lobby.id;
    bob.voice.channelId = lobby.id;
    const replaced = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(replaced.joined.status, 'created');
    const stored = await w.tempChannels();
    assert.deepEqual(Object.keys(stored), [replaced.joined.channelId]);
    assert.equal(stored[replaced.joined.channelId].ownerId, alice.id);

    // Moving straight from her own channel to the trigger: old one removed, new one created.
    const next = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(next.left.status, 'deleted');
    assert.equal(next.joined.status, 'created');
    assert.equal(w.discord.channels.has(replaced.joined.channelId), false);
    assert.deepEqual(Object.keys(await w.tempChannels()), [next.joined.channelId]);
});

test('an empty channel is deleted in Discord first; a failed delete keeps the record; bots do not keep it alive', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    const musicBot = w.discord.addMember(user(90), { bot: true });
    const channelId = (await w.moveTo(alice, TRIGGER_ID)).joined.channelId;
    musicBot.voice.channelId = channelId;

    w.discord.hooks.delete = async () => { throw discordError(500, 0, 'Internal Server Error'); };
    let result = await w.moveTo(alice, null);
    assert.equal(result.left.status, 'delete_failed');
    assert.ok(w.discord.channels.has(channelId));
    assert.equal((await w.tempChannels())[channelId].ownerId, alice.id, 'record kept while the channel may still exist');

    // Next time someone leaves it, the cleanup is retried.
    w.discord.hooks.delete = null;
    alice.voice.channelId = channelId;
    result = await w.moveTo(alice, null);
    assert.equal(result.left.status, 'deleted');
    assert.equal(w.discord.channels.has(channelId), false);
    assert.deepEqual(await w.tempChannels(), {});
    assert.match(w.discord.calls.delete.at(-1).reason, /empty/);
});

test('owner leaving hands the channel to a remaining member without waiting for the rename', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1), { username: 'alice' });
    const bob = w.discord.addMember(user(2), { username: 'bob' });
    const carol = w.discord.addMember(user(3), { username: 'carol' });
    const channelId = (await w.moveTo(alice, TRIGGER_ID)).joined.channelId;
    const bobsChannel = (await w.moveTo(bob, TRIGGER_ID)).joined.channelId;
    await w.moveTo(bob, channelId);          // Bob's own channel empties and is removed
    assert.equal(w.discord.channels.has(bobsChannel), false);
    await w.moveTo(carol, channelId);

    // Discord rate-limits renames for minutes; the queue must not wait for it.
    w.discord.hooks.rename = () => new Promise(() => {});
    const result = await w.moveTo(alice, null);
    assert.equal(result.left.status, 'transferred');
    assert.equal(result.left.ownerId, bob.id);
    assert.equal((await w.tempChannels())[channelId].ownerId, bob.id);
    assert.deepEqual(w.discord.calls.overwriteEdit.at(-1).targetId, bob.id);
    assert.deepEqual(w.discord.calls.overwriteDelete.at(-1).targetId, alice.id);
    await sleep(5);
    assert.deepEqual(w.discord.calls.rename.at(-1), { channelId, name: "bob's Room", reason: 'Join to Create: new channel owner' });

    // A candidate who is recorded as owner of another channel is skipped:
    // one channel per owner holds even when records and Discord disagree.
    const other = w.discord.addChannel({ name: 'other', parentId: w.category.id });
    const erin = w.discord.addMember(user(5));
    erin.voice.channelId = other.id;
    await registerJoinToCreateChannel(w.client, GUILD_ID, other.id, carol.id, TRIGGER_ID, 1);
    const dave = w.discord.addMember(user(4));
    await w.moveTo(dave, channelId);
    const second = await w.moveTo(bob, null); // remaining: Carol (owns `other`) and Dave
    assert.equal(second.left.ownerId, dave.id);
    assert.equal((await w.tempChannels())[channelId].ownerId, dave.id);
    assert.equal((await w.tempChannels())[other.id].ownerId, carol.id);
});

test('Discord refusing the create releases the reservation, creates nothing and tells the member', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    w.discord.hooks.create = async () => { throw discordError(403, 50013, 'Missing Permissions'); };

    const result = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(result.joined.status, 'rejected');
    assert.deepEqual(await w.pending(), []);
    assert.deepEqual(await w.tempChannels(), {});
    await sleep(5);
    assert.equal(w.discord.calls.dm.length, 1);

    // The next attempt is not blocked by anything left behind.
    w.discord.hooks.create = null;
    alice.voice.channelId = null;
    assert.equal((await w.moveTo(alice, TRIGGER_ID)).joined.status, 'created');

    // Without the needed permissions on the trigger nothing is reserved at all.
    const bob = w.discord.addMember(user(2));
    w.trigger.botHasPermissions = false;
    const creates = w.discord.calls.create.length;
    assert.equal((await w.moveTo(bob, TRIGGER_ID)).joined.status, 'missing_permissions');
    assert.equal(w.discord.calls.create.length, creates);
    assert.deepEqual(await w.pending(), []);
});

test('unknown outcome: a channel that was created is found and cleaned up; otherwise the reservation is released', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));

    // Discord created the channel but the response was a 502.
    let orphan;
    w.discord.hooks.create = async (options, make) => { orphan = make(); throw discordError(502, 0, 'Bad Gateway'); };
    let result = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(result.joined.status, 'uncertain');
    assert.equal(w.discord.channels.has(orphan.id), false, 'the orphan was identified and, being empty, deleted');
    assert.deepEqual(await w.pending(), []);
    assert.deepEqual(await w.tempChannels(), {});
    assert.equal(w.discord.calls.create.length, 1, 'never created a second time');

    // Nothing was created.
    w.discord.hooks.create = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
    alice.voice.channelId = null;
    result = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(result.joined.status, 'uncertain');
    assert.deepEqual(await w.pending(), []);
    assert.equal(w.discord.channels.size, 2, 'only the category and the trigger exist');

    // A channel somebody else made at the same time is not ours: no owner overwrite.
    const unrelated = w.discord.addChannel({ name: 'Made by an admin', parentId: w.category.id });
    alice.voice.channelId = null;
    await w.moveTo(alice, TRIGGER_ID);
    assert.ok(w.discord.channels.has(unrelated.id));
    assert.deepEqual(await w.pending(), []);
});

test('no answer from Discord: the reservation holds until it is stale, then is released; a late channel is removed', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    const bob = w.discord.addMember(user(2));
    let deliver;
    w.discord.hooks.create = (options, make) => new Promise((resolve) => { deliver = () => resolve(make()); });

    const result = await w.moveTo(alice, TRIGGER_ID);
    assert.equal(result.joined.status, 'uncertain');
    assert.equal((await w.pending()).length, 1);

    // While the create may still be in flight nothing else is written:
    // commands are refused, Discord events wait their turn.
    w.discord.hooks.create = null;
    await assert.rejects(updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { userLimit: 2 }), (error) => /try again in a few seconds/.test(error.userMessage));
    const reservedAt = (await w.pending())[0].createdAt;
    const served = await w.moveTo(bob, TRIGGER_ID);
    assert.ok(Date.now() - reservedAt >= joinToCreateTiming.pendingStaleMs, 'waited until the reservation could be checked');
    assert.equal(served.joined.status, 'created', 'stale reservation was released first');
    assert.equal(w.discord.calls.create.length, 2);
    assert.deepEqual(await w.pending(), []);

    // Discord finally answers the first request: nobody is waiting for that channel.
    const before = w.discord.channels.size;
    deliver();
    await sleep(30);
    await w.idle();
    assert.equal(w.discord.channels.size, before, 'late channel deleted again');
    assert.equal(Object.keys(await w.tempChannels()).length, 1);
});

test('a late answer that arrives while the reservation is still open is registered and used', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    w.discord.hooks.create = async (options, make) => { await sleep(joinToCreateTiming.createTimeoutMs + 40); return make(); };

    assert.equal((await w.moveTo(alice, TRIGGER_ID)).joined.status, 'uncertain');
    await sleep(80);
    await w.idle();
    const stored = await w.tempChannels();
    assert.equal(Object.keys(stored).length, 1);
    assert.equal(stored[alice.voice.channelId].ownerId, alice.id);
    assert.deepEqual(await w.pending(), []);
});

test('registration: a lost COMMIT is read back instead of repeated; a permanent failure removes the new channel', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    const bob = w.discord.addMember(user(2));

    // COMMITs of one join: read state, reserve, complete. The third one is "lost".
    const flaky = loseCommitResponse(w.client, w.pool, 3);
    const result = await w.moveTo(alice, TRIGGER_ID, flaky);
    assert.equal(result.joined.status, 'created');
    assert.equal(w.discord.calls.create.length, 1);
    assert.equal((await w.tempChannels())[alice.voice.channelId].ownerId, alice.id);

    // The database refuses to store any second channel.
    await w.pool.query(`CREATE FUNCTION deny_second() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT count(*) FROM jsonb_object_keys(NEW.value->'temporaryChannels')) > 1 THEN RAISE EXCEPTION 'secret database detail'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER deny BEFORE UPDATE ON temp_data FOR EACH ROW EXECUTE FUNCTION deny_second()`);
    const failed = await w.moveTo(bob, TRIGGER_ID);
    assert.equal(failed.joined.status, 'unregistered');
    assert.equal(w.discord.calls.create.length, 2);
    assert.equal(w.discord.channels.size, 3, 'category, trigger and Alice\'s channel: the untracked one was deleted');
    assert.deepEqual(await w.pending(), []);
    assert.equal(Object.keys(await w.tempChannels()).length, 1);
});

test('channel deletions in Discord update the record; removing the trigger keeps existing channels managed', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    const bob = w.discord.addMember(user(2));
    const aliceChannel = w.discord.channels.get((await w.moveTo(alice, TRIGGER_ID)).joined.channelId);
    const bobChannel = w.discord.channels.get((await w.moveTo(bob, TRIGGER_ID)).joined.channelId);

    // An administrator deletes Alice's channel by hand.
    w.discord.channels.delete(aliceChannel.id);
    assert.deepEqual(await handleChannelDelete(w.client, aliceChannel), { triggerRemoved: false, recordRemoved: true });
    assert.deepEqual(Object.keys(await w.tempChannels()), [bobChannel.id]);
    assert.deepEqual(await handleChannelDelete(w.client, aliceChannel), { triggerRemoved: false, recordRemoved: false });
    assert.equal(await handleChannelDelete(w.client, w.category), null, 'categories are ignored');

    // The trigger itself is deleted.
    w.discord.channels.delete(TRIGGER_ID);
    assert.deepEqual(await handleChannelDelete(w.client, w.trigger), { triggerRemoved: true, recordRemoved: false });
    let stored = await w.data();
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.triggerChannels, []);
    assert.deepEqual(Object.keys(stored.temporaryChannels), [bobChannel.id]);

    // Bob's channel is still cleaned up when it empties although the feature is now disabled.
    const result = await w.moveTo(bob, null);
    assert.equal(result.left.status, 'deleted');
    assert.equal(w.discord.channels.has(bobChannel.id), false);
    stored = await w.data();
    assert.deepEqual(stored.temporaryChannels, {});
});

test('startup reconciliation brings records and Discord back in line', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const [alice, bob, carol, dave, erin] = [1, 2, 3, 4, 5].map((n) => w.discord.addMember(user(n)));

    // State left by a previous run:
    const gone = snowflake(7001);                                           // record without a channel
    const empty = w.discord.addChannel({ name: 'empty', parentId: w.category.id });   // channel nobody is in
    const orphaned = w.discord.addChannel({ name: 'owner left', parentId: w.category.id }); // owner left, Carol inside
    const healthy = w.discord.addChannel({ name: 'healthy', parentId: w.category.id });
    await registerJoinToCreateChannel(w.client, GUILD_ID, gone, user(50), TRIGGER_ID, 1);
    await registerJoinToCreateChannel(w.client, GUILD_ID, empty.id, user(51), TRIGGER_ID, 1);
    await registerJoinToCreateChannel(w.client, GUILD_ID, orphaned.id, bob.id, TRIGGER_ID, 1);
    await registerJoinToCreateChannel(w.client, GUILD_ID, healthy.id, dave.id, TRIGGER_ID, 1);
    carol.voice.channelId = orphaned.id;
    dave.voice.channelId = healthy.id;
    erin.voice.channelId = TRIGGER_ID;      // joined the trigger while the bot was down
    alice.voice.channelId = null;

    const summary = await reconcile(w.client, GUILD_ID);
    await w.idle();
    assert.deepEqual(summary, { pendingSettled: 0, recordsRemoved: 1, channelsDeleted: 1, ownersTransferred: 1, triggersRemoved: 0, membersServed: 1, errors: 0 });

    const stored = await w.tempChannels();
    assert.equal(Object.hasOwn(stored, gone), false);
    assert.equal(w.discord.channels.has(empty.id), false);
    assert.equal(stored[orphaned.id].ownerId, carol.id);
    assert.equal(stored[healthy.id].ownerId, dave.id);
    assert.equal(stored[erin.voice.channelId].ownerId, erin.id);
    assert.notEqual(erin.voice.channelId, TRIGGER_ID);

    // A trigger that no longer exists is removed; running again changes nothing else.
    w.discord.channels.delete(TRIGGER_ID);
    const again = await reconcile(w.client, GUILD_ID);
    assert.deepEqual(again, { pendingSettled: 0, recordsRemoved: 0, channelsDeleted: 0, ownersTransferred: 0, triggersRemoved: 1, membersServed: 0, errors: 0 });
    assert.equal((await w.data()).enabled, false);
});

test('startup after a crash in the middle of a create', { skip: !enabled }, async (t) => {
    await t.test('channel exists in Discord and is empty: adopted, then deleted', async (t) => {
        const w = await world(t);
        const alice = w.discord.addMember(user(1));
        await reserveJoinToCreate(w.client, GUILD_ID, alice.id, TRIGGER_ID);
        const left = w.discord.addChannel({ name: "alice's Room", parentId: w.category.id, overwrites: [{ id: alice.id, type: OverwriteType.Member, allow: PermissionFlagsBits.Connect }] });

        const summary = await reconcile(w.client, GUILD_ID);
        assert.equal(summary.pendingSettled, 1);
        assert.equal(w.discord.channels.has(left.id), false);
        assert.deepEqual(await w.pending(), []);
        assert.deepEqual(await w.tempChannels(), {});
    });

    await t.test('channel exists and somebody is inside: adopted and kept', async (t) => {
        const w = await world(t);
        const alice = w.discord.addMember(user(1));
        await reserveJoinToCreate(w.client, GUILD_ID, alice.id, TRIGGER_ID);
        const left = w.discord.addChannel({ name: "alice's Room", parentId: w.category.id, overwrites: [{ id: alice.id, type: OverwriteType.Member, allow: PermissionFlagsBits.Connect }] });
        alice.voice.channelId = left.id;

        await reconcile(w.client, GUILD_ID);
        assert.deepEqual(await w.pending(), []);
        assert.equal((await w.tempChannels())[left.id].ownerId, alice.id);
        assert.ok(w.discord.channels.has(left.id));
    });

    await t.test('no channel: reservation released after it became stale', async (t) => {
        const w = await world(t);
        const started = Date.now();
        await reserveJoinToCreate(w.client, GUILD_ID, user(1), TRIGGER_ID);
        await reconcile(w.client, GUILD_ID);
        assert.ok(Date.now() - started >= joinToCreateTiming.pendingStaleMs - 5, 'waited instead of racing a create that might be in flight');
        assert.deepEqual(await w.pending(), []);
    });

    await t.test('two candidates: neither is touched, the reservation is released', async (t) => {
        const w = await world(t);
        const alice = w.discord.addMember(user(1));
        await reserveJoinToCreate(w.client, GUILD_ID, alice.id, TRIGGER_ID);
        const overwrites = [{ id: alice.id, type: OverwriteType.Member, allow: PermissionFlagsBits.Connect }];
        const a = w.discord.addChannel({ name: 'a', parentId: w.category.id, overwrites });
        const b = w.discord.addChannel({ name: 'b', parentId: w.category.id, overwrites });
        // Not candidates: other category, too old, or without the owner's overwrite.
        const elsewhere = w.discord.addChannel({ name: 'elsewhere', parentId: null, overwrites });
        const old = w.discord.addChannel({ name: 'old', parentId: w.category.id, overwrites, createdTimestamp: Date.now() - 3_600_000 });

        await reconcile(w.client, GUILD_ID);
        for (const channel of [a, b, elsewhere, old]) assert.ok(w.discord.channels.has(channel.id));
        assert.deepEqual(await w.pending(), []);
        assert.deepEqual(await w.tempChannels(), {});
    });

    await t.test('recorded channel ID: used when the channel exists, released when Discord says it does not', async (t) => {
        const w = await world(t);
        const alice = w.discord.addMember(user(1));
        const recorded = w.discord.addChannel({ name: 'recorded', parentId: w.category.id });
        alice.voice.channelId = recorded.id;
        let reservation = await reserveJoinToCreate(w.client, GUILD_ID, alice.id, TRIGGER_ID);
        await recordJoinToCreateCreated(w.client, GUILD_ID, alice.id, TRIGGER_ID, reservation.token, recorded.id);
        await reconcile(w.client, GUILD_ID);
        assert.equal((await w.tempChannels())[recorded.id].ownerId, alice.id);

        const bob = w.discord.addMember(user(2));
        reservation = await reserveJoinToCreate(w.client, GUILD_ID, bob.id, TRIGGER_ID);
        await recordJoinToCreateCreated(w.client, GUILD_ID, bob.id, TRIGGER_ID, reservation.token, snowflake(8888));
        await reconcile(w.client, GUILD_ID);
        assert.deepEqual(await w.pending(), []);
        assert.equal(Object.keys(await w.tempChannels()).length, 1);
    });

    await t.test('Discord cannot be asked: nothing is released or deleted, and a later attempt succeeds', async (t) => {
        const w = await world(t);
        const alice = w.discord.addMember(user(1));
        await reserveJoinToCreate(w.client, GUILD_ID, alice.id, TRIGGER_ID);
        w.discord.hooks.fetchAll = async () => { throw discordError(503, 0, 'Service Unavailable'); };
        await assert.rejects(reconcile(w.client, GUILD_ID), /Service Unavailable/);
        assert.equal((await w.pending()).length, 1);

        // Voice events fail the same way instead of guessing.
        await assert.rejects(w.moveTo(alice, TRIGGER_ID), /Service Unavailable/);
        assert.equal(w.discord.calls.create.length, 0);

        w.discord.hooks.fetchAll = null;
        alice.voice.channelId = null;
        assert.equal((await w.moveTo(alice, TRIGGER_ID)).joined.status, 'created');
        assert.deepEqual(await w.pending(), []);
    });
});

test('events that cannot matter never touch the database', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const alice = w.discord.addMember(user(1));
    const bot = w.discord.addMember(user(90), { bot: true });
    w.backend.isConnected = false; // any query would now throw JTC_UNAVAILABLE

    alice.voice.channelId = TRIGGER_ID;
    const sameChannel = { channelId: TRIGGER_ID, guild: w.guild, member: alice };
    assert.equal(await handleVoice(w.client, sameChannel, { ...sameChannel }), null, 'mute/deafen');
    const { oldState, newState } = w.discord.voiceStates(bot, TRIGGER_ID);
    assert.equal(await handleVoice(w.client, oldState, newState), null, 'bots');
    assert.equal(await handleVoice(w.client, { channelId: null, guild: w.guild, member: null }, { channelId: TRIGGER_ID, guild: w.guild, member: null }), null, 'uncached member');
    assert.equal(await handleChannelDelete(w.client, { id: snowflake(1), type: ChannelType.GuildText, guild: w.guild }), null);

    // A relevant event with the database down fails loudly and creates nothing.
    alice.voice.channelId = null;
    await assert.rejects(w.moveTo(alice, TRIGGER_ID), hasCode('JTC_UNAVAILABLE'));
    assert.equal(w.discord.calls.create.length, 0);
});

test('the generic key/value writer refuses Join to Create keys', { skip: !enabled }, async (t) => {
    const w = await world(t);
    const before = await w.data();
    for (const key of [w.key, `${w.key}:channels`]) {
        assert.equal(await w.backend.set(key, { enabled: false, triggerChannels: [] }), false);
        assert.equal(await w.backend.delete(key), false);
        await assert.rejects(w.backend.increment(key), hasCode('CONFIG_WRITE_DISABLED'));
        await assert.rejects(w.backend.decrement(key), hasCode('CONFIG_WRITE_DISABLED'));
    }
    assert.deepEqual(await w.data(), before);
    assert.equal((await w.pool.query('SELECT count(*)::int AS n FROM temp_data')).rows[0].n, 1);
    assert.deepEqual(await w.backend.get(w.key), before, 'reading stays possible');
});

test('command service validates input, uses the protocol and explains failures', { skip: !enabled }, async (t) => {
    const w = await world(t, { configure: false });
    const userMessage = (pattern) => (error) => error.name === 'ZentixBotError' && pattern.test(error.userMessage);

    await assert.rejects(initializeJoinToCreate(w.client, GUILD_ID, TRIGGER_ID, { nameTemplate: '{unknown} room' }), userMessage(/Unknown placeholder/));
    await assert.rejects(initializeJoinToCreate(w.client, GUILD_ID, TRIGGER_ID, { userLimit: 150 }), userMessage(/between 0/));
    assert.equal(await w.data(), undefined, 'nothing stored for invalid input');

    const config = await initializeJoinToCreate(w.client, GUILD_ID, TRIGGER_ID, { nameTemplate: "{displayName}'s Room", userLimit: 0, bitrate: 64000, categoryId: w.category.id });
    assert.deepEqual(config.triggerChannels, [TRIGGER_ID]);
    assert.deepEqual(config.channelOptions[TRIGGER_ID], { nameTemplate: "{displayName}'s Room", userLimit: 0, bitrate: 64000 });
    await assert.rejects(initializeJoinToCreate(w.client, GUILD_ID, snowflake(5), { userLimit: 0 }), userMessage(/already has a Join to Create channel/));

    assert.deepEqual(await updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { userLimit: 10 }), { nameTemplate: "{displayName}'s Room", userLimit: 10, bitrate: 64000 });
    await updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { bitrate: 96000 });
    assert.deepEqual((await getChannelConfiguration(w.client, GUILD_ID, TRIGGER_ID)).channelConfig, { nameTemplate: "{displayName}'s Room", userLimit: 10, bitrate: 96000 });
    await assert.rejects(updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { bitrate: 999000 }), userMessage(/between 8 and 384/));
    await assert.rejects(updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { userLimit: Number.NaN }), userMessage(/valid number/));
    await assert.rejects(updateChannelConfig(w.client, GUILD_ID, snowflake(5), { userLimit: 1 }), userMessage(/not set up/));
    await assert.rejects(getChannelConfiguration(w.client, GUILD_ID, snowflake(5)), userMessage(/not set up/));

    // The new template is what members get.
    const alice = w.discord.addMember(user(1), { username: 'alice', displayName: 'Alice $& {guild_name}' });
    await w.moveTo(alice, TRIGGER_ID);
    assert.equal(w.discord.calls.create[0].name, "Alice $& {guild_name}'s Room");
    assert.equal(w.discord.calls.create[0].userLimit, 10);

    // An administrator editing while a create is in flight is told to retry; nothing is overwritten.
    const bob = w.discord.addMember(user(2));
    w.discord.hooks.create = () => new Promise(() => {});
    await w.moveTo(bob, TRIGGER_ID);
    await assert.rejects(updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { userLimit: 2 }), userMessage(/try again in a few seconds/));
    await sleep(joinToCreateTiming.pendingStaleMs + 20);
    await updateChannelConfig(w.client, GUILD_ID, TRIGGER_ID, { userLimit: 2 });

    assert.equal(await removeTriggerChannel(w.client, GUILD_ID, TRIGGER_ID), true);
    await assert.rejects(removeTriggerChannel(w.client, GUILD_ID, TRIGGER_ID), userMessage(/not configured/));
    const after = await getConfiguration(w.client, GUILD_ID);
    assert.equal(after.enabled, false);
    assert.equal(Object.values(after.temporaryChannels)[0].ownerId, alice.id, 'existing channels stay registered');

    w.backend.isConnected = false;
    await assert.rejects(getConfiguration(w.client, GUILD_ID), userMessage(/database is currently unavailable/));
    await assert.rejects(removeJoinToCreateTrigger(w.client, GUILD_ID, TRIGGER_ID), hasCode('JTC_UNAVAILABLE'));
});
