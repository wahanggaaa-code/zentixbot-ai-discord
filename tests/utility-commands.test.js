import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { Collection, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import weather, { describeWeatherCode } from '../src/commands/Utility/weather.js';
import userinfo from '../src/commands/Utility/userinfo.js';
import serverinfo from '../src/commands/Utility/serverinfo.js';
import firstmsg from '../src/commands/Utility/firstmsg.js';
import avatar from '../src/commands/Utility/avatar.js';
import todo from '../src/commands/Utility/todo.js';
import { LOOKUP_DEADLINE_MS, LOOKUP_MAX_BYTES, LOOKUP_TIMEOUT_MS } from '../src/services/searchLookup.js';
import { cleanLine } from '../src/services/todo/lists.js';
import { decodeIndex, decodePersonal, decodeShared, isListId } from '../src/services/todo/store.js';
import { isSharedViewOf, refusalMessage, storageFailureMessage } from '../src/services/todo/view.js';

const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);
const GUILD_ID = '123456789012345678';
const person = (id, username, extra = {}) => ({ id, username, tag: username, bot: false, createdAt: new Date(0), displayAvatarURL: () => `https://cdn.example/${id}.png`, ...extra });
const alice = person('700000000000000001', 'alice');
const bob = person('700000000000000002', 'bob');

let made = 0;
/** A slash command interaction that records how it was answered. `options.targetMember` is what getMember returns. */
function interaction(options = {}, extra = {}) {
    const replies = [];
    const it = {
        id: String(940000000000000000n + BigInt(++made)),
        user: alice,
        guildId: GUILD_ID,
        channelId: '443456789012345711',
        deferred: false,
        replied: false,
        createdTimestamp: Date.now(),
        isChatInputCommand: () => true,
        deferReply: async (deferOptions) => { it.deferred = true; it.deferOptions = deferOptions; },
        editReply: async (payload) => { replies.push({ how: 'edit', payload }); },
        reply: async (payload) => { replies.push({ how: 'reply', payload }); it.replied = true; },
        options: { getString: (name) => options[name] ?? null, getUser: (name) => options[name] ?? null, getMember: (name) => options[`${name}Member`] ?? null },
        ...extra,
    };
    const embed = () => json(replies.at(-1)?.payload?.embeds?.[0]) ?? {};
    const field = (name) => embed().fields?.find((entry) => entry.name === name)?.value;
    const said = () => [embed().title, embed().description, ...(embed().fields ?? []).map((entry) => `${entry.name}: ${entry.value}`)].filter(Boolean).join('\n');
    return { it, replies, embed, field, said };
}

/** Runs a command; an error that escapes is returned instead of thrown. */
async function run(command, options, extra) {
    const i = interaction(options, extra);
    i.error = await command.execute(i.it).then(() => null, (error) => error);
    return i;
}

/** Replaces axios.get for one test. `answer(url)` returns a body or an Error to throw. */
function service(t, answer) {
    const state = { answer };
    const mock = t.mock.method(axios, 'get', async (url) => {
        const value = state.answer(String(url));
        if (value instanceof Error) throw value;
        return { status: 200, data: value };
    });
    return { set: (next) => { state.answer = next; }, calls: () => mock.mock.calls.map((call) => call.arguments), count: () => mock.mock.callCount() };
}
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const place = (over = {}) => ({ results: [{ latitude: -6.59, longitude: 106.79, name: 'Bogor', country: 'Indonesia', ...over }] });
const report = (over = {}) => ({ current_weather: { temperature: 27.4, windspeed: 5.2, weathercode: 3, ...over } });
const both = (geo = place(), now = report()) => (url) => (url.includes('geocoding') ? geo : now);

test.beforeEach(() => {
    assert.equal(axios.get.mock, undefined, 'every test starts with the real axios.get');
});

// ---- /weather -----------------------------------------------------------------

