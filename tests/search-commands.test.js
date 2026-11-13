import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { MessageFlags } from 'discord.js';
import search from '../src/commands/Search/search.js';

const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);
const AGE_RESTRICTED = { nsfw: true };
const ORDINARY = { nsfw: false };

let made = 0;
/** A slash command interaction that records how it was answered. */
function interaction(subcommand, options = {}, channel = ORDINARY) {
    const replies = [];
    const it = {
        id: String(930000000000000000n + BigInt(++made)),
        user: { id: '700000000000000001', username: 'alice' },
        guildId: '123456789012345678',
        channel,
        deferred: false,
        replied: false,
        createdTimestamp: Date.now(),
        isChatInputCommand: () => true,
        deferReply: async (deferOptions) => { it.deferred = true; it.deferOptions = deferOptions; },
        editReply: async (payload) => { replies.push({ how: 'edit', payload }); },
        reply: async (payload) => { replies.push({ how: 'reply', payload }); it.replied = true; },
        options: { getSubcommand: () => subcommand, getString: (name) => options[name] ?? null },
    };
    const embed = () => json(replies.at(-1)?.payload?.embeds?.[0]) ?? {};
    const field = (name) => embed().fields?.find((f) => f.name === name)?.value;
    /** True when the last answer was sent so that only the member who ran the command sees it. */
    const isPrivate = () => replies.at(-1)?.how === 'reply' && replies.at(-1).payload.flags === MessageFlags.Ephemeral;
    return { it, replies, embed, field, isPrivate };
}

/** Replaces axios.get for one test. `answer` is a response body, an Error to throw, or a function of the URL. */
function service(t, answer) {
    const state = { answer };
    const mock = t.mock.method(axios, 'get', async (url) => {
        const value = typeof state.answer === 'function' ? state.answer(url) : state.answer;
        if (value instanceof Error) throw value;
        return { status: 200, data: value };
    });
    return {
        set: (next) => { state.answer = next; },
        calls: () => mock.mock.calls.map((call) => call.arguments),
        count: () => mock.mock.callCount(),
    };
}
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const networkError = (code) => Object.assign(new Error(code), { code });

async function run(subcommand, options, channel) {
    const i = interaction(subcommand, options, channel);
    await search.execute(i.it);
    return i;
}

const urbanEntry = (over = {}) => ({
    word: 'yeet', definition: 'To throw [something] with force.', example: 'He [yeet]ed the ball.',
    thumbs_up: 1200, thumbs_down: 30, author: 'someone',
    permalink: 'https://www.urbandictionary.com/define.php?term=yeet', ...over,
});
const dictEntry = (over = {}) => ({
    word: 'set', phonetic: '/sɛt/',
    meanings: [
        { partOfSpeech: 'verb', definitions: [{ definition: 'To put something down.', example: 'Set the tray there.' }, { definition: 'To adjust.' }] },
        { partOfSpeech: 'noun', definitions: [{ definition: 'A collection of things.' }] },
    ],
    ...over,
});

test.beforeEach(() => {
    assert.equal(axios.get.mock, undefined, 'every test starts with the real axios.get');
});

test('/search: the command tells Discord the same limits the bot checks', () => {
    const options = Object.fromEntries(search.data.toJSON().options.map((sub) => [sub.name, sub.options[0]]));
    assert.deepEqual(Object.keys(options), ['define', 'google', 'urban']);
    assert.deepEqual([options.define.name, options.define.min_length, options.define.max_length, options.define.required], ['word', 2, 100, true]);
    assert.deepEqual([options.google.name, options.google.min_length, options.google.max_length, options.google.required], ['query', 1, 200, true]);
    assert.deepEqual([options.urban.name, options.urban.min_length, options.urban.max_length, options.urban.required], ['term', 2, 100, true]);
    assert.match(search.data.toJSON().options.find((sub) => sub.name === 'urban').description, /age-restricted channels only/);
});

