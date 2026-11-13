import test from 'node:test';
import assert from 'node:assert/strict';
import roll from '../src/commands/Fun/roll.js';
import fight from '../src/commands/Fun/fight.js';
import flip from '../src/commands/Fun/flip.js';

const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);

let made = 0;
/** A slash command interaction that records its replies. */
function interaction(options = {}, user = { id: '700000000000000001', username: 'alice' }) {
    const replies = [];
    const it = {
        id: String(910000000000000000n + BigInt(++made)),
        user,
        guildId: '123456789012345678',
        deferred: false,
        replied: false,
        createdTimestamp: Date.now(),
        isChatInputCommand: () => true,
        deferReply: async () => { it.deferred = true; },
        editReply: async (payload) => { replies.push(payload); },
        reply: async (payload) => { replies.push(payload); it.replied = true; },
        options: { getString: (name) => options[name] ?? null, getUser: (name) => options[name] ?? null },
    };
    const embed = () => json(replies.at(-1)?.embeds?.[0]) ?? {};
    return { it, replies, embed };
}

const queues = new WeakMap();
/**
 * Makes Math.random answer from a list, then repeat its last value. Math.random is replaced once per test:
 * replacing it a second time would leave the first replacement in place after the test.
 */
function fixRandom(t, values) {
    if (!queues.has(t)) {
        const state = { queue: [] };
        queues.set(t, state);
        t.mock.method(Math, 'random', () => (state.queue.length > 1 ? state.queue.shift() : state.queue[0]));
    }
    queues.get(t).queue = [...values];
}

test.beforeEach(() => {
    assert.equal(Math.random.mock, undefined, 'every test starts with the real Math.random');
});

