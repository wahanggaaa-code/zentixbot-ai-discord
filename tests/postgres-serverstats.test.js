import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { createServerStatsFixture, guildId, missingPermissions } from './helpers/serverstats-fixture.js';
import { pgEnabled, isRefused } from './helpers/leveling-postgres-fixture.js';
import { handleCreate } from '../src/commands/ServerStats/modules/serverstats_create.js';
import { handleList } from '../src/commands/ServerStats/modules/serverstats_list.js';
import { handleUpdate } from '../src/commands/ServerStats/modules/serverstats_update.js';
import { handleDelete } from '../src/commands/ServerStats/modules/serverstats_delete.js';
import counterButton from '../src/handlers/counterButtons.js';
import channelDelete from '../src/events/channelDelete.js';
import {
    createCounter, changeCounterType, deleteCounter, inspectCounters, maintainCounters, pruneMissingCounters,
} from '../src/services/serverStats/manage.js';
import { createCounterRefresher, counterRefresher, countMembers } from '../src/services/serverStats/refresh.js';
import { decodeCounters, mutateCounters, readCounters } from '../src/services/serverStats/store.js';

// Real tables on the disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (expected) => (error) => {
    assert.equal(error.code, expected);
    return true;
};
const voiceChannels = (fx) => [...fx.channels.values()].filter((channel) => channel.type === ChannelType.GuildVoice);
const create = (fx, type, channelType = 'voice') => {
    const i = fx.interaction({ type, channel_type: channelType, category: fx.category });
    return handleCreate(i.it, fx.client).then(() => i);
};
const record = (id, type, channelId, extra = {}) => ({ id, type, channelId, guildId, createdAt: '2026-01-01T00:00:00.000Z', enabled: true, ...extra });

/** A refresher with a clock the test moves, a short wait for slow renames and no audit log. */
function refresherFor(t, options = {}) {
    const clock = { now: 1_000_000 };
    const refresher = createCounterRefresher({ now: () => clock.now, debounceMs: 20, renameWaitMs: 80, audit: false, ...options });
    t.after(() => refresher.stop());
    return { refresher, clock };
}

// ---- storage ------------------------------------------------------------------

test('create: stores the record and creates the channel with its final name, without a rename', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    const i = await create(fx, 'members');

    const stored = await fx.stored();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, 'members');
    assert.equal(stored[0].guildId, guildId);
    const channel = fx.channels.get(stored[0].channelId);
    assert.equal(channel.name, 'Members & Bots-4');
    assert.equal(channel.parentId, fx.category.id);
    assert.equal(fx.calls.rename.length, 0, 'the rename allowance of a new channel is not used up');
    assert.match(i.text(), /Counter Created Successfully/);
    assert.match(i.text(), new RegExp(stored[0].id));
});

test('create: a failed read changes nothing and keeps the other counters', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await fx.store([record('1', 'bots', '830000000000000001')]);
    fx.channels.set('830000000000000001', { id: '830000000000000001', name: 'Bots-1', type: ChannelType.GuildVoice, permissionsFor: () => new PermissionsBitField(PermissionsBitField.All) });
    fx.control.failQuery = (sql) => /SELECT counters/.test(sql);
    const i = await create(fx, 'members');
    fx.control.failQuery = null;

    assert.doesNotMatch(i.text(), /Success/);
    assert.match(i.text(), /database is not available|could not be created/i);
    assert.deepEqual((await fx.stored()).map((counter) => counter.type), ['bots']);
    assert.equal(fx.calls.create.length, 0, 'no channel is created when the stored list cannot be read');
});

test('create: a failed save is reported and the new channel is removed again', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    fx.control.failQuery = (sql) => /UPDATE .*counters/s.test(sql);
    const i = await create(fx, 'members');
    fx.control.failQuery = null;

    assert.doesNotMatch(i.text(), /Success/);
    assert.deepEqual(await fx.stored(), []);
    assert.equal(fx.calls.create.length, 1);
    assert.equal(voiceChannels(fx).length, 0, 'the channel of the unsaved counter is gone');
});

test('create: when the save fails and the channel cannot be removed, the reply names the channel', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    fx.control.failQuery = (sql) => /UPDATE .*counters/s.test(sql);
    fx.hooks.deleteChannel = () => { throw missingPermissions(); };
    const i = await create(fx, 'members');
    fx.control.failQuery = null;

    const [left] = voiceChannels(fx);
    assert.ok(left);
    assert.match(i.text(), /delete that channel by hand/);
    assert.ok(i.text().includes(`<#${left.id}>`));
    assert.deepEqual(await fx.stored(), []);
});