test('/search google: the link text is fixed, the query is shown as code, and no request leaves the bot', async (t) => {
    const web = service(t, new Error('must not be called'));

    const plain = await run('google', { query: '  kopi & teh  ' });
    assert.equal(plain.embed().title, 'Google Search');
    assert.equal(plain.embed().description, 'Search: `kopi & teh`\n[Open this search on Google](https://www.google.com/search?q=kopi%20%26%20teh)');
    assert.equal(plain.replies.length, 1);
    assert.equal(plain.replies[0].how, 'reply');
    assert.equal(plain.isPrivate(), false, 'the link is posted for the channel');

    // A query written to turn the bot's message into a link somewhere else.
    const crafted = await run('google', { query: 'x](https://evil.example) [y' });
    const description = crafted.embed().description;
    assert.equal(description, 'Search: `x](https://evil.example) [y`\n[Open this search on Google](https://www.google.com/search?q=x%5D%28https%3A%2F%2Fevil.example%29%20%5By)');
    // Discord renders nothing inside a code span; outside of it the only link is the bot's own.
    assert.equal((description.match(/`/g) ?? []).length, 2);
    const links = [...description.replace(/`[^`]*`/g, '').matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)];
    assert.deepEqual(links.map((m) => m[1]), ['Open this search on Google']);
    assert.ok(links[0][2].startsWith('https://www.google.com/search?q='));

    // Characters that end a markdown link early are encoded.
    const maths = await run('google', { query: "f(x) = 2 * (3!)" });
    const url = /\]\((.*)\)$/.exec(maths.embed().description)[1];
    assert.equal(url, 'https://www.google.com/search?q=f%28x%29%20%3D%202%20%2A%20%283%21%29');
    assert.equal(new URL(url).searchParams.get('q'), 'f(x) = 2 * (3!)');

    const backticks = await run('google', { query: 'what is `code`' });
    assert.match(backticks.embed().description, /^Search: `what is 'code'`\n/);
    assert.equal(new URL(/\]\((.*)\)$/.exec(backticks.embed().description)[1]).searchParams.get('q'), 'what is `code`', 'the link still carries what was typed');

    const longest = await run('google', { query: 'a'.repeat(200) });
    assert.match(longest.embed().description, /\[Open this search on Google\]\(https:\/\/www\.google\.com\/search\?q=a{200}\)$/);

    for (const query of ['', '   ', 'a'.repeat(201), 'a b '.repeat(1400)]) {
        const refused = await run('google', { query });
        assert.equal(refused.embed().description, 'Please enter a search of 1 to 200 characters.', JSON.stringify(query.slice(0, 10)));
        assert.doesNotMatch(JSON.stringify(refused.embed()), /google\.com/);
        assert.equal(refused.isPrivate(), true);
    }
    assert.equal(web.count(), 0);
});

test('/search define: a found word is shown with its meanings, inside Discord\'s limits', async (t) => {
    const web = service(t, [dictEntry()]);
    const found = await run('define', { word: ' set ' });
    assert.equal(found.it.deferred, true);
    assert.equal(found.it.deferOptions?.flags, undefined, 'the answer is for the channel, not private');
    assert.equal(found.replies.at(-1).how, 'edit');
    assert.equal(found.embed().title, 'set');
    assert.equal(found.embed().description, '*/sɛt/*');
    assert.deepEqual(found.embed().fields.map((f) => [f.name, f.value]), [
        ['verb', '1. To put something down.\n*Example: Set the tray there.*\n\n2. To adjust.'],
        ['noun', '1. A collection of things.'],
    ]);
    const [url, options] = web.calls()[0];
    assert.equal(url, 'https://api.dictionaryapi.dev/api/v2/entries/en/set');
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxContentLength, 524288);
    assert.equal(options.maxRedirects, 2);
    assert.ok(options.signal instanceof AbortSignal);

    await run('define', { word: 'ice cream/soda?' });
    assert.equal(web.calls().at(-1)[0], 'https://api.dictionaryapi.dev/api/v2/entries/en/ice%20cream%2Fsoda%3F');

    // Very long entries: at most 5 meanings of 3 definitions, each field within 1024 and the embed within 6000.
    const long = 'A very long definition that goes on and on. '.repeat(12);
    const many = Array.from({ length: 8 }, (_, n) => ({ partOfSpeech: `kind ${n}`, definitions: Array.from({ length: 6 }, () => ({ definition: long, example: long })) }));
    web.set([dictEntry({ word: 'w'.repeat(400), phonetic: 'p'.repeat(400), meanings: many })]);
    const big = await run('define', { word: 'set' });
    assert.equal(big.embed().fields.length, 5);
    assert.deepEqual(big.embed().fields.map((f) => f.name), ['kind 0', 'kind 1', 'kind 2', 'kind 3', 'kind 4']);
    for (const field of big.embed().fields) {
        assert.ok(field.value.length <= 1024, `field of ${field.value.length}`);
        assert.equal((field.value.match(/^\d\. /gm) ?? []).length, 3);
        assert.match(field.value, /^1\. A very long definition .*…\n\*Example: A very long .*…\*\n\n2\. /);
    }
    assert.ok(big.embed().title.length <= 256);
    assert.ok(big.embed().description.length <= 110);
    const total = big.embed().title.length + big.embed().description.length + (big.embed().footer?.text.length ?? 0)
        + big.embed().fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `embed of ${total}`);
});