test('weather asks both services with limits and shows what they report', async (t) => {
    const api = service(t, both());
    const i = await run(weather, { city: '  Bogor ' });
    assert.equal(i.error, null);
    assert.equal(i.embed().title, 'Weather in Bogor, Indonesia');
    assert.equal(i.embed().description, 'Overcast');
    assert.deepEqual(i.embed().fields.map((entry) => [entry.name, entry.value]), [['Temperature', '27°C'], ['Wind Speed', '5 km/h']],
        'no humidity field: the request does not ask for it, and "N/A%" is not a reading');
    assert.equal(i.it.deferOptions?.flags, undefined, 'the weather is public');

    const calls = api.calls();
    assert.deepEqual(calls.map(([url]) => url), [
        'https://geocoding-api.open-meteo.com/v1/search?name=Bogor',
        'https://api.open-meteo.com/v1/forecast?latitude=-6.59&longitude=106.79&current_weather=true',
    ]);
    for (const [, config] of calls) {
        assert.equal(config.timeout, LOOKUP_TIMEOUT_MS);
        assert.equal(config.maxContentLength, LOOKUP_MAX_BYTES);
        assert.equal(config.maxRedirects, 2);
        assert.ok(config.signal instanceof AbortSignal, `a hard stop after ${LOOKUP_DEADLINE_MS} ms`);
    }

    api.set(both(place(), { current: { temperature_2m: -3.6, relative_humidity_2m: 81.4, wind_speed_10m: 12, weather_code: 71 } }));
    const other = await run(weather, { city: 'Oslo' });
    assert.deepEqual(other.embed().fields.map((entry) => [entry.name, entry.value]), [['Temperature', '-4°C'], ['Humidity', '81%'], ['Wind Speed', '12 km/h']],
        'a humidity that does arrive is shown');
    assert.equal(other.embed().description, 'Slight snow fall');
});

test('weather names every code of the service and admits an unknown one', () => {
    const named = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
    for (const code of named) assert.notEqual(describeWeatherCode(code), 'Conditions not reported', `code ${code}`);
    assert.equal(describeWeatherCode(0), 'Clear sky');
    assert.equal(describeWeatherCode(3), 'Overcast');
    assert.equal(describeWeatherCode(77), 'Snow grains');
    assert.equal(describeWeatherCode(65), 'Heavy rain');
    for (const code of [4, 50, 100, -1, null, undefined, '3']) assert.equal(describeWeatherCode(code), 'Conditions not reported', String(code));
});

test('weather echoes a place it cannot find as plain characters and without a second request', async (t) => {
    const api = service(t, () => ({}));
    const i = await run(weather, { city: '[free nitro](https://evil.example) `x`' });
    assert.equal(i.embed().description, "Could not find a location for `[free nitro](https://evil.example) 'x'`. Please check the spelling.");
    assert.equal(api.count(), 1);

    for (const results of [[], null, 'x', [{ name: 'Nowhere' }], [{ latitude: '1', longitude: 2, name: 'Text' }], [{ latitude: NaN, longitude: 2 }], [null]]) {
        api.set(both({ results }));
        const answer = await run(weather, { city: 'Atlantis' });
        assert.equal(answer.error, null, JSON.stringify(results));
        assert.match(answer.embed().description, /Could not find a location for `Atlantis`/, JSON.stringify(results));
    }
    // The first entry with usable coordinates is the one that counts.
    api.set(both({ results: [{ name: 'Broken' }, { latitude: 1, longitude: 2, name: 'Second' }] }));
    assert.equal((await run(weather, { city: 'Second' })).embed().title, 'Weather in Second');
});