test('create: three types at once are all stored', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await Promise.all(['members', 'bots', 'members_only'].map((type) => create(fx, type)));

    const stored = await fx.stored();
    assert.deepEqual(stored.map((counter) => counter.type).sort(), ['bots', 'members', 'members_only']);
    assert.equal(new Set(stored.map((counter) => counter.id)).size, 3, 'ids are unique');
    assert.equal(voiceChannels(fx).length, 3);
});

test('create: the same type twice at once gives one counter and one channel', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const replies = await Promise.all([create(fx, 'members'), create(fx, 'members')]);

    const stored = await fx.stored();
    assert.equal(stored.length, 1);
    assert.deepEqual(voiceChannels(fx).map((channel) => channel.id), [stored[0].channelId], 'the channel of the losing request is removed');
    assert.equal(replies.filter((reply) => /Created Successfully/.test(reply.text())).length, 1);
    assert.equal(replies.filter((reply) => /already exists/.test(reply.text())).length, 1);
});

test('create: refused without touching Discord when the bot cannot manage channels in the category', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    fx.setBotPermissions(fx.category.id, ['ViewChannel']);
    const i = await create(fx, 'members');

    assert.match(i.text(), /Manage Channels/);
    assert.equal(fx.calls.create.length, 0);
    assert.deepEqual(await fx.stored(), []);
});

test('create: a Discord refusal leaves nothing stored', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    fx.hooks.createChannel = () => { throw missingPermissions(); };
    const i = await create(fx, 'members');

    assert.match(i.text(), /Discord refused/);
    assert.deepEqual(await fx.stored(), []);
});

test('create: validation of type, channel type and category', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const base = { type: 'members', channelType: 'voice', categoryId: fx.category.id };
    const text = fx.makeChannel({ name: 'general', type: ChannelType.GuildText });
    await assert.rejects(createCounter(fx.client, fx.guild, { ...base, type: 'everyone' }), code('SERVERSTATS_TYPE'));
    await assert.rejects(createCounter(fx.client, fx.guild, { ...base, channelType: 'stage' }), code('SERVERSTATS_CHANNEL_TYPE'));
    await assert.rejects(createCounter(fx.client, fx.guild, { ...base, categoryId: text.id }), code('SERVERSTATS_CATEGORY'));
    await assert.rejects(createCounter(fx.client, fx.guild, { ...base, categoryId: '999999999999999999' }), code('SERVERSTATS_CATEGORY'));
    assert.equal(fx.calls.create.length, 0);
});

test('create: a counter whose channel was deleted while the bot was away does not block a new one', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await fx.store([record('1', 'members', '830000000000000009')]);
    const i = await create(fx, 'members');

    assert.match(i.text(), /Created Successfully/);
    const stored = await fx.stored();
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].id, '1');
});

test('store: unusable entries are skipped, a value that is not a list is refused, the list cannot outgrow one per type', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await fx.store([record('1', 'bots', '830000000000000001'), { id: '', type: 'x' }, null, record('1', 'members', '830000000000000002')]);
    const read = await readCounters(fx.client, guildId);
    assert.deepEqual(read.counters.map((counter) => counter.id), ['1']);
    assert.equal(read.rejected, 3);

    await fx.store({ some: 'object' });
    await assert.rejects(readCounters(fx.client, guildId), code('SERVERSTATS_INVALID'));
    await assert.rejects(mutateCounters(fx.client, guildId, () => ({ counters: [] })), code('SERVERSTATS_INVALID'));
    assert.deepEqual(await fx.stored(), { some: 'object' }, 'data this code does not understand is left alone');

    await fx.store([]);
    const four = ['1', '2', '3', '4'].map((id) => record(id, 'members', `83000000000000000${id}`));
    await assert.rejects(mutateCounters(fx.client, guildId, () => ({ counters: four })), code('SERVERSTATS_INVALID'));
    assert.deepEqual(await fx.stored(), []);

    assert.deepEqual(decodeCounters(null, guildId), { counters: [], rejected: 0 });
    assert.equal(decodeCounters(record('7', 'bots', '830000000000000007'), guildId).counters.length, 1, 'a single counter stored without its list');
});