test('/search define: text from the dictionary cannot format itself; odd entries are skipped, not fatal', async (t) => {
    const web = service(t, [dictEntry({
        word: '[set](https://evil.example)',
        phonetic: '**loud**',
        meanings: [
            { partOfSpeech: '__noun__', definitions: [{ definition: 'See [here](https://evil.example) for **more**.', example: '`code`' }] },
        ],
    })]);
    const escaped = await run('define', { word: 'set' });
    assert.equal(escaped.embed().title, '\\[set](https://evil.example)');
    assert.equal(escaped.embed().description, '*\\*\\*loud\\*\\**');
    assert.deepEqual(escaped.embed().fields.map((f) => [f.name, f.value]), [
        ['\\_\\_noun\\_\\_', '1. See \\[here](https://evil.example) for \\*\\*more\\*\\*.\n*Example: \\`code\\`*'],
    ]);

    web.set([null, 'text', dictEntry({
        word: 42, phonetic: null,
        meanings: [
            null, 'verb', { partOfSpeech: 'empty', definitions: [] }, { partOfSpeech: 'none' }, { partOfSpeech: 'bad', definitions: [null, {}, { definition: 7 }, { definition: '   ' }] },
            { definitions: [{ definition: 'Kept.', example: 9 }, { definition: null }, { definition: 'Also kept.' }] },
        ],
    })]);
    const odd = await run('define', { word: 'thing' });
    assert.equal(odd.embed().title, 'thing', 'falls back to what was asked for');
    assert.equal(odd.embed().description, undefined);
    assert.deepEqual(odd.embed().fields.map((f) => [f.name, f.value]), [['Definition', '1. Kept.\n\n2. Also kept.']]);
});

test('/search define: every way of finding nothing has its own, true answer', async (t) => {
    const web = service(t, httpError(404));
    const answer = async (word = 'set') => { const i = await run('define', { word }); return [i.embed().title, i.embed().description]; };

    assert.deepEqual(await answer('blorptastic'), ['Input Error', 'No definitions found for `blorptastic`.']);
    // The word is echoed in a public message: as code, so it cannot be a link or a mention.
    assert.deepEqual(await answer('[free nitro](https://evil.example)'), ['Input Error', 'No definitions found for `[free nitro](https://evil.example)`.']);
    assert.deepEqual(await answer('a`b <@700000000000000002>'), ['Input Error', "No definitions found for `a'b <@700000000000000002>`."]);

    for (const empty of [[], [null], [{ word: 'set' }], [dictEntry({ meanings: [] })], [dictEntry({ meanings: 'none' })]]) {
        web.set(empty);
        assert.deepEqual(await answer(), ['Input Error', 'No definitions found for `set`.'], JSON.stringify(empty));
    }

    web.set(httpError(429));
    assert.deepEqual(await answer(), ['Too Fast', 'The dictionary service is receiving too many requests. Please try again in a few minutes.']);
    for (const status of [500, 502, 403, 301]) {
        web.set(httpError(status));
        assert.deepEqual(await answer(), ['Network Error', 'The dictionary service did not give a usable answer. Please try again later.'], String(status));
    }
    for (const code of ['ECONNABORTED', 'ENOTFOUND', 'ECONNRESET', 'ERR_CANCELED']) {
        web.set(networkError(code));
        assert.deepEqual(await answer(), ['Network Error', 'The dictionary service could not be reached. Please try again later.'], code);
    }
    for (const body of ['<html>maintenance</html>', '', null, 7, { title: 'No Definitions Found' }]) {
        web.set(body);
        assert.deepEqual(await answer(), ['Network Error', 'The dictionary service did not give a usable answer. Please try again later.'], JSON.stringify(body));
    }
});

