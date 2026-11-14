import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageType, PermissionFlagsBits } from 'discord.js';
import { createCountingFixture, GAME_KEY, guildId, memberId, missingPermissions, serverError } from './helpers/counting-fixture.js';
import { pgEnabled, onSQLite, isRefused, assertCommitFailureSaid } from './helpers/leveling-postgres-fixture.js';
import command from '../src/commands/Fun/count.js';
import messageCreate from '../src/events/messageCreate.js';
import {
    MAX_START, countingErrorMessage, disableGame, handleCountingMessage, inspectGame, judgeCount, resetGame, setupGame, topCounters,
} from '../src/services/countingGame/manage.js';
import { decodeGame, emptyGame, mutateGame, readGame, revisionOf } from '../src/services/countingGame/store.js';
import { recordGameChange } from '../src/services/countingGame/audit.js';

// Real tables on the disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const WARNING = 0xFEE75C;
const code = (expected) => (error) => {
    assert.equal(error.code, expected);
    return true;
};
const gameReads = (sql) => /SELECT value FROM/.test(sql) && /temp_data/.test(sql);
const gameWrites = (sql) => /INSERT INTO/.test(sql) && /temp_data/.test(sql);
const run = async (fx, options, who) => {
    const i = fx.count(options, who);
    await command.execute(i.it);
    return i;
};
const say = (fx, member, content, options) => fx.say(messageCreate, member, content, options);

// ---- storage --------------------------------------------------------------------

test('store: no row is an empty game; a failed read is an error, never "no game"', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    assert.deepEqual(await readGame(fx.client, guildId), emptyGame());
    assert.equal(await fx.stored(), undefined, 'reading creates nothing');

    const seeded = await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 9, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 7 } });
    assert.deepEqual(await readGame(fx.client, guildId), seeded);

    fx.control.failQuery = gameReads;
    await assert.rejects(readGame(fx.client, guildId), code('COUNTING_UNAVAILABLE'));
    await assert.rejects(inspectGame(fx.client, fx.guild), code('COUNTING_UNAVAILABLE'));
    fx.control.failQuery = null;
    await assert.rejects(readGame(fx.client, 'not-an-id'), code('COUNTING_INVALID'));
});

test('store: stored fields this code cannot use fall back; a value that is not an object is refused and left alone', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    assert.deepEqual(decodeGame({
        enabled: true, channelId: 'nope', system: 'klingon', nextNumber: -4, lastUserId: 12, currentStreak: 1.5, bestStreak: '9',
        leaderboard: { [fx.bob.id]: 3, [fx.alice.id]: -1, [fx.carol.id]: 2.5, abc: 4, [memberId(7)]: '8' },
    }), { ...emptyGame(), leaderboard: { [fx.bob.id]: 3 } });
    // On without a channel cannot run.
    assert.equal(decodeGame({ enabled: true }).enabled, false);
    assert.equal(decodeGame({ enabled: 'yes', channelId: fx.countChannel.id }).enabled, false);
    assert.deepEqual(decodeGame({ leaderboard: [1, 2] }).leaderboard, {});
    for (const broken of [null, 'broken', 7, [], '[1]', '"x"']) assert.throws(() => decodeGame(broken), code('COUNTING_INVALID'));

    await fx.query('INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb)', [GAME_KEY, JSON.stringify('broken')]);
    await assert.rejects(readGame(fx.client, guildId), code('COUNTING_INVALID'));
    await assert.rejects(setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'decimal' }), code('COUNTING_INVALID'));
    await assert.rejects(disableGame(fx.client, fx.guild), code('COUNTING_INVALID'));
    const message = await say(fx, fx.alice, '1');
    assert.equal(message.deleted, false);
    assert.equal(await fx.stored(), 'broken', 'the unreadable value is still there');
});

