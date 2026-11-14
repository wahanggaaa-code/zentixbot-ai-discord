// Global slash commands left by another program are removed when the bot registers its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/utils/logger.js';

const { registerCommands, removeGlobalCommands } = await import('../src/handlers/loaders/commandLoader.js');

const app = '456789012345678901', home = '123456789012345678';
const globalPath = `/applications/${app}/commands`;
const guildPath = `/applications/${app}/guilds/${home}/commands`;
const ai = { id: '111111111111111111', name: 'ai', type: 1 };
const ping = { id: '222222222222222222', name: 'ping', type: 1 };
const menu = { id: '333333333333333333', name: 'Report message', type: 3 };
const launch = { id: '444444444444444444', name: 'launch', type: 4 };

function capture(t) {
    const seen = [];
    t.mock.method(logger, 'log', (entry) => { seen.push({ kind: entry.displayLevel === 'startup' ? 'startup' : entry.level, message: entry.message }); });
    for (const level of ['info', 'debug', 'warn', 'error']) t.mock.method(logger, level, (first) => { seen.push({ kind: level, message: String(first?.message ?? first) }); });
    return { seen, of: (kind) => seen.filter((entry) => entry.kind === kind).map((entry) => entry.message) };
}

/** A stand-in for the Discord REST client that records every call. */
function discord(globals, { failGet = null, failDelete = null } = {}) {
    const calls = [];
    const rest = {
        get: async (path) => { calls.push(['GET', path]); if (failGet) throw new Error(failGet); return globals; },
        delete: async (path) => { calls.push(['DELETE', path]); if (failDelete && path.endsWith(failDelete.id)) throw new Error(failDelete.message); },
        put: async (path, { body }) => { calls.push(['PUT', path, body.length]); },
    };
    return { calls, rest };
}
const oneCommand = () => new Map([['ping', { data: { name: 'ping', toJSON: () => ({ name: 'ping', description: 'Ping' }) } }]]);

test('leftover global commands are deleted one by one and named in one startup line', async (t) => {
    const log = capture(t);
    const { calls, rest } = discord([ai, ping, menu]);
    const removed = await removeGlobalCommands({ rest }, app, {});
    assert.deepEqual(removed, ['/ai', '/ping', '/Report message']);
    assert.deepEqual(calls, [
        ['GET', globalPath],
        ['DELETE', `${globalPath}/${ai.id}`],
        ['DELETE', `${globalPath}/${ping.id}`],
        ['DELETE', `${globalPath}/${menu.id}`],
    ]);
    assert.deepEqual(log.of('startup'), ['Slash commands: 3 global commands left by another program removed (/ai, /ping, /Report message)']);
    assert.deepEqual(log.of('warn'), []);
});

test('one leftover is reported in the singular', async (t) => {
    const log = capture(t);
    const { rest } = discord([ai]);
    await removeGlobalCommands({ rest }, app, {});
    assert.deepEqual(log.of('startup'), ['Slash commands: 1 global command left by another program removed (/ai)']);
});

test('with no global commands nothing is deleted and nothing is logged', async (t) => {
    const log = capture(t);
    for (const answer of [[], null, undefined, { message: 'odd' }]) {
        const { calls, rest } = discord(answer);
        assert.deepEqual(await removeGlobalCommands({ rest }, app, {}), []);
        assert.deepEqual(calls, [['GET', globalPath]]);
    }
    assert.deepEqual(log.seen, []);
});

test("an Activity's entry point command and entries without a usable id are left alone", async (t) => {
    const log = capture(t);
    const { calls, rest } = discord([launch, { name: 'no-id', type: 1 }, { id: '../guilds/1', name: 'bad-id', type: 1 }, null, ai]);
    assert.deepEqual(await removeGlobalCommands({ rest }, app, {}), ['/ai']);
    assert.deepEqual(calls.filter(([method]) => method === 'DELETE'), [['DELETE', `${globalPath}/${ai.id}`]]);
    assert.deepEqual(log.of('startup'), ['Slash commands: 1 global command left by another program removed (/ai)']);
});

test('a long list is shortened in the log, and every command is still deleted', async (t) => {
    const log = capture(t);
    const many = Array.from({ length: 13 }, (_, i) => ({ id: String(500000000000000000n + BigInt(i)), name: `c${i}`, type: 1 }));
    const { calls, rest } = discord(many);
    assert.equal((await removeGlobalCommands({ rest }, app, {})).length, 13);
    assert.equal(calls.filter(([method]) => method === 'DELETE').length, 13);
    assert.deepEqual(log.of('startup'), ['Slash commands: 13 global commands left by another program removed (/c0, /c1, /c2, /c3, /c4, /c5, /c6, /c7, /c8, /c9, and 3 more)']);
});

test('KEEP_GLOBAL_COMMANDS=true leaves global commands alone without asking Discord', async (t) => {
    const log = capture(t);
    for (const value of ['true', 'TRUE', ' true ']) {
        const { calls, rest } = discord([ai]);
        assert.deepEqual(await removeGlobalCommands({ rest }, app, { KEEP_GLOBAL_COMMANDS: value }), []);
        assert.deepEqual(calls, []);
    }
    for (const value of ['false', '', '0', 'yes']) {
        const { calls, rest } = discord([ai]);
        assert.deepEqual(await removeGlobalCommands({ rest }, app, { KEEP_GLOBAL_COMMANDS: value }), ['/ai'], JSON.stringify(value));
        assert.equal(calls.length, 2);
    }
    assert.deepEqual(log.of('warn'), []);
});