test('/search define: a word it cannot look up is refused before anything is sent', async (t) => {
    const web = service(t, [dictEntry()]);
    for (const word of ['', ' ', 'a', ' a ', '..', '??', './', '--', 'x'.repeat(101)]) {
        const i = await run('define', { word });
        assert.equal(i.embed().description, 'Please enter a word of 2 to 100 characters.', JSON.stringify(word.slice(0, 10)));
        assert.equal(i.it.deferred, false);
        assert.equal(i.isPrivate(), true, 'only the member sees the refusal');
    }
    assert.equal(web.count(), 0);
    for (const word of ['ab', 'x'.repeat(100), 'co-op', "o'clock", 'naïve', '7up']) {
        const i = await run('define', { word });
        assert.equal(i.embed().title, 'set', word);
    }
    assert.equal(web.count(), 6);
});

test('/search urban: only in an age-restricted channel, and nothing is requested anywhere else', async (t) => {
    const web = service(t, { list: [urbanEntry()] });
    for (const [where, channel] of [['ordinary channel', ORDINARY], ['channel without the flag', {}], ['thread in an ordinary channel', { parent: ORDINARY }], ['no channel', null], ['direct message', undefined]]) {
        const i = interaction('urban', { term: 'yeet' }, channel);
        await search.execute(i.it);
        assert.equal(i.embed().title, 'Permission Denied', where);
        assert.equal(i.embed().description, 'Urban Dictionary often contains adult content, so this command only works in an age-restricted channel.', where);
        assert.equal(i.it.deferred, false, where);
        assert.equal(i.isPrivate(), true, where);
        assert.doesNotMatch(JSON.stringify(i.replies), /throw|yeet/i, where);
    }
    assert.equal(web.count(), 0);

    for (const [where, channel] of [['age-restricted channel', AGE_RESTRICTED], ['thread in an age-restricted channel', { parent: AGE_RESTRICTED }]]) {
        const i = await run('urban', { term: 'yeet' }, channel);
        assert.equal(i.embed().title, 'yeet', where);
    }
    assert.equal(web.count(), 2);
    // Truthy is not enough: the flag has to be exactly true.
    const loose = await run('urban', { term: 'yeet' }, { nsfw: 'yes' });
    assert.equal(loose.embed().title, 'Permission Denied');
    assert.equal(web.count(), 2);
});