test('store: the generic key-value layer can no longer replace the list', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const before = await fx.stored();
    assert.equal(await isRefused(fx.client.db.set(`guild:${guildId}:counters`, [])), true);
    await isRefused(fx.client.db.delete(`guild:${guildId}:counters`));
    assert.deepEqual(await fx.stored(), before);
});

test('store: a database outage is an error, not an empty list', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    fx.client.db.useFallback = true;
    t.after(() => { fx.client.db.useFallback = false; });
    await assert.rejects(readCounters(fx.client, guildId), code('SERVERSTATS_UNAVAILABLE'));
    await assert.rejects(inspectCounters(fx.client, fx.guild), code('SERVERSTATS_UNAVAILABLE'));
    fx.client.db.useFallback = false;
});

// ---- list -----------------------------------------------------------------------

test('list: a counter whose channel shows the count is "Up to date"; one that is behind says so', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    await create(fx, 'members');
    await create(fx, 'bots');

    let i = fx.interaction();
    await handleList(i.it, fx.client);
    assert.match(i.text(), /Server Counters \(2\)/);
    assert.equal(i.text().match(/\*\*Status:\*\* Up to date/g)?.length, 2);
    assert.match(i.text(), /\*\*Up to date:\*\* 2/);
    assert.match(i.text(), /\*\*Current Count:\*\* 4/);
    assert.match(i.text(), /\*\*Current Count:\*\* 1/);
    assert.doesNotMatch(i.text(), /every 15 minutes|Not Updated/);

    fx.addPerson('710000000000000099');
    i = fx.interaction();
    await handleList(i.it, fx.client);
    assert.match(i.text(), /\*\*Current Count:\*\* 5/);
    assert.match(i.text(), /\*\*Up to date:\*\* 1/);
    assert.match(i.text(), /Will be renamed at the next refresh/);
    assert.equal(fx.calls.rename.length, 0, 'the list reads only');

    // With only a total counter stored, the member list is not needed and not fetched.
    await fx.store((await fx.stored()).filter((counter) => counter.type === 'members'));
    fx.guild.memberCount = 50;
    const fetched = fx.calls.fetchMembers;
    i = fx.interaction();
    await handleList(i.it, fx.client);
    assert.match(i.text(), /\*\*Current Count:\*\* 50/);
    assert.equal(fx.calls.fetchMembers, fetched);
});

test('list: a channel Discord reports as deleted is removed, one that cannot be looked up is kept', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await fx.store([record('1', 'members', '830000000000000001'), record('2', 'bots', '830000000000000002')]);
    fx.hooks.fetchChannel = (id) => { if (id === '830000000000000002') throw new Error('socket hang up'); };

    const i = fx.interaction();
    await handleList(i.it, fx.client);
    assert.deepEqual((await fx.stored()).map((counter) => counter.id), ['2']);
    assert.match(i.text(), /Channel not visible to me/);
});

test('list and the other subcommands refuse a member without Manage Channels', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const [counter] = await fx.stored();
    const member = { ...fx.admin, permissions: new PermissionsBitField([]) };
    const run = async (handler, options) => {
        const i = fx.interaction(options, { member });
        await handler(i.it, fx.client);
        return i.text();
    };
    for (const text of [
        await run(handleList, {}),
        await run(handleCreate, { type: 'bots', channel_type: 'voice', category: fx.category }),
        await run(handleUpdate, { 'counter-id': counter.id, type: 'bots' }),
        await run(handleDelete, { 'counter-id': counter.id }),
    ]) assert.match(text, /You need \*\*Manage Channels\*\*/);
    assert.deepEqual(await fx.stored(), [counter]);
    assert.equal(fx.calls.create.length, 1);
});

// ---- change type ------------------------------------------------------------------

test('update: changes the type and renames the channel', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    const { refresher } = refresherFor(t);
    const { counter } = await createCounter(fx.client, fx.guild, { type: 'members', channelType: 'voice', categoryId: fx.category.id }, { refresher });

    const out = await changeCounterType(fx.client, fx.guild, counter.id, 'bots', { refresher });
    assert.equal(out.changed, true);
    assert.equal(out.previousType, 'members');
    assert.equal(out.refresh.status, 'renamed');
    assert.equal(fx.channels.get(counter.channelId).name, 'Bots-1');
    const [stored] = await fx.stored();
    assert.equal(stored.type, 'bots');
    assert.ok(stored.updatedAt);

    const same = await changeCounterType(fx.client, fx.guild, counter.id, 'bots', { refresher });
    assert.equal(same.changed, false);
    assert.equal((await fx.stored())[0].updatedAt, stored.updatedAt, 'nothing is written when the type is the same');
});