test('store: a change is all or nothing', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const before = await fx.seed({ nextNumber: 5, currentStreak: 4 });

    await assert.rejects(mutateGame(fx.client, guildId, async (game) => ({ game })), code('COUNTING_INVALID'));
    await assert.rejects(mutateGame(fx.client, guildId, () => null), code('COUNTING_INVALID'));
    await assert.rejects(mutateGame(fx.client, guildId, (game) => { game.nextNumber = 99; throw Object.assign(new Error('stop'), { code: 'COUNTING_STOP' }); }), code('COUNTING_STOP'));
    await assert.rejects(mutateGame(fx.client, guildId, () => ({ game: 'nonsense' })), code('COUNTING_INVALID'));
    assert.equal(await mutateGame(fx.client, guildId, (game) => { game.nextNumber = 99; return { write: false, result: 'left alone' }; }), 'left alone');
    assert.deepEqual(await fx.stored(), before);

    fx.control.failQuery = gameWrites;
    await assert.rejects(mutateGame(fx.client, guildId, (game) => ({ game: { ...game, nextNumber: 6 } })), code('COUNTING_UNAVAILABLE'));
    fx.control.failQuery = (sql) => sql === 'COMMIT';
    await assert.rejects(mutateGame(fx.client, guildId, (game) => ({ game: { ...game, nextNumber: 6 } })), code(onSQLite ? 'COUNTING_UNAVAILABLE' : 'COUNTING_UNCERTAIN'));
    fx.control.failQuery = null;
    assert.deepEqual(await fx.stored(), before);

    assert.equal(await mutateGame(fx.client, guildId, (game) => ({ game: { ...game, nextNumber: 6 }, result: 'stored' })), 'stored');
    assert.equal((await fx.stored()).nextNumber, 6);
    // What is stored is always the cleaned form.
    await mutateGame(fx.client, guildId, (game) => ({ game: { ...game, extra: 'x', leaderboard: { abc: 1, [fx.bob.id]: 2 } } }));
    assert.deepEqual(await fx.stored(), { ...before, nextNumber: 6, leaderboard: { [fx.bob.id]: 2 } });
});

test('store: the generic key-value layer can read the game but can no longer replace or delete it', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const before = await fx.seed({ nextNumber: 5, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 } });
    assert.equal(await isRefused(fx.client.db.set(GAME_KEY, { enabled: false })), true);
    assert.equal(await isRefused(fx.client.db.delete(GAME_KEY)), true);
    assert.deepEqual(await fx.stored(), before);
    assert.deepEqual(await fx.client.db.get(GAME_KEY), before);
});

// ---- rules ----------------------------------------------------------------------

test('setup: turns the game on; scores survive a new setup; the same settings change nothing', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const first = await setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'decimal' });
    assert.equal(first.changed, true);
    assert.deepEqual(await fx.stored(), { ...emptyGame(), enabled: true, channelId: fx.countChannel.id });

    await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 30, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 70 } });
    let writes = 0;
    fx.control.failQuery = (sql) => { if (gameWrites(sql)) writes++; return false; };
    const again = await setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'decimal' });
    fx.control.failQuery = null;
    assert.equal(again.changed, false);
    assert.equal(writes, 0, 'nothing is written when nothing changes');
    assert.equal((await fx.stored()).nextNumber, 5);

    // Another system: the numbers are written differently, so the sequence starts over. Scores stay.
    const hex = await setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'hexadecimal' });
    assert.equal(hex.changed, true);
    assert.deepEqual(await fx.stored(), {
        enabled: true, channelId: fx.countChannel.id, system: 'hexadecimal', nextNumber: 1, lastUserId: null, currentStreak: 0, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 },
    });

    // Off, then on again in another channel: still the same scores.
    await disableGame(fx.client, fx.guild);
    await setupGame(fx.client, fx.guild, { channelId: fx.otherChannel.id, system: 'roman' });
    const stored = await fx.stored();
    assert.deepEqual([stored.enabled, stored.channelId, stored.system, stored.bestStreak, stored.leaderboard], [true, fx.otherChannel.id, 'roman', 30, { [fx.bob.id]: 70 }]);
});

test('setup: refused for an unknown system, a channel that is not a text channel of this server, missing bot permissions or a game running elsewhere', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const voice = fx.makeChannel({ id: '443456789012345703', name: 'voice', type: ChannelType.GuildVoice });
    const news = fx.makeChannel({ id: '443456789012345704', name: 'news', type: ChannelType.GuildAnnouncement });
    const go = (extra) => setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'decimal', ...extra });

    for (const system of ['klingon', '', undefined, 'toString', 5]) await assert.rejects(go({ system }), code('COUNTING_SYSTEM'));
    for (const channelId of [voice.id, news.id, '443456789012345999', 'abc', undefined, guildId]) await assert.rejects(go({ channelId }), code('COUNTING_CHANNEL'));

    for (const [allowed, missing] of [
        [['ViewChannel', 'SendMessages'], ['ManageMessages']],
        [['ViewChannel', 'ManageMessages'], ['SendMessages']],
        [['SendMessages', 'ManageMessages'], ['ViewChannel']],
        [[], ['ViewChannel', 'SendMessages', 'ManageMessages']],
    ]) {
        fx.setBotPermissions(fx.countChannel.id, allowed);
        await assert.rejects(go(), (error) => {
            assert.equal(error.code, 'COUNTING_BOT_PERMISSION');
            assert.deepEqual(error.missing, missing);
            return true;
        });
    }
    assert.equal(await fx.stored(), undefined, 'a refused setup stores nothing');
    assert.match(countingErrorMessage({ code: 'COUNTING_BOT_PERMISSION', missing: ['SendMessages', 'ManageMessages'] }, 'en', 'x'), /Missing: Send Messages, Manage Messages\.$/);
    assert.match(countingErrorMessage({ code: 'COUNTING_BOT_PERMISSION', missing: ['ViewChannel'] }, 'id', 'x'), /Izin yang kurang: View Channel\.$/);
    assert.equal(countingErrorMessage({ code: 'SOMETHING_ELSE' }, 'en', 'fallback'), 'fallback');

    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel', 'SendMessages', 'ManageMessages']);
    await go();
    const before = await fx.stored();
    await assert.rejects(go({ channelId: fx.otherChannel.id }), (error) => {
        assert.equal(error.code, 'COUNTING_ACTIVE_ELSEWHERE');
        assert.equal(error.channelId, fx.countChannel.id);
        return true;
    });
    assert.deepEqual(await fx.stored(), before);
});