test('/roll: the total is the dice plus the modifier, and the modifier is written the way it was meant', async (t) => {
    fixRandom(t, [0, 0.5, 0.999]);
    const plus = interaction({ notation: '3d6 + 5' });
    await roll.execute(plus.it);
    assert.match(plus.embed().title, /Rolling 3d6\+5/);
    assert.match(plus.embed().description, /\*\*Rolls:\*\* 1 \+ 4 \+ 6\n\*\*Total Roll:\*\* 11 \+ 5 = \*\*16\*\*/);

    fixRandom(t, [0.5]);
    const minus = interaction({ notation: '1D20-3' });
    await roll.execute(minus.it);
    assert.match(minus.embed().title, /Rolling 1d20-3/);
    assert.match(minus.embed().description, /^\*\*Total Roll:\*\* 11 - 3 = \*\*8\*\*$/);
    assert.doesNotMatch(minus.embed().description, /\+ \(-/);

    const plain = interaction({ notation: 'd6' });
    await roll.execute(plain.it);
    assert.match(plain.embed().title, /Rolling 1d6$/);
    assert.match(plain.embed().description, /^\*\*Total Roll:\*\* 4 = \*\*4\*\*$/);
});

test('/roll: every die lands between 1 and the number of sides', async (t) => {
    for (const [value, expected] of [[0, 1], [0.999999, 1000]]) {
        fixRandom(t, [value]);
        const i = interaction({ notation: '20d1000' });
        await roll.execute(i.it);
        assert.match(i.embed().description, new RegExp(`\\*\\*Total Roll:\\*\\* ${expected * 20} =`));
    }
});

test('/roll: notation it cannot use is refused with a message for the member, and nothing is rolled', async () => {
    const refused = {
        'hello': /Invalid notation/, '2x6': /Invalid notation/, '2d': /Invalid notation/, '2d6+': /Invalid notation/, '2d6+1+1': /Invalid notation/, '-1d6': /Invalid notation/,
        '0d6': /number of dice between 1 and 20/, '21d6': /number of dice between 1 and 20/, '99999999999999999999d6': /number of dice between 1 and 20/,
        '1d0': /number of sides between 1 and 1000/, '1d1001': /number of sides between 1 and 1000/,
    };
    for (const [notation, message] of Object.entries(refused)) {
        const i = interaction({ notation });
        await assert.rejects(roll.execute(i.it), (error) => {
            assert.match(error.userMessage, message, notation);
            return true;
        });
        assert.deepEqual(i.replies, [], notation);
    }
});

test('/fight: the winner is whoever dealt more damage in the rounds that are shown', async (t) => {
    const alice = { id: '700000000000000001', username: 'alice' };
    const bob = { id: '700000000000000002', username: 'bob' };
    for (let run = 0; run < 200; run++) {
        const i = interaction({ opponent: bob }, alice);
        await fight.execute(i.it);
        const text = i.embed().description;
        const rounds = [...text.matchAll(/\*\*Round \d+:\*\* (\w+) .* on (\w+) for (\d+) damage!/g)];
        const announced = Number(/\((\d+) rounds\)/.exec(text)[1]);
        assert.equal(rounds.length, announced);
        assert.ok(announced >= 3 && announced <= 7);
        const dealt = { alice: 0, bob: 0 };
        for (const [, attacker, target, damage] of rounds) {
            assert.notEqual(attacker, target);
            dealt[attacker] += Number(damage);
        }
        assert.match(text, new RegExp(`\\*\\*Damage dealt:\\*\\* alice ${dealt.alice} — bob ${dealt.bob}`));
        const [, winner, loser] = /\n\*\*(\w+)\*\* has defeated (\w+) and claims the victory!$/.exec(text);
        assert.notEqual(winner, loser);
        if (dealt.alice !== dealt.bob) assert.equal(winner, dealt.alice > dealt.bob ? 'alice' : 'bob', text);
        else assert.match(text, /a tie, settled by a coin flip/);
        assert.doesNotMatch(text, /Best of/);
    }
    // A tie (alice 1 + 1, bob 2) is settled by one more random draw.
    for (const [coin, expected] of [[0, 'alice'], [0.9, 'bob']]) {
        //             rounds, max   r1: alice 1   r2: bob 2      r3: alice 1  coin
        fixRandom(t, [0, 0, 0, 0, 0, 0.9, 0.1, 0, 0, 0, 0, coin]);
        const i = interaction({ opponent: bob }, alice);
        await fight.execute(i.it);
        assert.match(i.embed().description, new RegExp(`\\*\\*Damage dealt:\\*\\* alice 2 — bob 2 \\(a tie, settled by a coin flip\\)\\n\\*\\*${expected}\\*\\* has defeated`));
    }
});

test('/fight: names are shown as plain text; fighting yourself or a bot is refused', async () => {
    const sly = { id: '700000000000000001', username: '__al_ice__' };
    const star = { id: '700000000000000002', username: '**bob**' };
    const i = interaction({ opponent: star }, sly);
    await fight.execute(i.it);
    const text = i.embed().description;
    assert.match(text, /\\_\\_al\\_ice\\_\\_/);
    assert.match(text, /\\\*\\\*bob\\\*\\\*/);
    assert.doesNotMatch(text.replaceAll('\\_', '').replaceAll('\\*', ''), /__|\*\*\*/, 'no formatting comes from a name');

    const self = interaction({ opponent: sly }, sly);
    await fight.execute(self.it);
    assert.match(self.embed().description, /you can't fight yourself/);
    assert.match(self.embed().description, /\\_\\_al\\_ice\\_\\_/);
    const bot = interaction({ opponent: { id: '700000000000000009', username: 'robot', bot: true } }, sly);
    await fight.execute(bot.it);
    assert.match(bot.embed().description, /You can't fight bots/);
});

test('/flip: heads below one half, tails from one half up', async (t) => {
    for (const [value, expected] of [[0, 'Heads'], [0.4999, 'Heads'], [0.5, 'Tails'], [0.9999, 'Tails']]) {
        fixRandom(t, [value]);
        const i = interaction();
        await flip.execute(i.it);
        assert.match(i.embed().description, new RegExp(`\\*\\*${expected}\\*\\*`));
    }
});