test('/search urban: an entry is shown as plain text with its votes, author and its own page', async (t) => {
    const web = service(t, { list: [urbanEntry()] });
    const shown = await run('urban', { term: ' yeet ' }, AGE_RESTRICTED);
    assert.equal(shown.it.deferred, true);
    assert.equal(shown.it.deferOptions?.flags, undefined, 'the answer is for the channel, not private');
    assert.equal(shown.replies.at(-1).how, 'edit');
    assert.equal(shown.embed().title, 'yeet');
    assert.equal(shown.embed().url, 'https://www.urbandictionary.com/define.php?term=yeet');
    assert.equal(shown.embed().description, 'To throw something with force.');
    assert.deepEqual(shown.embed().fields.map((f) => [f.name, f.value, f.inline]), [
        ['Example', '*"He yeeted the ball."*', false],
        ['Votes', '1,200 up • 30 down', true],
        ['Author', 'someone', true],
    ]);
    assert.equal(web.calls()[0][0], 'https://api.urbandictionary.com/v0/define?term=yeet');
    await run('urban', { term: 'rock & roll (band)' }, AGE_RESTRICTED);
    assert.equal(web.calls().at(-1)[0], 'https://api.urbandictionary.com/v0/define?term=rock%20%26%20roll%20%28band%29');

    // Names and text chosen by Urban Dictionary's users cannot hide a link or format the message.
    web.set({ list: [urbanEntry({
        word: '[yeet](https://evil.example)', author: '[free nitro](https://evil.example)',
        definition: 'Click **[here]**(https://evil.example)\n\n\n\n# big', example: 'line one\n  line two with _style_',
    })] });
    const crafted = await run('urban', { term: 'yeet' }, AGE_RESTRICTED);
    assert.equal(crafted.embed().title, '\\[yeet](https://evil.example)');
    assert.equal(crafted.field('Author'), '\\[free nitro](https://evil.example)');
    assert.equal(crafted.embed().description, 'Click \\*\\*here\\*\\*(https://evil.example)\n\n\\# big');
    assert.equal(crafted.field('Example'), '*"line one line two with \\_style\\_"*');

    // Long texts are cut with a mark; short ones are not given one.
    web.set({ list: [urbanEntry({ definition: 'd'.repeat(5000), example: 'e'.repeat(900), author: 'a'.repeat(300), word: 'w'.repeat(400) })] });
    const long = await run('urban', { term: 'yeet' }, AGE_RESTRICTED);
    assert.equal(long.embed().description, `${'d'.repeat(1999)}…`);
    assert.equal(long.field('Example'), `*"${'e'.repeat(499)}…"*`);
    assert.equal(long.field('Author'), `${'a'.repeat(99)}…`);
    assert.equal(long.embed().title, `${'w'.repeat(249)}…`);
});