test('disable keeps channel, system and scores; reset starts over and clears scores only when asked', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await assert.rejects(resetGame(fx.client, fx.guild), code('COUNTING_NOT_ENABLED'));
    assert.equal((await disableGame(fx.client, fx.guild)).changed, false);
    assert.equal(await fx.stored(), undefined, 'nothing is created by a change that does nothing');

    const seeded = await fx.seed({ system: 'binary', nextNumber: 5, currentStreak: 4, bestStreak: 30, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 70 } });
    for (const start of [0, -1, 1.5, MAX_START + 1, '5', NaN, null]) await assert.rejects(resetGame(fx.client, fx.guild, { start }), code('COUNTING_START'));
    await assert.rejects(resetGame(fx.client, fx.guild, { clearScores: 'yes' }), code('COUNTING_START'));
    assert.deepEqual(await fx.stored(), seeded);

    await resetGame(fx.client, fx.guild, { start: 100 });
    assert.deepEqual(await fx.stored(), { ...seeded, nextNumber: 100, currentStreak: 0, lastUserId: null });
    await resetGame(fx.client, fx.guild, { start: MAX_START });
    assert.equal((await fx.stored()).nextNumber, MAX_START);
    await resetGame(fx.client, fx.guild, { clearScores: true });
    assert.deepEqual(await fx.stored(), { ...seeded, nextNumber: 1, currentStreak: 0, lastUserId: null, bestStreak: 0, leaderboard: {} });

    await fx.seed(seeded);
    assert.equal((await disableGame(fx.client, fx.guild)).changed, true);
    assert.deepEqual(await fx.stored(), { ...seeded, enabled: false });
    assert.equal((await disableGame(fx.client, fx.guild)).changed, false);
    await assert.rejects(resetGame(fx.client, fx.guild), code('COUNTING_NOT_ENABLED'));
});

test('revision: a change made on an outdated view is refused; counting does not outdate a view', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed({ nextNumber: 5 });
    const { revision } = await inspectGame(fx.client, fx.guild);
    await say(fx, fx.alice, '5');
    assert.equal((await inspectGame(fx.client, fx.guild)).revision, revision, 'a count is not a settings change');
    assert.equal(revision, revisionOf(await readGame(fx.client, guildId)));

    await setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'roman', revision });
    const before = await fx.stored();
    await assert.rejects(setupGame(fx.client, fx.guild, { channelId: fx.countChannel.id, system: 'binary', revision }), code('COUNTING_STALE'));
    await assert.rejects(resetGame(fx.client, fx.guild, { start: 9, revision }), code('COUNTING_STALE'));
    await assert.rejects(disableGame(fx.client, fx.guild, { revision }), code('COUNTING_STALE'));
    assert.deepEqual(await fx.stored(), before);
    const fresh = (await inspectGame(fx.client, fx.guild)).revision;
    assert.equal((await disableGame(fx.client, fx.guild, { revision: fresh })).changed, true);
});