test('a failure is a warning, never an exception', async (t) => {
    const log = capture(t);
    const listing = discord([ai], { failGet: 'Missing Access' });
    assert.deepEqual(await removeGlobalCommands({ rest: listing.rest }, app, {}), []);
    assert.deepEqual(log.of('warn'), ['Slash commands: global commands left by another program could not be removed (Missing Access). They answer "that command does not exist".']);
    assert.deepEqual(log.of('startup'), []);

    // The second delete fails: the first is reported as removed, the third is not attempted.
    log.seen.length = 0;
    const midway = discord([ai, ping, menu], { failDelete: { id: ping.id, message: 'rate limited' } });
    assert.deepEqual(await removeGlobalCommands({ rest: midway.rest }, app, {}), ['/ai']);
    assert.deepEqual(midway.calls.filter(([method]) => method === 'DELETE').map(([, path]) => path), [`${globalPath}/${ai.id}`, `${globalPath}/${ping.id}`]);
    assert.deepEqual(log.of('warn'), ['Slash commands: global commands left by another program could not be removed (rate limited). They answer "that command does not exist".']);
    assert.deepEqual(log.of('startup'), ['Slash commands: 1 global command left by another program removed (/ai)']);
});

test('a REST client that cannot list or delete is skipped silently', async (t) => {
    const log = capture(t);
    assert.deepEqual(await removeGlobalCommands({ rest: { put: async () => {} } }, app, {}), []);
    assert.deepEqual(await removeGlobalCommands({ rest: { get: async () => [ai] } }, app, {}), []);
    assert.deepEqual(await removeGlobalCommands({}, app, {}), []);
    assert.deepEqual(log.seen, []);
});

test('registration writes the server list first, then clears the global list; the global list is never overwritten', async (t) => {
    const log = capture(t);
    const { calls, rest } = discord([ai]);
    await registerCommands({ commands: oneCommand(), rest }, { clientId: app, guildId: home, env: {} });
    assert.deepEqual(calls, [
        ['PUT', guildPath, 1],
        ['GET', globalPath],
        ['DELETE', `${globalPath}/${ai.id}`],
    ]);
    assert.deepEqual(log.of('startup'), [
        `Slash commands: 1 registered for server ${home}`,
        'Slash commands: 1 global command left by another program removed (/ai)',
    ]);
    assert.deepEqual(log.of('error'), []);
});

test('registration still succeeds when the global list cannot be read, and honours KEEP_GLOBAL_COMMANDS', async (t) => {
    const log = capture(t);
    const broken = discord([ai], { failGet: 'Missing Access' });
    await registerCommands({ commands: oneCommand(), rest: broken.rest }, { clientId: app, guildId: home, env: {} });
    assert.deepEqual(log.of('startup'), [`Slash commands: 1 registered for server ${home}`]);
    assert.equal(log.of('warn').length, 1);
    assert.deepEqual(log.of('error'), []);

    const kept = discord([ai]);
    await registerCommands({ commands: oneCommand(), rest: kept.rest }, { clientId: app, guildId: home, env: { KEEP_GLOBAL_COMMANDS: 'true' } });
    assert.deepEqual(kept.calls, [['PUT', guildPath, 1]]);
});

test('when the server registration fails, global commands are not touched', async (t) => {
    capture(t);
    const { calls, rest } = discord([ai]);
    rest.put = async () => { throw new Error('Missing Access'); };
    await assert.rejects(registerCommands({ commands: oneCommand(), rest }, { clientId: app, guildId: home, env: {} }), /Missing Access/);
    assert.deepEqual(calls, []);
});

test("the real discord.js REST client sends these calls: list, then one DELETE per leftover", async (t) => {
    const log = capture(t);
    const http = await import('node:http');
    const { REST } = await import('@discordjs/rest');
    let globals = [{ ...ai, description: 'old' }, launch];
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
            if (req.method === 'DELETE') { globals = globals.filter((command) => !req.url.endsWith(`/${command.id}`)); res.statusCode = 204; return res.end(); }
            res.setHeader('content-type', 'application/json');
            res.end(req.method === 'GET' ? JSON.stringify(globals) : body);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const rest = new REST({ version: '10', api: `http://127.0.0.1:${server.address().port}/api` }).setToken('test.token.value');

    await registerCommands({ commands: oneCommand(), rest }, { clientId: app, guildId: home, env: {} });
    assert.deepEqual(seen, [
        `PUT /api/v10${guildPath} Bot test.token.value`,
        `GET /api/v10${globalPath} Bot test.token.value`,
        `DELETE /api/v10${globalPath}/${ai.id} Bot test.token.value`,
    ]);
    assert.deepEqual(globals, [launch]);
    assert.deepEqual(log.of('startup'), [`Slash commands: 1 registered for server ${home}`, 'Slash commands: 1 global command left by another program removed (/ai)']);
    assert.deepEqual(log.of('warn'), []);

    // The next start finds nothing to remove and says nothing about it.
    seen.length = 0;
    log.seen.length = 0;
    await registerCommands({ commands: oneCommand(), rest }, { clientId: app, guildId: home, env: {} });
    assert.deepEqual(seen.map((line) => line.split(' ')[0]), ['PUT', 'GET']);
    assert.deepEqual(log.of('startup'), [`Slash commands: 1 registered for server ${home}`]);
});