test('update: unknown id, taken type and a stale revision are refused without a write', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher } = refresherFor(t);
    const options = { channelType: 'voice', categoryId: fx.category.id };
    const a = await createCounter(fx.client, fx.guild, { ...options, type: 'members' }, { refresher });
    await createCounter(fx.client, fx.guild, { ...options, type: 'bots' }, { refresher });
    const before = await fx.stored();
    const { revision } = await readCounters(fx.client, guildId);

    await assert.rejects(changeCounterType(fx.client, fx.guild, 'nope', 'members_only', { refresher }), code('SERVERSTATS_MISSING'));
    await assert.rejects(changeCounterType(fx.client, fx.guild, a.counter.id, 'bots', { refresher }), code('SERVERSTATS_DUPLICATE'));
    await assert.rejects(changeCounterType(fx.client, fx.guild, a.counter.id, 'everyone', { refresher }), code('SERVERSTATS_TYPE'));
    await assert.rejects(changeCounterType(fx.client, fx.guild, a.counter.id, 'members_only', { refresher, revision: 'f'.repeat(64) }), code('SERVERSTATS_STALE'));
    assert.deepEqual(await fx.stored(), before);
    assert.equal(fx.calls.rename.length, 0);

    await changeCounterType(fx.client, fx.guild, a.counter.id, 'members_only', { refresher, revision });
    assert.equal((await fx.stored())[0].type, 'members_only');
});

test('update command: reports the change, and says when the rename has to wait', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const [counter] = await fx.stored();

    let i = fx.interaction({ 'counter-id': counter.id, type: 'bots' });
    await handleUpdate(i.it, fx.client);
    assert.match(i.text(), /Counter Updated Successfully/);
    assert.match(i.text(), /Members \+ Bots → Bots Only/);
    assert.match(i.text(), /channel name is up to date/);

    // A second change right away: stored at once, the name follows after Discord's limit.
    i = fx.interaction({ 'counter-id': counter.id, type: 'members_only' });
    await handleUpdate(i.it, fx.client);
    assert.equal((await fx.stored())[0].type, 'members_only');
    assert.match(i.text(), /limits how often a channel can be renamed\. The name will follow <t:\d+:R>/);
    assert.equal(fx.channels.get(counter.channelId).name, 'Bots-1');
    assert.equal(fx.calls.rename.length, 1);

    i = fx.interaction({ 'counter-id': '12345', type: 'bots' });
    await handleUpdate(i.it, fx.client);
    assert.match(i.text(), /no longer exists/);
});

// ---- delete -----------------------------------------------------------------------

test('delete: the command asks first; confirm deletes the channel and then the record', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const [counter] = await fx.stored();

    const ask = fx.interaction({ 'counter-id': counter.id });
    await handleDelete(ask.it, fx.client);
    assert.deepEqual(ask.buttons(), [`counter-delete:confirm:${counter.id}:${fx.admin.id}`, `counter-delete:cancel:${counter.id}:${fx.admin.id}`]);
    assert.equal((await fx.stored()).length, 1, 'nothing is deleted before the confirmation');
    assert.equal(fx.calls.delete.length, 0);

    const cancel = fx.interaction({}, { customId: ask.buttons()[1] });
    await counterButton.execute(cancel.it, fx.client, ['cancel', counter.id, fx.admin.id]);
    assert.equal((await fx.stored()).length, 1);

    const confirm = fx.interaction({}, { customId: ask.buttons()[0] });
    await counterButton.execute(confirm.it, fx.client, ['confirm', counter.id, fx.admin.id]);
    assert.match(confirm.text(), /Counter Deleted Successfully/);
    assert.match(confirm.text(), /\(deleted\)/);
    assert.deepEqual(await fx.stored(), []);
    assert.equal(fx.channels.has(counter.channelId), false);
});