test('inspect: says whether the game can run, and shortens a number too long to show', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    assert.equal((await inspectGame(fx.client, fx.guild)).health.state, 'none');
    await fx.seed({ nextNumber: 12, system: 'roman', leaderboard: { [fx.bob.id]: 2, [fx.alice.id]: 9 } });
    const view = await inspectGame(fx.client, fx.guild);
    assert.deepEqual([view.health, view.expected, view.players], [{ state: 'ok', missing: [] }, 'XII', 2]);
    assert.deepEqual(view.top, [{ userId: fx.alice.id, counts: 9 }, { userId: fx.bob.id, counts: 2 }]);

    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel', 'SendMessages']);
    assert.deepEqual((await inspectGame(fx.client, fx.guild)).health, { state: 'permissions', missing: ['ManageMessages'] });
    fx.channels.delete(fx.countChannel.id);
    assert.deepEqual((await inspectGame(fx.client, fx.guild)).health, { state: 'channel_missing', missing: [] });
    await fx.seed({ enabled: false });
    assert.equal((await inspectGame(fx.client, fx.guild)).health.state, 'off');

    // Data from before the start limit existed.
    await fx.seed({ system: 'roman', nextNumber: 50_000_000 });
    const long = (await inspectGame(fx.client, fx.guild)).expected;
    assert.match(long, /^M{100}… \(50000 characters\)$/);
});

test('leaderboard order: most counts first, ties in a fixed order, ten at most', () => {
    const leaderboard = Object.fromEntries(Array.from({ length: 14 }, (_, n) => [memberId(n + 1), n < 4 ? 5 : n]));
    const top = topCounters({ leaderboard });
    assert.equal(top.length, 10);
    assert.deepEqual(top.map((entry) => entry.counts), [13, 12, 11, 10, 9, 8, 7, 6, 5, 5]);
    assert.deepEqual(top.slice(-2).map((entry) => entry.userId), [memberId(1), memberId(2)], 'ties by user id');
    assert.deepEqual(topCounters({ leaderboard: {} }), []);
});

// ---- messages -------------------------------------------------------------------

test('counting: a right number moves the game on and is left in the channel', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed();
    const sent = [];
    for (const [member, text] of [[fx.alice, '1'], [fx.bob, ' 2 '], [fx.alice, '3'], [fx.carol, '4'], [fx.alice, '5']]) sent.push(await say(fx, member, text));
    assert.deepEqual(sent.map((message) => message.deleted), [false, false, false, false, false]);
    assert.deepEqual(fx.posted(), []);
    assert.deepEqual(fx.calls.reactions, []);
    assert.deepEqual(await fx.stored(), {
        enabled: true, channelId: fx.countChannel.id, system: 'decimal', nextNumber: 6, lastUserId: fx.alice.id, currentStreak: 5, bestStreak: 5,
        leaderboard: { [fx.alice.id]: 3, [fx.bob.id]: 1, [fx.carol.id]: 1 },
    });
    assert.equal(await handleCountingMessage(fx.client, fx.message(fx.bob, '6')), true, 'the caller is told the message belonged to the game');
});

test('counting: a wrong number is stored as a reset first, then deleted and announced', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 9, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 7 } });
    const seen = [];
    fx.hooks.deleteUserMessage = async () => { seen.push(['delete', (await fx.stored()).nextNumber]); };
    fx.hooks.send = async () => { seen.push(['notice', (await fx.stored()).nextNumber]); };

    const message = await say(fx, fx.alice, '7');
    assert.equal(message.deleted, true);
    assert.deepEqual(seen, [['delete', 1], ['notice', 1]], 'the reset was already stored when Discord was touched');
    assert.deepEqual(fx.posted(), [`❌ Count broken by <@${fx.alice.id}>. The next count was **5**. The sequence has been reset to **1**.`]);
    assert.deepEqual(await fx.stored(), {
        enabled: true, channelId: fx.countChannel.id, system: 'decimal', nextNumber: 1, lastUserId: null, currentStreak: 0, bestStreak: 9, leaderboard: { [fx.bob.id]: 7 },
    });
    // The member who broke it may start again.
    assert.equal((await say(fx, fx.alice, '1')).deleted, false);
    assert.equal((await fx.stored()).nextNumber, 2);
});

test('counting: the same member twice in a row breaks the count, even with the right number', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed({ nextNumber: 5, currentStreak: 4, lastUserId: fx.alice.id });
    const message = await say(fx, fx.alice, '5');
    assert.equal(message.deleted, true);
    assert.deepEqual(fx.posted(), [`❌ Count broken by <@${fx.alice.id}>. The same member may not count twice in a row. The sequence has been reset to **1**.`]);
    assert.deepEqual([(await fx.stored()).nextNumber, (await fx.stored()).currentStreak], [1, 0]);
});

