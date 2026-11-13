import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolsFixture, memberId, json } from './helpers/tools-fixture.js';
import { discordError } from './helpers/fake-discord-guild.js';
import { logger } from '../src/utils/logger.js';
import countdown, { COUNTDOWNS_PER_WINDOW } from '../src/commands/Tools/countdown.js';
import { MAX_RUNNING, formatTime, runningCountdowns, scheduleFinish } from '../src/handlers/countdownButtons.js';
import countdownButtons from '../src/interactions/buttons/countdown/countdown.js';
import poll, { POLL_EMOJIS } from '../src/commands/Tools/poll.js';

const START = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW = START / 1000;

/** A fixture with the clock and the timers under the test's control. */
function clocked(t) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
    const fx = createToolsFixture();
    fx.register('buttons', countdownButtons);
    // Countdowns that a test leaves running must not leak into the next one.
    t.after(() => t.mock.timers.tick(48 * 3600 * 1000));
    fx.start = async (member, options) => fx.run(countdown, fx.slash(member, options));
    fx.press = async (member, id, message) => fx.route(fx.button(member, id, { message }));
    return fx;
}

// ---- countdown ------------------------------------------------------------------------------

test('a countdown is one message that Discord counts down; the bot edits it once, at the end', async (t) => {
    const fx = clocked(t);
    const out = await fx.start(fx.alice, { minutes: 2, seconds: 30, title: 'Break' });
    const ends = NOW + 150;
    assert.equal(out.embed().title, 'Break');
    assert.equal(out.embed().description, `Ends <t:${ends}:R>, at <t:${ends}:T>.`);
    assert.deepEqual(out.buttonIds(), [`countdown:pause:${fx.alice.id}:${ends}`, `countdown:cancel:${fx.alice.id}`]);
    assert.equal(runningCountdowns(), 1);

    t.mock.timers.tick(149_000);
    assert.equal(fx.calls.edit.length, 0, 'no edits while it runs');
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(fx.calls.edit.length, 1);
    const done = fx.calls.edit[0].payload;
    assert.match(json(done.embeds[0]).description, /Time's up!/);
    assert.equal(json(done.embeds[0]).title, 'Break');
    assert.deepEqual(done.components, []);
    assert.equal(runningCountdowns(), 0);
    t.mock.timers.tick(3_600_000);
    assert.equal(fx.calls.edit.length, 1);
});

test('the title is shown as plain text', async (t) => {
    const fx = clocked(t);
    const out = await fx.start(fx.alice, { seconds: 30, title: 'a** [click](https://evil.example) **b' });
    // The opening bracket is escaped, so Discord shows the text instead of making a link of it.
    assert.doesNotMatch(out.embed().title, /(?<!\\)\[click\]\(https/);
    assert.match(out.embed().title, /\\\[click\]\(https/);
    assert.doesNotMatch(out.embed().title, /(?<!\\)\*/);
    assert.equal((await fx.start(fx.alice, { seconds: 30 })).embed().title, 'Countdown');
    assert.equal(countdown.data.toJSON().options.find((o) => o.name === 'title').max_length, 100);
});

test('a missing or impossible duration is answered, not thrown', async (t) => {
    const fx = clocked(t);
    for (const options of [{}, { minutes: 0, seconds: 0 }, { minutes: -1 }, { seconds: -5, minutes: 0 }, { minutes: 2, seconds: -30 }, { minutes: -1, seconds: 90 }]) {
        const out = await fx.start(fx.alice, options);
        assert.match(out.said(), /at least 1 second/, JSON.stringify(options));
        assert.equal(out.isPrivate(), true);
    }
    assert.match((await fx.start(fx.alice, { minutes: 1440, seconds: 1 })).said(), /cannot be longer than 24 hours/);
    assert.match((await fx.start(fx.alice, { minutes: 1440 })).said(), /Ends <t:/);
    assert.equal(runningCountdowns(), 1);
    // Refused commands do not use up the member's allowance.
    for (let n = 1; n < COUNTDOWNS_PER_WINDOW; n++) assert.match((await fx.start(fx.alice, { seconds: 5 })).said(), /Ends/);
});

test('the member who started a countdown controls it without Manage Messages; others need the permission', async (t) => {
    const fx = clocked(t);
    const out = await fx.start(fx.alice, { minutes: 5 });
    const [pauseId, cancelId] = out.buttonIds();

    const stranger = await fx.press(fx.bob, pauseId, out.message);
    assert.match(stranger.said(), /Only the member who started this countdown/);
    assert.equal(stranger.isPrivate(), true);
    assert.equal(runningCountdowns(), 1);

    t.mock.timers.tick(60_000);
    const paused = await fx.press(fx.alice, pauseId, out.message);
    assert.equal(paused.replies.at(-1).method, 'update');
    assert.match(paused.said(), /Paused with \*\*04:00\*\* remaining/);
    assert.deepEqual(paused.buttonIds(), [`countdown:resume:${fx.alice.id}:240`, cancelId]);
    assert.equal(runningCountdowns(), 0);

    // Nothing happens at the original end while it is paused.
    t.mock.timers.tick(600_000);
    assert.equal(fx.calls.edit.length, 0);

    const resumed = await fx.press(fx.moderator, paused.buttonIds()[0], out.message);
    const ends = NOW + 660 + 240;
    assert.equal(resumed.embed().description, `Ends <t:${ends}:R>, at <t:${ends}:T>.`);
    assert.equal(resumed.buttonIds()[0], `countdown:pause:${fx.alice.id}:${ends}`, 'the starter stays the owner');
    assert.equal(runningCountdowns(), 1);
    t.mock.timers.tick(240_000);
    await Promise.resolve();
    assert.equal(fx.calls.edit.length, 1);

    const second = await fx.start(fx.alice, { minutes: 5 });
    const cancelled = await fx.press(fx.moderator, second.buttonIds()[1], second.message);
    assert.match(cancelled.said(), new RegExp(`Cancelled by <@${fx.moderator.id}>`));
    assert.deepEqual(cancelled.replies.at(-1).components, []);
    assert.equal(runningCountdowns(), 0);
    t.mock.timers.tick(600_000);
    assert.equal(fx.calls.edit.length, 1, 'a cancelled countdown is never edited again');
});

test('a stale Resume button pressed twice leaves one countdown, not two', async (t) => {
    const fx = clocked(t);
    const message = fx.makeMessage(fx.general, { embeds: [{ title: 'Tea' }] });
    const resume = `countdown:resume:${fx.alice.id}:240`;
    await fx.press(fx.alice, resume, message);
    t.mock.timers.tick(10_000);
    await fx.press(fx.alice, resume, message);
    assert.equal(runningCountdowns(), 1);
    t.mock.timers.tick(239_000);
    await Promise.resolve();
    assert.equal(fx.calls.edit.length, 0, 'the first schedule was replaced');
    t.mock.timers.tick(11_000);
    await Promise.resolve();
    assert.equal(fx.calls.edit.length, 1);
    assert.equal(runningCountdowns(), 0);
});

test('a deleted countdown message ends the countdown quietly', async (t) => {
    const fx = clocked(t);
    const errors = t.mock.method(logger, 'error', () => {});
    const warnings = t.mock.method(logger, 'warn', () => {});
    let attempts = 0;
    fx.hooks.edit = async () => { attempts += 1; throw discordError(404, 10008, 'Unknown Message'); };
    await fx.start(fx.alice, { seconds: 10 });
    t.mock.timers.tick(10_000);
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(3_600_000);
    await Promise.resolve();
    assert.equal(attempts, 1);
    assert.equal(runningCountdowns(), 0);
    assert.equal(errors.mock.callCount() + warnings.mock.callCount(), 0);
});

test('a member can start five countdowns per ten minutes; another member is not affected', async (t) => {
    const fx = clocked(t);
    for (let n = 0; n < COUNTDOWNS_PER_WINDOW; n++) {
        t.mock.timers.tick(1000);
        assert.match((await fx.start(fx.alice, { minutes: 30 })).said(), /Ends/);
    }
    const refused = await fx.start(fx.alice, { minutes: 30 });
    assert.match(refused.said(), /5 countdowns per 10 minutes/);
    assert.equal(refused.isPrivate(), true);
    assert.equal(runningCountdowns(), COUNTDOWNS_PER_WINDOW);
    assert.match((await fx.start(fx.bob, { minutes: 30 })).said(), /Ends/);
    t.mock.timers.tick(10 * 60 * 1000 + 1);
    assert.match((await fx.start(fx.alice, { minutes: 30 })).said(), /Ends/);
});

test('no more than the limit run at once', async (t) => {
    const fx = clocked(t);
    for (let n = 0; n < MAX_RUNNING; n++) assert.equal(scheduleFinish(fx.makeMessage(fx.general), 'x', NOW + 60), true);
    assert.equal(runningCountdowns(), MAX_RUNNING);
    assert.equal(scheduleFinish(fx.makeMessage(fx.general), 'x', NOW + 60), false);
    assert.match((await fx.start(fx.alice, { seconds: 30 })).said(), /Too many countdowns are running/);
    assert.equal(runningCountdowns(), MAX_RUNNING);
    t.mock.timers.tick(60_000);
    assert.equal(runningCountdowns(), 0);
});

test('the buttons work after a restart, because the message itself holds the state', async (t) => {
    const fx = clocked(t);
    // A message from before the restart: nothing about it is in memory.
    const old = fx.makeMessage(fx.general, { embeds: [{ title: 'Launch' }] });
    const stillRunning = await fx.press(fx.alice, `countdown:pause:${fx.alice.id}:${NOW + 90}`, old);
    assert.match(stillRunning.said(), /Launch/);
    assert.match(stillRunning.said(), /Paused with \*\*01:30\*\* remaining/);

    const overdue = await fx.press(fx.alice, `countdown:pause:${fx.alice.id}:${NOW - 30}`, old);
    assert.match(overdue.said(), /Time's up!/);
    assert.deepEqual(overdue.replies.at(-1).components, []);

    // Buttons of countdowns from the version that kept its state in memory.
    for (const id of ['countdown_pause:1731500000000', 'countdown_cancel:1731500000000']) {
        const legacy = await fx.press(fx.alice, id, old);
        assert.match(legacy.said(), /no longer valid/);
        assert.equal(legacy.isPrivate(), true);
    }
});

test('ids this bot did not write are refused', async (t) => {
    const fx = clocked(t);
    const message = fx.makeMessage(fx.general);
    for (const id of [
        `countdown:resume:${fx.alice.id}:86401`, `countdown:resume:${fx.alice.id}:0`, `countdown:resume:${fx.alice.id}:abc`,
        `countdown:resume:${fx.alice.id}`, `countdown:pause:${fx.alice.id}:${NOW + 86_401}`, `countdown:pause:${fx.alice.id}:-5`,
        `countdown:explode:${fx.alice.id}:5`, 'countdown:pause:not-a-member:5', 'countdown:cancel',
    ]) {
        const out = await fx.press(fx.alice, id, message);
        assert.match(out.said(), /no longer valid/, id);
        assert.equal(out.replies.at(-1).method, 'reply', id);
    }
    assert.equal(runningCountdowns(), 0);
    assert.equal((await fx.press(fx.alice, `countdown:resume:${fx.alice.id}:86400`, message)).replies.at(-1).method, 'update');
});

test('formatTime', () => {
    assert.equal(formatTime(0), '00:00');
    assert.equal(formatTime(59), '00:59');
    assert.equal(formatTime(3599), '59:59');
    assert.equal(formatTime(3600), '01:00:00');
    assert.equal(formatTime(86_400), '24:00:00');
});

// ---- poll -----------------------------------------------------------------------------------

const pollOptions = (count, text = (n) => `Option ${n}`) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`option${i + 1}`, text(i + 1)]));

test('a poll shows every option and gets one reaction per option', async () => {
    const fx = createToolsFixture();
    const out = await fx.run(poll, fx.slash(fx.alice, { question: 'Lunch?', ...pollOptions(10) }));
    const { description, title } = out.embed();
    assert.equal(title, 'Poll');
    assert.match(description, /^\*\*Lunch\?\*\*/);
    for (let n = 1; n <= 10; n++) assert.match(description, new RegExp(`\\*\\*${n}\\.\\*\\* Option ${n}(\\n|$)`, 'm'));
    assert.deepEqual(fx.calls.react.map((r) => r.emoji), POLL_EMOJIS);
    assert.deepEqual(out.replies.at(-1).allowedMentions, { parse: [] });
    assert.equal(out.isPrivate(), false);

    const three = await fx.run(poll, fx.slash(fx.alice, { question: 'Q', option1: 'a', option2: 'b', option5: 'c' }));
    assert.match(three.embed().description, /\*\*3\.\*\* c/);
    assert.equal(fx.calls.react.length, 13);
});

test('the longest poll the command accepts still fits', async () => {
    const fx = createToolsFixture();
    const limits = Object.fromEntries(poll.data.toJSON().options.map((o) => [o.name, o.max_length]));
    assert.equal(limits.question, 300);
    assert.equal(limits.option10, 100);
    // Every character needs escaping: the worst case for the length.
    const out = await fx.run(poll, fx.slash(fx.alice, { question: '*'.repeat(300), ...pollOptions(10, (n) => `${n}`.padEnd(100, '_')) }));
    const { description } = out.embed();
    assert.ok(description.length <= 4096, `${description.length}`);
    for (let n = 1; n <= 10; n++) assert.ok(description.includes(`**${n}.** ${n}`), `option ${n} is visible`);
    assert.match(description, /Vote with the numbered reactions/);
    assert.equal(fx.calls.react.length, 10);
});

test('what members type in a poll cannot format itself or hide a link', async () => {
    const fx = createToolsFixture();
    const out = await fx.run(poll, fx.slash(fx.alice, { question: 'a** [click](https://evil.example) **b', option1: '# big', option2: '[x](https://evil.example)' }));
    const { description } = out.embed();
    assert.doesNotMatch(description, /(?<!\\)\[click\]\(https/);
    assert.doesNotMatch(description, /(?<!\\)\[x\]\(https/);
    assert.match(description, /\\\[click\]\(https/);
    assert.match(description, /\*\*1\.\*\* \\# big/);
});

test('a poll is refused before anything is posted when the bot cannot run it here', async () => {
    const fx = createToolsFixture();
    const quiet = fx.makeChannel('300000000000000005', 'quiet', { botPerms: ['ViewChannel', 'SendMessages', 'EmbedLinks'] });
    const out = await fx.run(poll, fx.slash(fx.alice, { question: 'Q', ...pollOptions(2) }, { channel: quiet }));
    assert.match(out.said(), /I cannot run a poll in this channel\. Missing here: Add Reactions, Read Message History\./);
    assert.equal(out.isPrivate(), true);
    assert.equal(out.replies.length, 1);
    assert.equal(fx.calls.react.length, 0);
});

test('a poll with missing, empty or repeated options is refused', async () => {
    const fx = createToolsFixture();
    const ask = async (options) => fx.run(poll, fx.slash(fx.alice, options));
    assert.match((await ask({ question: 'Q', option1: 'a', option2: '   ' })).said(), /at least 2 options/);
    assert.match((await ask({ question: '  ', option1: 'a', option2: 'b' })).said(), /needs a question/);
    assert.match((await ask({ question: 'Q', option1: 'Yes', option2: 'yes' })).said(), /Each option must be different/);
    assert.equal(fx.calls.react.length, 0);
});

test('when reactions stop being accepted, the member is told how far the bot got', async (t) => {
    const fx = createToolsFixture();
    t.mock.method(logger, 'warn', () => {});
    fx.hooks.react = async (_message, emoji) => { if (emoji === POLL_EMOJIS[2]) throw discordError(403, 50013, 'Missing Permissions'); };
    const out = await fx.run(poll, fx.slash(fx.alice, { question: 'Q', ...pollOptions(4) }));
    assert.equal(fx.calls.react.length, 2);
    assert.equal(out.replies.at(-1).method, 'followUp');
    assert.match(out.said(), /I could only add 2 of 4 reactions/);
    assert.equal(out.isPrivate(), true);
});

test('polls and draws are refused outside a server, and a poll whose message cannot be reached says so', async (t) => {
    const fx = createToolsFixture();
    t.mock.method(logger, 'warn', () => {});
    const dm = fx.slash(fx.alice, { question: 'Q', ...pollOptions(2) });
    dm.it.guild = null;
    assert.match((await fx.run(poll, dm)).said(), /only be created in a server/);

    // A prefix command has no inGuild(); it is in a server all the same.
    const prefix = fx.slash(fx.alice, { question: 'Q', ...pollOptions(2) });
    delete prefix.it.inGuild;
    assert.equal((await fx.run(poll, prefix)).embed().title, 'Poll');
    assert.equal(fx.calls.react.length, 2);

    const lost = fx.slash(fx.alice, { question: 'Q', ...pollOptions(3) });
    lost.it.editReply = async (payload) => { lost.replies.push({ method: 'editReply', ...payload }); return null; };
    lost.it.fetchReply = async () => { throw new Error('gone'); };
    await fx.run(poll, lost);
    assert.match(lost.said(), /I could only add 0 of 3 reactions/);
    assert.equal(fx.calls.react.length, 2);
});

test('the poll no longer offers an "anonymous" mode it cannot provide', () => {
    assert.equal(poll.data.toJSON().options.some((o) => o.name === 'anonymous'), false);
    assert.deepEqual(poll.data.toJSON().options.filter((o) => o.required).map((o) => o.name), ['question', 'option1', 'option2']);
    assert.equal(memberId(1).length, 18);
});