test('delete: the confirm button is refused for another user and for a user who lost Manage Channels', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const [counter] = await fx.stored();

    const other = { ...fx.admin, id: '333333333333333333', user: { id: '333333333333333333', tag: 'other' } };
    let i = fx.interaction({}, { member: other, customId: 'x' });
    await counterButton.execute(i.it, fx.client, ['confirm', counter.id, fx.admin.id]);
    assert.match(i.text(), /Only the user who initiated/);

    const demoted = { ...fx.admin, permissions: new PermissionsBitField([]) };
    i = fx.interaction({}, { member: demoted, customId: 'x' });
    await counterButton.execute(i.it, fx.client, ['confirm', counter.id, fx.admin.id]);
    assert.match(i.text(), /You need \*\*Manage Channels\*\*/);

    assert.equal((await fx.stored()).length, 1);
    assert.equal(fx.calls.delete.length, 0);
});

test('delete: when Discord refuses to delete the channel, the counter stays', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const [counter] = await fx.stored();

    fx.hooks.deleteChannel = () => { throw missingPermissions(); };
    const i = fx.interaction({}, { customId: 'x' });
    await counterButton.execute(i.it, fx.client, ['confirm', counter.id, fx.admin.id]);
    assert.match(i.text(), /Discord refused the channel change\. Nothing was changed/);
    assert.doesNotMatch(i.text(), /Deleted Successfully/);
    assert.deepEqual(await fx.stored(), [counter]);
    assert.equal(fx.channels.has(counter.channelId), true);

    fx.hooks.deleteChannel = null;
    fx.setBotPermissions(counter.channelId, ['ViewChannel']);
    await assert.rejects(deleteCounter(fx.client, fx.guild, counter.id), code('SERVERSTATS_BOT_PERMISSION'));
    assert.equal(fx.calls.delete.length, 1, 'no second attempt is sent without the permission');
    assert.deepEqual(await fx.stored(), [counter]);
});

test('delete: a channel that is already gone, an unknown id, a stale revision, and a channel that is not a counter channel', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await fx.store([record('1', 'members', '830000000000000001'), record('2', 'bots', fx.category.id)]);
    const { revision } = await readCounters(fx.client, guildId);

    await assert.rejects(deleteCounter(fx.client, fx.guild, 'nope'), code('SERVERSTATS_MISSING'));
    await assert.rejects(deleteCounter(fx.client, fx.guild, '1', { revision: '0'.repeat(64) }), code('SERVERSTATS_STALE'));
    assert.equal((await fx.stored()).length, 2);

    const gone = await deleteCounter(fx.client, fx.guild, '1', { revision });
    assert.equal(gone.channelDeleted, false);
    assert.deepEqual((await fx.stored()).map((counter) => counter.id), ['2']);

    // Stored data pointing at a category: the record goes, the category is not deleted.
    const kept = await deleteCounter(fx.client, fx.guild, '2');
    assert.equal(kept.channelKept, true);
    assert.equal(fx.channels.has(fx.category.id), true);
    assert.equal(fx.calls.delete.length, 0);
    assert.deepEqual(await fx.stored(), []);
});

test('delete: a lookup that fails for another reason changes nothing', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await fx.store([record('1', 'members', '830000000000000001')]);
    fx.hooks.fetchChannel = () => { throw new Error('socket hang up'); };
    await assert.rejects(deleteCounter(fx.client, fx.guild, '1'), code('SERVERSTATS_CHANNEL_FAILED'));
    assert.equal((await fx.stored()).length, 1);
});

// ---- channel deleted by hand ----------------------------------------------------------

test('channel delete event: a text counter and a voice counter are both removed; other channels write nothing', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members', 'text');
    await create(fx, 'bots', 'voice');
    const [text, voice] = await fx.stored();
    const before = (await fx.query('SELECT updated_at FROM guilds WHERE id = $1', [guildId])).rows[0].updated_at;

    const unrelated = fx.makeChannel({ name: 'general', type: ChannelType.GuildText });
    fx.channels.delete(unrelated.id);
    await channelDelete.execute(unrelated, fx.client);
    assert.equal((await fx.stored()).length, 2);
    assert.deepEqual((await fx.query('SELECT updated_at FROM guilds WHERE id = $1', [guildId])).rows[0].updated_at, before);

    for (const counter of [text, voice]) {
        const channel = fx.channels.get(counter.channelId);
        fx.channels.delete(channel.id);
        await channelDelete.execute(channel, fx.client);
    }
    assert.deepEqual(await fx.stored(), []);
});