test('counting: ordinary chat in the counting channel breaks the count; at the very start nothing needs storing', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed({ nextNumber: 3, currentStreak: 2, lastUserId: fx.bob.id });
    for (const text of ['hello', '', '3 lol']) {
        await fx.seed({ nextNumber: 3, currentStreak: 2, lastUserId: fx.bob.id });
        assert.equal((await say(fx, fx.alice, text)).deleted, true, JSON.stringify(text));
        assert.equal((await fx.stored()).nextNumber, 1);
    }
    assert.equal(fx.posted().length, 3);

    let writes = 0;
    fx.control.failQuery = (sql) => { if (gameWrites(sql)) writes++; return false; };
    const message = await say(fx, fx.carol, 'anyone here?');
    fx.control.failQuery = null;
    assert.equal(message.deleted, true);
    assert.equal(fx.posted().length, 4, 'still announced');
    assert.equal(writes, 0);
    // A reset to a later start is a state worth resetting.
    await resetGame(fx.client, fx.guild, { start: 50 });
    await say(fx, fx.carol, 'oops');
    assert.equal((await fx.stored()).nextNumber, 1);
});

test('counting: other channels, a disabled game and messages nobody wrote are not judged', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const seeded = await fx.seed({ nextNumber: 5, currentStreak: 4 });

    const elsewhere = fx.message(fx.alice, 'hello', { channel: fx.otherChannel });
    assert.equal(await handleCountingMessage(fx.client, elsewhere), false, 'left to prefix commands and leveling');
    assert.equal(elsewhere.deleted, false);

    // Discord's own notices in the counting channel: a member joined, a pin, a boost, a thread.
    for (const type of [MessageType.UserJoin, MessageType.ChannelPinnedMessage, MessageType.GuildBoost, MessageType.ThreadCreated]) {
        const notice = fx.message(fx.alice, '', { type, system: true });
        assert.equal(await handleCountingMessage(fx.client, notice), true, 'not handed on either');
        assert.equal(notice.deleted, false);
    }
    const webhook = fx.message(fx.alice, 'feed');
    webhook.webhookId = '443456789012345777';
    await handleCountingMessage(fx.client, webhook);
    // Bots are dropped by the event itself.
    const bot = await say(fx, fx.alice, 'beep', { bot: true });
    assert.deepEqual([webhook.deleted, bot.deleted], [false, false]);
    // A reply is a member's message like any other.
    assert.equal((await say(fx, fx.alice, '5', { type: MessageType.Reply })).deleted, false);
    assert.deepEqual(await fx.stored(), { ...seeded, nextNumber: 6, currentStreak: 5, bestStreak: 5, lastUserId: fx.alice.id, leaderboard: { [fx.alice.id]: 1 } });
    assert.deepEqual(fx.posted(), []);

    const off = await fx.seed({ enabled: false, nextNumber: 5 });
    const ignored = fx.message(fx.bob, 'hello');
    assert.equal(await handleCountingMessage(fx.client, ignored), false);
    assert.equal(ignored.deleted, false);
    assert.deepEqual(await fx.stored(), off);
    // Turned off between the first look and the judgement.
    assert.deepEqual(await judgeCount(fx.client, guildId, { channelId: fx.countChannel.id, userId: fx.bob.id, content: '5' }), { outcome: 'ignored' });
});

test('counting: when the database fails nothing is deleted, nothing is announced and the game is untouched', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const seeded = await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 9, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 7 } });

    for (const [name, failing] of [
        ['first read', gameReads],
        ['read inside the change', (sql) => /FOR UPDATE/.test(sql)],
        ['write', gameWrites],
        ['commit', (sql) => sql === 'COMMIT'],
    ]) {
        for (const text of ['5', 'wrong']) {
            fx.control.failQuery = failing;
            const message = fx.message(fx.alice, text);
            assert.equal(await handleCountingMessage(fx.client, message), false, `${name} / ${text}`);
            fx.control.failQuery = null;
            assert.equal(message.deleted, false, `${name} / ${text}: message kept`);
            assert.deepEqual(await fx.stored(), seeded, `${name} / ${text}: game untouched`);
        }
    }
    assert.deepEqual(fx.posted(), []);
    // Afterwards the game goes on where it was.
    await say(fx, fx.alice, '5');
    assert.equal((await fx.stored()).nextNumber, 6);
});

test('counting: the same number sent twice at once is accepted exactly once', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    for (let round = 0; round < 6; round++) {
        await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 4, lastUserId: fx.carol.id });
        fx.control.delayQuery = (sql) => (gameWrites(sql) ? 25 : 0);
        const messages = await Promise.all([say(fx, fx.alice, '5'), say(fx, fx.bob, '5')]);
        fx.control.delayQuery = null;
        assert.equal(messages.filter((message) => message.deleted).length, 1, `round ${round}: one of the two was the wrong one`);
        const stored = await fx.stored();
        assert.deepEqual([stored.nextNumber, stored.currentStreak, stored.bestStreak], [1, 0, 5]);
        assert.equal(Object.values(stored.leaderboard).reduce((sum, counts) => sum + counts, 0), 1, 'one point for one accepted count');
    }
    assert.equal(fx.posted().length, 6);
});