test('/search urban: missing or odd parts of an entry are left out instead of failing the lookup', async (t) => {
    const web = service(t, { list: [urbanEntry({ example: undefined })] });
    const shown = async () => { const i = await run('urban', { term: 'yeet' }, AGE_RESTRICTED); return i; };

    assert.equal((await shown()).field('Example'), '*No example provided*');
    for (const example of ['', '   ', null, 5, '[]']) {
        web.set({ list: [urbanEntry({ example })] });
        assert.equal((await shown()).field('Example'), '*No example provided*', JSON.stringify(example));
    }

    for (const votes of [{ thumbs_up: undefined }, { thumbs_down: null }, { thumbs_up: '12' }, { thumbs_up: NaN }]) {
        web.set({ list: [urbanEntry(votes)] });
        const i = await shown();
        assert.equal(i.embed().title, 'yeet');
        assert.deepEqual(i.embed().fields.map((f) => f.name), ['Example', 'Author'], JSON.stringify(votes));
    }
    web.set({ list: [urbanEntry({ thumbs_up: 0, thumbs_down: 1234567 })] });
    assert.equal((await shown()).field('Votes'), '0 up • 1,234,567 down');

    for (const author of [undefined, null, '', '  ', 7]) {
        web.set({ list: [urbanEntry({ author })] });
        assert.equal((await shown()).field('Author'), 'Anonymous', JSON.stringify(author));
    }

    // The title links only to the entry's own https page on urbandictionary.com.
    for (const permalink of [undefined, null, 'not a url', 'javascript:alert(1)', 'http://www.urbandictionary.com/define.php?term=yeet', 'https://evil.example/define.php?term=yeet', 'https://urbandictionary.com.evil.example/x', 'https://evilurbandictionary.com/x']) {
        web.set({ list: [urbanEntry({ permalink })] });
        const i = await shown();
        assert.equal(i.embed().title, 'yeet', String(permalink));
        assert.equal(i.embed().url, undefined, String(permalink));
    }
    for (const permalink of ['https://urbandictionary.com/define.php?term=yeet', 'https://yeet.urbandictionary.com/', 'https://WWW.URBANDICTIONARY.COM/define.php?term=yeet']) {
        web.set({ list: [urbanEntry({ permalink })] });
        assert.match((await shown()).embed().url, /^https:\/\/([a-z]+\.)?urbandictionary\.com\//, permalink);
    }

    // The first entry that can be shown is used.
    web.set({ list: [null, 'text', { word: 'x' }, urbanEntry({ definition: '[ ]' }), urbanEntry({ word: '  ' }), urbanEntry({ word: 'second', definition: 'This one.' }), urbanEntry({ word: 'third' })] });
    const picked = await shown();
    assert.deepEqual([picked.embed().title, picked.embed().description], ['second', 'This one.']);
});

test('/search urban: every way of finding nothing has its own, true answer', async (t) => {
    const web = service(t, { list: [] });
    const answer = async (term = 'yeet') => { const i = await run('urban', { term }, AGE_RESTRICTED); return [i.embed().title, i.embed().description]; };

    assert.deepEqual(await answer(), ['Input Error', 'No definitions found for `yeet` on Urban Dictionary.']);
    assert.deepEqual(await answer('[x](https://evil.example)'), ['Input Error', 'No definitions found for `[x](https://evil.example)` on Urban Dictionary.']);
    for (const list of [[null], [{ word: 'yeet' }], [urbanEntry({ definition: 5 })]]) {
        web.set({ list });
        assert.deepEqual(await answer(), ['Input Error', 'No definitions found for `yeet` on Urban Dictionary.'], JSON.stringify(list));
    }
    web.set(httpError(404));
    assert.deepEqual(await answer(), ['Input Error', 'No definitions found for `yeet` on Urban Dictionary.']);

    // A service that cannot be reached is not "no definitions".
    for (const code of ['ECONNABORTED', 'ENOTFOUND', 'ECONNRESET', 'ERR_CANCELED']) {
        web.set(networkError(code));
        assert.deepEqual(await answer(), ['Network Error', 'Urban Dictionary could not be reached. Please try again later.'], code);
    }
    web.set(httpError(429));
    assert.deepEqual(await answer(), ['Too Fast', 'Urban Dictionary is receiving too many requests. Please try again in a few minutes.']);
    for (const status of [500, 503, 403]) {
        web.set(httpError(status));
        assert.deepEqual(await answer(), ['Network Error', 'Urban Dictionary did not give a usable answer. Please try again later.'], String(status));
    }
    for (const body of ['<html></html>', null, [], {}, { list: 'none' }, { list: null }]) {
        web.set(body);
        assert.deepEqual(await answer(), ['Network Error', 'Urban Dictionary did not give a usable answer. Please try again later.'], JSON.stringify(body));
    }

    const before = web.count();
    for (const term of ['', ' ', 'a', 'x'.repeat(101)]) {
        const i = await run('urban', { term }, AGE_RESTRICTED);
        assert.equal(i.embed().description, 'Please enter a term of 2 to 100 characters.', JSON.stringify(term.slice(0, 10)));
        assert.equal(i.it.deferred, false);
        assert.equal(i.isPrivate(), true);
    }
    assert.equal(web.count(), before);
});

test('/search: an unknown subcommand is refused; a fault inside the bot is reported as a fault, not as "not found"', async (t) => {
    const unknown = await run('bing', { query: 'x' });
    assert.equal(unknown.embed().description, 'Unknown subcommand');

    // Something no check anticipates: reading the answer itself throws.
    const web = service(t, [{ word: 'set', get meanings() { throw new TypeError('boom'); } }]);
    const define = await run('define', { word: 'set' });
    assert.equal(define.embed().title, 'Something Went Wrong');
    assert.match(define.embed().description, /^Something went wrong\. Please try again in a moment\./);
    assert.doesNotMatch(define.embed().description, /No definitions found|boom/);

    web.set({ list: [{ get word() { throw new TypeError('boom'); } }] });
    const urban = await run('urban', { term: 'yeet' }, AGE_RESTRICTED);
    assert.equal(urban.embed().title, 'Something Went Wrong');
    assert.doesNotMatch(urban.embed().description, /No definitions found|boom/);
});