// ---- refresh --------------------------------------------------------------------------

test('refresh: unchanged counts rename nothing, also for a text channel whose name Discord rewrote', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    const { refresher } = refresherFor(t);
    const options = { categoryId: fx.category.id };
    const text = await createCounter(fx.client, fx.guild, { ...options, type: 'members', channelType: 'text' }, { refresher });
    await createCounter(fx.client, fx.guild, { ...options, type: 'bots', channelType: 'voice' }, { refresher });
    assert.equal(text.channel.name, 'members-bots-4', 'the stand-in rewrites text channel names');

    const first = await refresher.run(fx.client, fx.guild);
    const second = await refresher.run(fx.client, fx.guild);
    assert.deepEqual(first.map((result) => result.status), ['current', 'current']);
    assert.deepEqual(second.map((result) => result.status), ['current', 'current']);
    assert.equal(fx.calls.rename.length, 0);
    assert.equal(fx.calls.fetchMembers, 0, 'a complete member cache is not fetched again');
});

test('refresh: a channel is renamed at most once per interval and the last count is applied afterwards', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    const { refresher, clock } = refresherFor(t, { minRenameIntervalMs: 300_000 });
    const { channel } = await createCounter(fx.client, fx.guild, { type: 'members', channelType: 'voice', categoryId: fx.category.id }, { refresher });

    fx.addPerson('710000000000000050');
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'renamed');
    assert.equal(channel.name, 'Members & Bots-5');

    fx.addPerson('710000000000000051');
    fx.addPerson('710000000000000052');
    clock.now += 60_000;
    const held = (await refresher.run(fx.client, fx.guild))[0];
    assert.equal(held.status, 'deferred');
    assert.equal(held.retryAt, 1_000_000 + 300_000);
    assert.equal(channel.name, 'Members & Bots-5');
    assert.equal(fx.calls.rename.length, 1);
    assert.equal(refresher.nextRenameAt(channel.id), 1_300_000);

    clock.now = 1_300_001;
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'renamed');
    assert.equal(channel.name, 'Members & Bots-7');
    assert.equal(fx.calls.rename.length, 2);
});

test('refresh: a deferred rename is retried by a timer without a new request', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    let clock = 1_000_000;
    const refresher = createCounterRefresher({ now: () => clock, minRenameIntervalMs: 150, debounceMs: 10, renameWaitMs: 80, audit: false });
    t.after(() => refresher.stop());
    const { channel } = await createCounter(fx.client, fx.guild, { type: 'members', channelType: 'voice', categoryId: fx.category.id }, { refresher });

    fx.addPerson('710000000000000050');
    await refresher.run(fx.client, fx.guild);
    fx.addPerson('710000000000000051');
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'deferred');
    assert.equal(channel.name, 'Members & Bots-5');

    clock += 1_000;
    await sleep(600);
    assert.equal(channel.name, 'Members & Bots-6');
    assert.equal(fx.calls.rename.length, 2);
});

test('refresh: many joins become one refresh and one rename', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher } = refresherFor(t);
    const { channel } = await createCounter(fx.client, fx.guild, { type: 'members', channelType: 'voice', categoryId: fx.category.id }, { refresher });
    let reads = 0;
    fx.control.delayQuery = (sql) => { if (/SELECT counters/.test(sql)) reads += 1; return 0; };

    for (let n = 0; n < 25; n++) {
        fx.addPerson(String(730000000000000000n + BigInt(n)));
        refresher.schedule(fx.client, fx.guild);
    }
    assert.equal(fx.calls.rename.length, 0, 'schedule returns before anything is done');
    await sleep(300);
    assert.equal(reads, 1);
    assert.equal(fx.calls.rename.length, 1);
    assert.equal(channel.name, 'Members & Bots-29');
});

test('refresh: a rename Discord holds back does not block, is not sent twice, and the newest count follows', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher, clock } = refresherFor(t, { minRenameIntervalMs: 1_000 });
    const { channel } = await createCounter(fx.client, fx.guild, { type: 'members', channelType: 'voice', categoryId: fx.category.id }, { refresher });

    let release;
    fx.hooks.rename = () => new Promise((resolve) => { release = resolve; });
    fx.addPerson('710000000000000050');
    const started = Date.now();
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'slow');
    assert.ok(Date.now() - started < 1_000, 'the refresh gives up waiting');

    fx.addPerson('710000000000000051');
    clock.now += 5_000;
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'pending');
    assert.equal(fx.calls.rename.length, 1, 'no second request is queued behind the first');

    fx.hooks.rename = null;
    release();
    await sleep(300);
    assert.equal(fx.calls.rename.length, 2);
    assert.equal(channel.name, 'Members & Bots-6');
});