test('counting: many members counting at once never lose a point', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed();
    const members = Array.from({ length: 6 }, (_, n) => fx.addMember(memberId(20 + n)));
    // Everyone sends every number; for each number exactly one message can be right.
    const results = await Promise.all(Array.from({ length: 4 }, (_, n) => String(n + 1))
        .flatMap((text) => members.map((member) => judgeCount(fx.client, guildId, { channelId: fx.countChannel.id, userId: member.id, content: text }))));
    const stored = await fx.stored();
    const correct = results.filter((result) => result.outcome === 'correct').length;
    const points = Object.values(stored.leaderboard).reduce((sum, counts) => sum + counts, 0);
    assert.equal(results.length, 24);
    assert.ok(correct >= 1);
    assert.equal(points, correct, 'every accepted count is on the leaderboard, once');
    assert.ok(stored.bestStreak >= stored.currentStreak && stored.bestStreak <= correct);
    assert.ok(stored.nextNumber === stored.currentStreak + 1);
});

test('counting: Discord refusing the delete or the notice changes nothing about the stored reset', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed({ nextNumber: 5, currentStreak: 4 });
    fx.hooks.deleteUserMessage = () => { throw missingPermissions(); };
    const kept = fx.message(fx.alice, 'nope');
    assert.equal(await handleCountingMessage(fx.client, kept), true);
    assert.equal(kept.deleted, false);
    assert.equal(fx.posted().length, 1, 'the notice is still posted');
    assert.equal((await fx.stored()).nextNumber, 1);

    await fx.seed({ nextNumber: 5, currentStreak: 4 });
    fx.hooks.deleteUserMessage = null;
    fx.hooks.send = () => { throw serverError(); };
    const removed = fx.message(fx.alice, 'nope');
    assert.equal(await handleCountingMessage(fx.client, removed), true, 'no error escapes');
    assert.equal(removed.deleted, true);
    assert.equal(fx.posted().length, 1);
    assert.equal((await fx.stored()).nextNumber, 1);
});

test('counting in other systems: lower-case hexadecimal, roman numerals and a calculation', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.seed({ system: 'hexadecimal', nextNumber: 10 });
    assert.equal((await say(fx, fx.alice, 'a')).deleted, false);
    assert.equal((await say(fx, fx.bob, 'B')).deleted, false);
    assert.equal((await fx.stored()).nextNumber, 12);
    assert.equal((await say(fx, fx.alice, '12')).deleted, true, 'decimal 12 is not the next hexadecimal number');
    assert.match(fx.posted().at(-1), /The next count was \*\*C\*\*/);

    await fx.seed({ system: 'roman', nextNumber: 4 });
    assert.equal((await say(fx, fx.alice, 'iv')).deleted, false);
    assert.equal((await say(fx, fx.bob, 'IIIII')).deleted, true);

    await fx.seed({ system: 'math', nextNumber: 16 });
    assert.equal((await say(fx, fx.alice, '4*4=16')).deleted, false);
    assert.equal((await say(fx, fx.bob, '(20-3)')).deleted, false);
    assert.equal((await say(fx, fx.alice, 'process.exit()')).deleted, true);
    assert.equal((await fx.stored()).nextNumber, 1);
});

// ---- /count ---------------------------------------------------------------------

test('/count: changing the game needs Manage Server; looking at it does not', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const seeded = await fx.seed({ nextNumber: 5, leaderboard: { [fx.bob.id]: 7 } });
    for (const options of [{ subcommand: 'setup', channel: fx.countChannel, system: 'roman' }, { subcommand: 'disable' }, { subcommand: 'reset', start: 9 }]) {
        const i = await run(fx, options, { member: fx.alice });
        assert.match(i.last(), /Permission Denied\nYou need the \*\*Manage Server\*\* permission to change the counting game\./);
    }
    assert.deepEqual(await fx.stored(), seeded);
    assert.match((await run(fx, { subcommand: 'status' }, { member: fx.alice })).last(), /Counting Game Status[\s\S]*Next count: 5/);
    assert.match((await run(fx, { subcommand: 'leaderboard' }, { member: fx.alice })).last(), /Counting Game Leaderboard/);

    assert.equal(BigInt(command.data.default_member_permissions), PermissionFlagsBits.ManageGuild);
    const reset = command.data.toJSON().options.find((option) => option.name === 'reset');
    assert.deepEqual(reset.options.map((option) => [option.name, option.max_value ?? null]), [['start', MAX_START], ['clear_scores', null]]);
});