test('weather survives missing and hostile fields in the answers', async (t) => {
    const api = service(t, both(place({ country: undefined }), report({ weathercode: 77, windspeed: undefined })));
    const i = await run(weather, { city: 'Somewhere' });
    assert.equal(i.embed().title, 'Weather in Bogor', 'no "undefined" for a place without a country');
    assert.equal(i.embed().description, 'Snow grains');
    assert.deepEqual(i.embed().fields.map((entry) => entry.name), ['Temperature']);

    api.set(both(place({ name: '**Big** [x](https://evil.example)', country: '' })));
    assert.equal((await run(weather, { city: 'Big' })).embed().title, 'Weather in \\*\\*Big\\*\\* \\[x](https://evil.example)');
    api.set(both(place({ name: null, country: null })));
    assert.equal((await run(weather, { city: 'My *Town*' })).embed().title, 'Weather in My \\*Town\\*');

    for (const now of [{}, { current_weather: {} }, { current_weather: { temperature: 'hot' } }, { error: true, reason: 'bad', current_weather: { temperature: 1 } }, { current_weather: null }]) {
        api.set(both(place(), now));
        const answer = await run(weather, { city: 'Bogor' });
        assert.equal(answer.error, null, JSON.stringify(now));
        assert.equal(answer.embed().description, 'The weather service did not give a usable answer. Please try again later.', JSON.stringify(now));
    }
});