test('refresh: a failed rename is reported, the bot permission is checked first, a missing channel is not renamed', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher, clock } = refresherFor(t);
    const options = { channelType: 'voice', categoryId: fx.category.id };
    const a = await createCounter(fx.client, fx.guild, { ...options, type: 'members' }, { refresher });
    const b = await createCounter(fx.client, fx.guild, { ...options, type: 'bots' }, { refresher });
    const c = await createCounter(fx.client, fx.guild, { ...options, type: 'members_only' }, { refresher });

    fx.addPerson('710000000000000050');
    fx.addPerson('720000000000000050', true);
    fx.hooks.rename = (channel) => { if (channel.id === a.channel.id) throw missingPermissions(); };
    fx.setBotPermissions(b.channel.id, ['ViewChannel']);
    fx.channels.delete(c.channel.id);

    const results = await refresher.run(fx.client, fx.guild);
    assert.deepEqual(results.map((result) => result.status), ['failed', 'no_permission', 'missing']);
    assert.deepEqual(fx.calls.rename.map((call) => call.id), [a.channel.id]);
    assert.equal((await fx.stored()).length, 3, 'a refresh never removes a record');

    fx.hooks.rename = null;
    clock.now += 400_000;
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'renamed');
});

test('refresh: when the member list cannot be read, bot and human counters keep their name', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    const { refresher } = refresherFor(t);
    const options = { channelType: 'voice', categoryId: fx.category.id };
    const total = await createCounter(fx.client, fx.guild, { ...options, type: 'members' }, { refresher });
    const bots = await createCounter(fx.client, fx.guild, { ...options, type: 'bots' }, { refresher });

    // The gateway reports 10 members, the cache holds 4, and the full list cannot be fetched.
    fx.guild.memberCount = 10;
    fx.hooks.fetchMembers = () => { throw new Error('Members didn\'t arrive in time.'); };
    const results = await refresher.run(fx.client, fx.guild);
    assert.deepEqual(results.map((result) => result.status), ['renamed', 'count_unknown']);
    assert.equal(total.channel.name, 'Members & Bots-10');
    assert.equal(bots.channel.name, 'Bots-1', 'not replaced by a count taken from a partial list');
    assert.deepEqual(await countMembers(fx.guild), { total: 10, bots: null, humans: null });
    assert.deepEqual(fx.calls.fetchOptions, { time: 15_000 }, 'the member list is not waited for longer than 15 seconds');
});

test('refresh: a disabled counter and an unknown type are left alone and stay stored', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher } = refresherFor(t);
    const a = fx.makeChannel({ name: 'old', type: ChannelType.GuildVoice });
    const b = fx.makeChannel({ name: 'odd', type: ChannelType.GuildVoice });
    await fx.store([record('1', 'members', a.id, { enabled: false }), record('2', 'boosts', b.id)]);

    assert.deepEqual(await refresher.run(fx.client, fx.guild), []);
    const { removed } = await maintainCounters(fx.client, fx.guild, { refresher });
    assert.deepEqual(removed, []);
    assert.equal(fx.calls.rename.length, 0);
    assert.deepEqual((await fx.stored()).map((counter) => [counter.id, counter.enabled]), [['1', false], ['2', true]]);
});

test('refresh: a database failure is thrown by run and only logged by schedule', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher } = refresherFor(t);
    await createCounter(fx.client, fx.guild, { type: 'members', channelType: 'voice', categoryId: fx.category.id }, { refresher });
    fx.addPerson('710000000000000050');
    fx.control.failQuery = (sql) => /SELECT counters/.test(sql);

    await assert.rejects(refresher.run(fx.client, fx.guild), /injected database failure/);
    refresher.schedule(fx.client, fx.guild);
    await sleep(150);
    assert.equal(fx.calls.rename.length, 0);

    fx.control.failQuery = null;
    assert.equal((await refresher.run(fx.client, fx.guild))[0].status, 'renamed');
});