test('/count setup, reset and disable: the reply says what was stored', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const made = await run(fx, { subcommand: 'setup', channel: fx.countChannel, system: 'roman' });
    assert.match(made.last(), new RegExp(`Counting Game Enabled\\nThe counting game is now active in <#${fx.countChannel.id}> using the \\*\\*Roman\\*\\* system\\.`));
    assert.deepEqual(await fx.stored(), { ...emptyGame(), enabled: true, channelId: fx.countChannel.id, system: 'roman' });

    await fx.seed({ system: 'roman', nextNumber: 5, currentStreak: 4, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 } });
    const again = await run(fx, { subcommand: 'setup', channel: fx.countChannel, system: 'roman' });
    assert.match(again.last(), /Counting Game Already Active[\s\S]*Nothing was changed\./);
    assert.deepEqual([(await fx.stored()).nextNumber, (await fx.stored()).bestStreak], [5, 30]);

    const moved = await run(fx, { subcommand: 'setup', channel: fx.otherChannel, system: 'roman' });
    assert.match(moved.last(), new RegExp(`already running in <#${fx.countChannel.id}>\\. Disable it first`));

    const reset = await run(fx, { subcommand: 'reset', start: 40 });
    assert.match(reset.last(), new RegExp(`Counting Game Reset\\nThe counting sequence has been reset\\. Start again with \\*\\*40\\*\\* in <#${fx.countChannel.id}>\\.$`));
    assert.deepEqual([(await fx.stored()).nextNumber, (await fx.stored()).leaderboard], [40, { [fx.bob.id]: 70 }]);
    const cleared = await run(fx, { subcommand: 'reset', clear_scores: true });
    assert.match(cleared.last(), /Start again with \*\*1\*\*[\s\S]*The leaderboard and the best streak were cleared\./);
    assert.deepEqual([(await fx.stored()).nextNumber, (await fx.stored()).bestStreak, (await fx.stored()).leaderboard], [1, 0, {}]);
    assert.match((await run(fx, { subcommand: 'reset', start: MAX_START + 1 })).last(), /The start number must be between 1 and 1000000\./);

    const off = await run(fx, { subcommand: 'disable' });
    assert.match(off.last(), /Counting Game Disabled\nThe counting game has been disabled\./);
    assert.equal((await fx.stored()).enabled, false);
    assert.match((await run(fx, { subcommand: 'disable' })).last(), /already disabled/);
    assert.match((await run(fx, { subcommand: 'reset' })).last(), /Enable the counting game first/);
});

test('/count setup: refused with the missing permissions named when the bot cannot run the game in that channel', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel']);
    const i = await run(fx, { subcommand: 'setup', channel: fx.countChannel, system: 'decimal' });
    assert.match(i.last(), /Permission Denied\nI am missing permissions in that channel\. Nothing was changed\. Missing: Send Messages, Manage Messages\./);
    assert.equal(await fx.stored(), undefined);
});

test('/count: a database failure is reported as one, never as done', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    const seeded = await fx.seed({ nextNumber: 5, currentStreak: 4, bestStreak: 30, leaderboard: { [fx.bob.id]: 70 } });
    const all = [
        { subcommand: 'setup', channel: fx.countChannel, system: 'roman' }, { subcommand: 'disable' }, { subcommand: 'reset', start: 9 },
        { subcommand: 'status' }, { subcommand: 'leaderboard' },
    ];
    for (const [name, failing, changes] of [
        ['read', (sql) => gameReads(sql), all],
        ['write', gameWrites, all.slice(0, 3)],
    ]) {
        for (const options of changes) {
            fx.control.failQuery = failing;
            const i = await run(fx, options);
            fx.control.failQuery = null;
            assert.match(i.last(), /^Database Error\nThe database could not be reached\. Nothing was changed\.$/, `${name} / ${options.subcommand}`);
            assert.doesNotMatch(i.text(), /Enabled|has been disabled|has been reset|already disabled|Injected|injected/, `${name} / ${options.subcommand}`);
            assert.deepEqual(await fx.stored(), seeded, `${name} / ${options.subcommand}`);
        }
    }
    fx.control.failQuery = (sql) => sql === 'COMMIT';
    const unsure = await run(fx, { subcommand: 'disable' });
    fx.control.failQuery = null;
    assertCommitFailureSaid(unsure.last(), /Database Error\nThe database did not confirm the change\. Check `\/count status` before trying again\./, /Database Error\nThe database could not b/);
});