test('weather reports a service that is down, slow or overloaded as such', async (t) => {
    const api = service(t, () => httpError(503));
    const down = await run(weather, { city: 'Bogor' });
    assert.equal(down.error, null, 'no error escapes');
    assert.equal(down.embed().description, 'The weather service did not give a usable answer. Please try again later.');
    assert.equal(api.count(), 1);

    api.set(() => httpError(429));
    assert.equal((await run(weather, { city: 'Bogor' })).embed().description, 'The weather service is receiving too many requests. Please try again in a few minutes.');
    api.set(() => Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
    assert.equal((await run(weather, { city: 'Bogor' })).embed().description, 'The weather service could not be reached. Please try again later.');
    // The place is found, the forecast is not.
    api.set((url) => (url.includes('geocoding') ? place() : httpError(500)));
    assert.equal((await run(weather, { city: 'Bogor' })).embed().description, 'The weather service did not give a usable answer. Please try again later.');
    api.set(() => 'not json');
    assert.equal((await run(weather, { city: 'Bogor' })).embed().description, 'The weather service did not give a usable answer. Please try again later.');
});

test('weather limits the length of a city name before asking anybody', async (t) => {
    const api = service(t, both());
    const option = weather.data.toJSON().options[0];
    assert.deepEqual([option.min_length, option.max_length], [2, 100]);
    for (const city of ['x'.repeat(101), 'x', '   ', ' y ']) {
        const i = await run(weather, { city });
        assert.match(i.embed().description, /city name of 2 to 100 characters/, JSON.stringify(city.slice(0, 5)));
    }
    assert.equal(api.count(), 0);
    await run(weather, { city: 'São Paulo & co?' });
    assert.equal(api.calls()[0][0], 'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo%20%26%20co%3F');
});

// ---- /userinfo, /serverinfo ---------------------------------------------------

const role = (id, position) => ({ id, name: `role-${id}`, position });
function makeGuild({ owner = async () => ({ id: '700000000000000009', user: { tag: 'the_owner' } }) } = {}) {
    const everyone = role(GUILD_ID, 0);
    const roles = new Collection([[everyone.id, everyone], ['11', role('11', 1)], ['19', role('19', 9)], ['15', role('15', 5)]]);
    return {
        id: GUILD_ID, name: 'Server', ownerId: '700000000000000009', memberCount: 3, createdAt: new Date(0), premiumTier: 0, premiumSubscriptionCount: 0,
        iconURL: () => null,
        members: { cache: new Collection() },
        channels: { cache: new Collection([['c1', { isThread: () => false }], ['c2', { isThread: () => false }], ['t1', { isThread: () => true }]]) },
        roles: { cache: roles },
        fetchOwner: owner,
    };
}
const memberWith = (guild, ids) => ({ joinedAt: new Date(86_400_000), roles: { cache: new Collection(ids.map((id) => [id, guild.roles.cache.get(id) ?? role(id, Number(id))])) } });

test('userinfo uses the member Discord sent along, whatever the cache holds', async () => {
    const guild = makeGuild();
    const i = await run(userinfo, { target: bob, targetMember: memberWith(guild, [GUILD_ID, '11', '19', '15']) }, { guild });
    assert.equal(i.error, null);
    assert.equal(i.embed().title, 'User Info: bob');
    assert.equal(i.field('Joined Server'), '<t:86400:R>', 'a member who is not cached is still a member');
    assert.equal(i.field('Roles'), '<@&19>, <@&15>, <@&11>', 'highest first, without @everyone');
    assert.equal(i.field('Highest Role'), '<@&19>');
    assert.deepEqual(i.replies.at(-1).payload.allowedMentions, { parse: [] });

    const self = await run(userinfo, {}, { guild, member: memberWith(guild, [GUILD_ID, '15']) });
    assert.equal(self.embed().title, 'User Info: alice');
    assert.equal(self.field('Roles'), '<@&15>');

    guild.members.cache.set(bob.id, memberWith(guild, [GUILD_ID, '11']));
    const cached = await run(userinfo, { target: bob }, { guild });
    assert.equal(cached.field('Roles'), '<@&11>', 'the cache is the fallback');
});

test('userinfo tells a member without roles from somebody who is not in the server', async () => {
    const guild = makeGuild();
    const plain = await run(userinfo, { target: bob, targetMember: memberWith(guild, [GUILD_ID]) }, { guild });
    assert.equal(plain.field('Roles'), 'None');
    assert.equal(plain.field('Highest Role'), 'None', '@everyone is not a highest role');
    assert.equal(plain.field('Joined Server'), '<t:86400:R>');

    const outsider = await run(userinfo, { target: bob }, { guild });
    assert.equal(outsider.field('Joined Server'), 'Not in server');
    assert.equal(outsider.field('Roles'), 'None');

    const many = await run(userinfo, { target: bob, targetMember: memberWith(guild, [GUILD_ID, ...Array.from({ length: 14 }, (_, n) => String(20 + n))]) }, { guild });
    assert.equal(many.field('Roles'), `${[33, 32, 31, 30, 29, 28, 27, 26, 25, 24].map((id) => `<@&${id}>`).join(', ')} and 4 more`);
    assert.ok(many.field('Roles').length <= 1024);

    const odd = await run(userinfo, { target: person('700000000000000003', '__x__ [a](https://evil.example)') }, { guild });
    assert.equal(odd.embed().title, 'User Info: \\_\\_x\\_\\_ \\[a](https://evil.example)');
});

test('userinfo and serverinfo answer in a direct message instead of failing', async () => {
    for (const command of [userinfo, serverinfo]) {
        assert.equal(command.data.toJSON().dm_permission, false, command.data.name);
        const i = await run(command, {}, { guild: null, guildId: null });
        assert.equal(i.error, null, command.data.name);
        assert.match(i.embed().description, /can only be used in a server/);
    }
});

test('serverinfo still answers when the owner cannot be fetched, and does not count threads', async () => {
    const i = await run(serverinfo, {}, { guild: makeGuild() });
    assert.equal(i.error, null);
    assert.equal(i.embed().title, 'Server Info: Server');
    assert.equal(i.field('Owner'), 'the\\_owner · <@700000000000000009>');
    assert.equal(i.field('Channels'), '2');
    assert.equal(i.field('Roles'), '4');
    assert.equal(i.field('Members'), '3');

    const failing = await run(serverinfo, {}, { guild: makeGuild({ owner: async () => { throw new Error('Unknown Member'); } }) });
    assert.equal(failing.error, null, 'one missing field does not cost the whole answer');
    assert.equal(failing.field('Owner'), '<@700000000000000009>');
    assert.equal(failing.field('Members'), '3');

    const unknown = makeGuild({ owner: async () => { throw new Error('Unknown Member'); } });
    unknown.ownerId = null;
    unknown.name = '**Loud** server';
    const none = await run(serverinfo, {}, { guild: unknown });
    assert.equal(none.field('Owner'), 'Unknown');
    assert.equal(none.embed().title, 'Server Info: \\*\\*Loud\\*\\* server');
});

// ---- /firstmsg, /avatar -------------------------------------------------------

function textChannel({ fetch, permissions = ['ViewChannel', 'ReadMessageHistory'], name = 'general' } = {}) {
    const calls = [];
    return {
        calls,
        name,
        permissionsFor: () => new PermissionsBitField(permissions.map((flag) => PermissionFlagsBits[flag])),
        messages: { fetch: async (query) => { calls.push(query); return fetch(query); } },
    };
}
const NEEDED = /I need the \*\*View Channel\*\* and \*\*Read Message History\*\* permissions/;

test('firstmsg links the first message of the channel', async () => {
    const guild = { ...makeGuild(), members: { me: { id: 'bot' }, cache: new Collection() } };
    const channel = textChannel({ fetch: async () => new Collection([['800000000000000001', { id: '800000000000000001' }]]), name: 'chat *loud*' });
    const i = await run(firstmsg, {}, { guild, channel });
    assert.equal(i.error, null);
    assert.equal(i.embed().title, 'First Message in #chat \\*loud\\*');
    assert.equal(i.embed().description, `Message Link: https://discord.com/channels/${GUILD_ID}/443456789012345711/800000000000000001`);
    assert.deepEqual(channel.calls, [{ limit: 1, after: '1', cache: false }]);

    const empty = await run(firstmsg, {}, { guild, channel: textChannel({ fetch: async () => new Collection() }) });
    assert.equal(empty.embed().description, 'No messages found in this channel!');
});

test('firstmsg says which permission is missing instead of failing', async () => {
    const guild = { ...makeGuild(), members: { me: { id: 'bot' }, cache: new Collection() } };
    for (const permissions of [['ViewChannel'], ['ReadMessageHistory'], []]) {
        const channel = textChannel({ fetch: async () => new Collection(), permissions });
        const i = await run(firstmsg, {}, { guild, channel });
        assert.match(i.embed().description, NEEDED, permissions.join());
        assert.equal(channel.calls.length, 0, 'Discord is not asked for something it will refuse');
    }
    for (const code of [50001, 50013]) {
        const refused = await run(firstmsg, {}, { guild, channel: textChannel({ fetch: async () => { throw Object.assign(new Error('Missing Access'), { code }); } }) });
        assert.equal(refused.error, null);
        assert.match(refused.embed().description, NEEDED);
    }
    const broken = await run(firstmsg, {}, { guild, channel: textChannel({ fetch: async () => { throw Object.assign(new Error('Internal Server Error'), { code: 0 }); } }) });
    assert.equal(broken.error, null);
    assert.equal(broken.embed().description, 'Discord did not return the messages of this channel. Please try again later.');

    for (const channel of [null, { name: 'no-messages' }]) {
        const unknown = await run(firstmsg, {}, { guild, channel });
        assert.equal(unknown.error, null);
        assert.match(unknown.embed().description, NEEDED);
    }
    assert.equal(firstmsg.data.toJSON().dm_permission, false);
});

test('avatar shows a name as written', async () => {
    const i = await run(avatar, { target: person('700000000000000004', '__bob__ [x](https://evil.example)') });
    assert.equal(i.embed().title, "\\_\\_bob\\_\\_ \\[x](https://evil.example)'s Avatar");
    assert.equal(i.embed().description, '[Download Link](https://cdn.example/700000000000000004.png)');
    assert.equal(i.embed().image.url, 'https://cdn.example/700000000000000004.png');
    assert.equal((await run(avatar, {})).embed().title, "alice's Avatar");
});

// ---- to-do: the parts that need no database -------------------------------------

test('todo declares its limits to Discord', () => {
    const data = todo.data.toJSON();
    assert.equal(data.dm_permission, false);
    const personal = Object.fromEntries(data.options.filter((entry) => entry.type === 1).map((entry) => [entry.name, entry.options ?? []]));
    assert.deepEqual(Object.keys(personal), ['add', 'list', 'complete', 'remove']);
    assert.deepEqual([personal.add[0].min_length, personal.add[0].max_length], [1, 200]);
    assert.equal(personal.complete[0].min_value, 1);
    assert.equal(personal.remove[0].min_value, 1);
    assert.deepEqual(personal.list.map((entry) => [entry.name, entry.required ?? false, entry.min_value]), [['page', false, 1]]);

    const share = Object.fromEntries(data.options.find((entry) => entry.name === 'share').options.map((entry) => [entry.name, entry.options ?? []]));
    assert.deepEqual(Object.keys(share), ['create', 'lists', 'add', 'removemember', 'leave', 'delete', 'view', 'addtask', 'complete', 'remove']);
    assert.deepEqual([share.create[0].min_length, share.create[0].max_length], [1, 50]);
    for (const name of ['add', 'removemember', 'leave', 'delete', 'view', 'addtask', 'complete', 'remove']) {
        assert.deepEqual([share[name][0].name, share[name][0].required, share[name][0].max_length], ['list_id', true, 64], name);
    }
    assert.deepEqual(share.view.map((entry) => entry.name), ['list_id', 'page', 'public']);
    assert.deepEqual([share.addtask[1].min_length, share.addtask[1].max_length], [1, 200]);
});

test('todo says so when the database cannot be used, in private, and does not try it anyway', async () => {
    let used = 0;
    const touch = async () => { used += 1; throw new Error('the pool must not be used'); };
    // A wrapper that looks complete; each variant differs from a usable one in a single answer.
    const wrapper = ({ status = {}, outer = true, inner = true } = {}) => ({
        db: {
            getStatus: () => ({ connectionType: 'postgresql', isDegraded: false, ...status }),
            isAvailable: () => outer,
            db: { isAvailable: () => inner, pool: { connect: touch, query: touch } },
        },
    });
    const clients = [
        wrapper({ status: { isDegraded: true } }), wrapper({ status: { connectionType: 'memory' } }), wrapper({ outer: false }), wrapper({ inner: false }),
        { db: { getStatus: () => ({ connectionType: 'postgresql', isDegraded: false }), isAvailable: () => true, db: { isAvailable: () => true } } }, {}, null,
    ];
    for (const [n, client] of clients.entries()) {
        for (const [group, subcommand] of [[null, 'add'], [null, 'list'], ['share', 'lists'], ['share', 'create']]) {
            const i = interaction({ task: 'one', name: 'Trip' });
            Object.assign(i.it.options, { getSubcommand: () => subcommand, getSubcommandGroup: () => group, getInteger: () => null, getBoolean: () => null });
            await todo.execute(i.it, {}, client);
            assert.equal(i.embed().description, 'To-do lists are unavailable right now. Nothing was changed. Please try again later.', `client ${n}: ${group ?? ''} ${subcommand}`);
            assert.equal(i.it.deferOptions?.flags, MessageFlags.Ephemeral);
        }
    }
    assert.equal(used, 0);
});

test('a task or a name is one visible line of limited length', () => {
    assert.equal(cleanLine('  buy   milk \n now\t', 200), 'buy milk now');
    assert.equal(cleanLine('a\u200Bb\u202Ec\uFEFF', 200), 'a b c', 'invisible separators and direction overrides become spaces');
    assert.equal(cleanLine('👨‍👩‍👧 family', 200), '👨‍👩‍👧 family', 'joined emoji stay whole');
    assert.equal(cleanLine('x'.repeat(200), 200), 'x'.repeat(200));
    for (const value of ['', '   ', '\n', '\u200B', '\u200D\u200C', 'x'.repeat(201), null, undefined, 5, {}]) assert.equal(cleanLine(value, 200), null, JSON.stringify(value));
});

test('stored to-do data is read strictly', () => {
    assert.deepEqual(decodePersonal({}), { tasks: [], nextId: 1 });
    assert.deepEqual(decodePersonal('{"tasks":[{"id":2,"text":"a","completed":true,"createdAt":"nonsense"}],"nextId":1}'),
        { tasks: [{ id: 2, text: 'a', completed: true, createdAt: null }], nextId: 3 });
    for (const value of [null, [], 'text', 5, '{']) assert.throws(() => decodePersonal(value), { code: 'TODO_INVALID' }, JSON.stringify(value));

    const list = decodeShared({ creatorId: alice.id, members: [bob.id, bob.id, 'x', 5, alice.id], name: '  ', tasks: [{ id: 1, text: 't', completed: false, completedBy: bob.id, createdBy: 'nobody' }] }, 'abc');
    assert.deepEqual(list.members, [alice.id, bob.id], 'the owner is always a member; ids are unique and real');
    assert.equal(list.name, 'Untitled list');
    assert.deepEqual(list.tasks, [{ id: 1, text: 't', completed: false, createdAt: null }], 'an open task has nobody who completed it');
    assert.equal(list.id, 'abc');
    for (const value of [null, {}, { creatorId: 'me' }, []]) assert.throws(() => decodeShared(value, 'abc'), { code: 'TODO_INVALID' }, JSON.stringify(value));

    assert.deepEqual(decodeIndex(['a1', 'a1', 'b-2', 'has space', 'under_score', 7, null]), ['a1', 'b-2']);
    assert.deepEqual(decodeIndex({ not: 'an array' }), []);
    for (const id of ['abc123', 'A-b-9', 'f'.repeat(64)]) assert.equal(isListId(id), true, id);
    for (const id of ['', 'a_b', 'a b', 'f'.repeat(65), 'é', null, 5]) assert.equal(isListId(id), false, String(id));
});

test('a list message is only recognised when this bot posted it for that list', () => {
    const view = (id, author = 'bot') => ({ author: { id: author }, components: [{ components: [{ customId: `shared_todo_add_${id}` }, { customId: `shared_todo_complete_${id}` }] }] });
    assert.equal(isSharedViewOf(view('abc'), 'abc', 'bot'), true);
    assert.equal(isSharedViewOf({ author: { id: 'bot' }, components: [{ type: 1, components: [{ custom_id: 'shared_todo_add_abc' }] }] }, 'abc', 'bot'), true);
    assert.equal(isSharedViewOf(view('abcd'), 'abc', 'bot'), false, 'another list');
    assert.equal(isSharedViewOf(view('abc', 'somebody'), 'abc', 'bot'), false, 'another author');
    assert.equal(isSharedViewOf(view('abc'), 'abc', undefined), false);
    assert.equal(isSharedViewOf({ author: { id: 'bot' }, components: [] }, 'abc', 'bot'), false);
    assert.equal(isSharedViewOf(null, 'abc', 'bot'), false);
});

test('every refusal and storage failure has its own sentence', () => {
    const reasons = ['invalid_text', 'invalid_list_id', 'not_found', 'no_access', 'not_owner', 'task_not_found', 'already_completed', 'list_full', 'members_full', 'too_many_lists', 'already_member', 'not_member', 'is_owner'];
    const sentences = reasons.map(refusalMessage);
    assert.equal(new Set(sentences).size, reasons.length);
    assert.equal(sentences.includes(refusalMessage('something else')), false);
    assert.match(storageFailureMessage({ code: 'TODO_UNAVAILABLE' }), /Nothing was changed/);
    assert.match(storageFailureMessage({ code: 'TODO_UNCERTAIN' }), /may or may not have been saved/);
    assert.doesNotMatch(storageFailureMessage({ code: 'TODO_UNCERTAIN' }), /Nothing was changed/);
    assert.match(storageFailureMessage({ code: 'TODO_INVALID' }), /cannot be read, so nothing was changed/);
    assert.equal(storageFailureMessage(new Error('other')), null);
});