// ---- scheduled upkeep -------------------------------------------------------------------

test('scheduled check: removes only records whose channel is gone, keeps disabled ones, refreshes the rest', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t, { humans: 3, bots: 1 });
    const { refresher } = refresherFor(t);
    const live = fx.makeChannel({ name: 'Members & Bots-1', type: ChannelType.GuildVoice });
    const paused = fx.makeChannel({ name: 'paused', type: ChannelType.GuildVoice });
    await fx.store([
        record('1', 'members', live.id),
        record('2', 'bots', '830000000000000002'),
        record('3', 'members_only', paused.id, { enabled: false }),
    ]);

    const { removed, results } = await maintainCounters(fx.client, fx.guild, { refresher });
    assert.deepEqual(removed.map((counter) => counter.id), ['2']);
    assert.deepEqual((await fx.stored()).map((counter) => counter.id), ['1', '3'], 'the disabled counter is still stored');
    assert.deepEqual(results.map((result) => [result.id, result.status]), [['1', 'renamed']]);
    assert.equal(live.name, 'Members & Bots-4');
    assert.equal(paused.name, 'paused');
    assert.equal(fx.calls.fetchMembers, 0, 'no bot counter is active, so the member list is not fetched');
});

test('scheduled check: a counter created while the check was looking is not removed', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    const { refresher } = refresherFor(t);
    const live = fx.makeChannel({ name: 'Members & Bots-4', type: ChannelType.GuildVoice });
    await fx.store([record('1', 'bots', '830000000000000002')]);

    // While the check asks Discord about the missing channel, another counter is stored.
    fx.hooks.fetchChannel = async () => {
        await fx.store([record('1', 'bots', '830000000000000002'), record('9', 'members', live.id)]);
    };
    const removed = await pruneMissingCounters(fx.client, fx.guild, { refresher });
    assert.deepEqual(removed.map((counter) => counter.id), ['1']);
    assert.deepEqual((await fx.stored()).map((counter) => counter.id), ['9']);

    // A record that was replaced in the meantime (same id, other channel) is not removed either.
    await fx.store([record('1', 'bots', '830000000000000002')]);
    fx.hooks.fetchChannel = async () => {
        await fx.store([record('1', 'bots', live.id)]);
    };
    assert.deepEqual(await pruneMissingCounters(fx.client, fx.guild, { refresher }), []);
    assert.equal((await fx.stored()).length, 1);
});

// ---- member events ----------------------------------------------------------------------

test('member join and leave only request a refresh and do not wait for Discord', { skip }, async (t) => {
    const fx = await createServerStatsFixture(t);
    await create(fx, 'members');
    const { default: guildMemberAdd } = await import('../src/events/guildMemberAdd.js');
    const { default: guildMemberRemove } = await import('../src/events/guildMemberRemove.js');

    const requested = [];
    const realSchedule = counterRefresher.schedule;
    counterRefresher.schedule = (client, guild) => { requested.push(guild.id); };
    t.after(() => { counterRefresher.schedule = realSchedule; });
    // A rename that never comes back, as when Discord holds it for the rate limit.
    fx.hooks.rename = () => new Promise(() => {});

    const id = '710000000000000077';
    const person = {
        id,
        guild: fx.guild,
        client: fx.client,
        joinedTimestamp: Date.now(),
        roles: { add: async () => {}, cache: new Map() },
        user: { id, tag: 'new#0001', username: 'new', displayName: 'new', bot: false, createdTimestamp: 0, toString: () => `<@${id}>`, displayAvatarURL: () => 'https://example.invalid/a.png' },
    };

    fx.addPerson(id);
    await guildMemberAdd.execute(person);
    fx.removePerson(id);
    await guildMemberRemove.execute(person);

    assert.deepEqual(requested, [guildId, guildId]);
    assert.equal(fx.calls.rename.length, 0, 'the handlers themselves rename nothing');
});

test('the scheduled task in app.js hands the home guild to maintainCounters (source check only)', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('async updateAllCounters()'), source.indexOf('async loadHandlers()'));
    assert.match(body, /isHomeGuild\(this, guildId\)/);
    assert.match(body, /await maintainCounters\(this, guild\)/);
    assert.match(source, /cron\.schedule\('\*\/15 \* \* \* \*', runSafeTask\('counter_update', \(\) => this\.updateAllCounters\(\)\)\)/);
});