test('/count status and leaderboard: what is stored, with a warning when the game cannot run', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    assert.match((await run(fx, { subcommand: 'status' })).last(), /Enabled: No\nChannel: Not configured\nSystem: Decimal\nNext count: 1\nCurrent streak: 0\nBest streak: 0\nLast counter: None/);
    assert.match((await run(fx, { subcommand: 'leaderboard' })).last(), /No counts have been recorded yet\./);

    await fx.seed({ system: 'hexadecimal', nextNumber: 255, currentStreak: 3, bestStreak: 30, lastUserId: fx.bob.id, leaderboard: { [fx.bob.id]: 70, [fx.alice.id]: 1, [fx.carol.id]: 70 } });
    const status = (await run(fx, { subcommand: 'status' })).last();
    assert.match(status, new RegExp(`Enabled: Yes\\nChannel: <#${fx.countChannel.id}>\\nSystem: Hexadecimal\\nNext count: FF\\nCurrent streak: 3\\nBest streak: 30\\nLast counter: <@${fx.bob.id}>`));
    const calm = await run(fx, { subcommand: 'status' });
    assert.doesNotMatch(calm.last(), /missing|no longer exists/);
    assert.notEqual(calm.colors().at(-1), WARNING);
    // Mentions, not cached names: a member the bot has not cached is shown the same way.
    const board = (await run(fx, { subcommand: 'leaderboard' })).last();
    assert.equal(board, `Counting Game Leaderboard\n**1.** <@${fx.bob.id}> — 70 counts\n**2.** <@${fx.carol.id}> — 70 counts\n**3.** <@${fx.alice.id}> — 1 count`);

    fx.setBotPermissions(fx.countChannel.id, ['ViewChannel', 'SendMessages']);
    const lacking = await run(fx, { subcommand: 'status' });
    assert.match(lacking.last(), /I am missing \*\*Manage Messages\*\* in <#\d+>[\s\S]*Enabled: Yes/);
    assert.equal(lacking.colors().at(-1), WARNING);
    fx.channels.delete(fx.countChannel.id);
    assert.match((await run(fx, { subcommand: 'status' })).last(), /The counting channel \(\d+\) no longer exists or is hidden from me/);

    // A next number too long for an embed field, from data stored before the start limit.
    await fx.seed({ system: 'roman', nextNumber: 50_000_000 });
    assert.match((await run(fx, { subcommand: 'status' })).last(), /Next count: M{100}… \(50000 characters\)/);
});

test('/count: every change is written to the log channel; a log that cannot be written changes nothing', { skip }, async (t) => {
    const fx = await createCountingFixture(t);
    await fx.enableLog();
    const by = `> \\*\\*Source:\\*\\* /count\\n> \\*\\*By:\\*\\* <@${fx.manager.id}> \\(${fx.manager.id}\\)\\n> \\*\\*Channel:\\*\\* <#${fx.countChannel.id}>`;

    await run(fx, { subcommand: 'setup', channel: fx.countChannel, system: 'roman' });
    await run(fx, { subcommand: 'setup', channel: fx.countChannel, system: 'roman' });
    await run(fx, { subcommand: 'reset', start: 40, clear_scores: true });
    await run(fx, { subcommand: 'reset', start: MAX_START + 1 });
    await run(fx, { subcommand: 'disable' });
    await run(fx, { subcommand: 'disable' });
    await run(fx, { subcommand: 'status' });
    const entries = fx.logEntries();
    assert.deepEqual(entries.map((entry) => entry.title), ['Counting Game Set Up', 'Counting Game Reset', 'Counting Game Disabled'], 'changes only; refusals and reads are not logged');
    assert.match(entries[0].description, new RegExp(`${by}\\n> \\*\\*System:\\*\\* Roman`));
    assert.match(entries[1].description, new RegExp(`${by}\\n> \\*\\*Starts at:\\*\\* 40\\n> \\*\\*Scores:\\*\\* leaderboard and best streak cleared`));
    assert.match(entries[2].description, new RegExp(by));

    fx.hooks.send = (channel) => { if (channel.id === fx.adminChannel.id) throw missingPermissions(); };
    const made = await run(fx, { subcommand: 'setup', channel: fx.countChannel, system: 'binary' });
    assert.match(made.last(), /Counting Game Enabled/);
    assert.deepEqual([(await fx.stored()).enabled, (await fx.stored()).system], [true, 'binary']);
    await recordGameChange(fx.client, guildId, 'unknown-action', {});
    await recordGameChange(null, guildId, 'setup', {});
});
