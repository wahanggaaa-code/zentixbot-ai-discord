// What the bot prints on the console: the shape of a line, the startup report, and that the line
// per loaded file is kept for LOG_LEVEL=debug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { consoleColorEnabled, formatConsoleLine } from '../src/utils/consoleFormat.js';
import {
    describeCheck, describeCommands, describeDashboard, describeEvents, describeInteractions, describeServer, onlineSummary, summarizeCommands, wrapList,
} from '../src/utils/startupReport.js';
import { dashboardLoginStatus } from '../src/dashboard/origin.js';
import { logger } from '../src/utils/logger.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const pgEnabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';

// ---------------------------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------------------------

test('every level gets a tag of the same width, so messages start in one column', () => {
    const line = (level, displayLevel) => formatConsoleLine({ timestamp: '20:28:42', level, displayLevel, message: 'text' });
    assert.equal(line('info'), '20:28:42  INFO   text');
    assert.equal(line('warn'), '20:28:42  WARN   text');
    assert.equal(line('error'), '20:28:42  ERROR  text');
    assert.equal(line('debug'), '20:28:42  DEBUG  text');
    assert.equal(line('http'), '20:28:42  HTTP   text');
    assert.equal(line('verbose'), '20:28:42  VERB   text');
    assert.equal(line('silly'), '20:28:42  SILLY  text');
    assert.equal(line('info', 'startup'), '20:28:42  START  text');
    assert.equal(line('warn', 'startup'), '20:28:42  START  text', 'a startup line promoted to warn keeps its tag');
    assert.equal(line('info', 'status'), '20:28:42  STATUS text');
    assert.equal(line('notice'), '20:28:42  NOTICE text');
    assert.equal(line('info', 'unknown'), '20:28:42  INFO   text');
    assert.equal(formatConsoleLine({ timestamp: '20:28:42', level: 'info', message: undefined }), '20:28:42  INFO   ');
    assert.equal(formatConsoleLine({ timestamp: '20:28:42', level: 'info', message: 0 }), '20:28:42  INFO   0');
});

test('further lines of a message are indented to the message column', () => {
    assert.equal(
        formatConsoleLine({ timestamp: '20:28:42', level: 'warn', message: 'first\nsecond\n  third' }),
        '20:28:42  WARN   first\n                 second\n                   third',
    );
    assert.equal(formatConsoleLine({ timestamp: '2026-11-13 20:28:42', level: 'info', message: 'a\nb' }), '2026-11-13 20:28:42  INFO   a\n                            b');
});

test('an error shows its message once, its kind when it has one, and its frames underneath', () => {
    const stack = 'TypeError: x is not a function\n    at run (file:///app/a.js:1:2)\n    at async main (file:///app/b.js:3:4)';
    assert.equal(
        formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'Failed to start bot: x is not a function', stack }),
        '20:28:42  ERROR  Failed to start bot: x is not a function (TypeError)\n                     at run (file:///app/a.js:1:2)\n                     at async main (file:///app/b.js:3:4)',
    );
    const plain = 'Error: connect ECONNREFUSED\n    at connect (node:net:1:1)';
    assert.equal(formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'connect ECONNREFUSED', stack: plain }), '20:28:42  ERROR  connect ECONNREFUSED\n                     at connect (node:net:1:1)');
    const discord = 'DiscordAPIError[50013]: Missing Permissions\n    at handleErrors (rest.js:1:1)';
    assert.match(formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'Could not add role: Missing Permissions', stack: discord }), /Missing Permissions \(DiscordAPIError\[50013\]\)\n/);
    assert.equal(
        formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'TypeError already named', stack }).split('\n')[0],
        '20:28:42  ERROR  TypeError already named',
    );
    const twoLines = 'RangeError: first\nsecond line of the message\n    at f (a.js:1:1)';
    assert.equal(
        formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'first\nsecond line of the message', stack: twoLines }),
        '20:28:42  ERROR  first (RangeError)\n                 second line of the message\n                     at f (a.js:1:1)',
    );
    assert.equal(formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'no frames', stack: 'no frames' }), '20:28:42  ERROR  no frames');
});

test('plain values passed after the message are shown; objects are not', () => {
    const line = (extras) => formatConsoleLine({ timestamp: '20:28:42', level: 'warn', message: 'Could not close:', extras });
    assert.equal(line(['socket hang up']), '20:28:42  WARN   Could not close: socket hang up');
    assert.equal(line(['a', 3, 'b']), '20:28:42  WARN   Could not close: a 3 b');
    assert.equal(line([{ guildId: '1' }, new Error('x'), ['a'], () => 1, Symbol('s')]), '20:28:42  WARN   Could not close:');
    assert.equal(line([true, false, null, undefined, 10n, 0, '']), '20:28:42  WARN   Could not close: true false null undefined 10 0 ');
    assert.equal(line([]), '20:28:42  WARN   Could not close:');
    assert.equal(line(undefined), '20:28:42  WARN   Could not close:');
    assert.equal(line(['two\nlines']), '20:28:42  WARN   Could not close: two\n                 lines');
});

test('colour marks the time and the tag only, and NO_COLOR switches it off', () => {
    const paint = (level, displayLevel) => formatConsoleLine({ timestamp: '20:28:42', level, displayLevel, message: 'text\nmore' }, { color: true });
    assert.equal(paint('error'), '\u001b[90m20:28:42\u001b[39m  \u001b[31mERROR \u001b[39m text\n                 more');
    assert.equal(paint('warn'), '\u001b[90m20:28:42\u001b[39m  \u001b[33mWARN  \u001b[39m text\n                 more');
    assert.equal(paint('info'), '\u001b[90m20:28:42\u001b[39m  \u001b[36mINFO  \u001b[39m text\n                 more');
    assert.equal(paint('info', 'startup'), '\u001b[90m20:28:42\u001b[39m  \u001b[32mSTART \u001b[39m text\n                 more');
    assert.equal(paint('info', 'status'), '\u001b[90m20:28:42\u001b[39m  \u001b[35mSTATUS\u001b[39m text\n                 more');
    assert.equal(paint('debug'), '\u001b[90m20:28:42\u001b[39m  \u001b[90mDEBUG \u001b[39m text\n                 more');
    assert.equal(formatConsoleLine({ timestamp: '20:28:42', level: 'error', message: 'text' }).includes('\u001b'), false, 'no colour unless asked');

    assert.equal(consoleColorEnabled({}), true);
    assert.equal(consoleColorEnabled({ NO_COLOR: '' }), true);
    assert.equal(consoleColorEnabled({ NO_COLOR: '1' }), false);
    assert.equal(consoleColorEnabled({ NO_COLOR: 'false' }), false, 'any value counts, as the NO_COLOR convention says');
});

test('the logger prints through that format, including what was passed after the message', () => {
    const script = `
        import { logger, startupLog, shutdownLog } from ${JSON.stringify(join(repo, 'src/utils/logger.js'))};
        startupLog('Events: 14 registered');
        logger.info('plain');
        logger.warn('Could not close:', 'socket hang up');
        logger.error('Failed to start bot:', new TypeError('x is not a function'));
        logger.debug('hidden at info');
        shutdownLog('Shutting down (SIGTERM)...');
        setTimeout(() => process.exit(0), 200);`;
    const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000, cwd: tmpdir(), env: { PATH: process.env.PATH, ...env } });

    const plain = run({ NODE_ENV: 'production', LOG_LEVEL: 'info', NO_COLOR: '1' });
    const lines = plain.stdout.split('\n').filter(Boolean);
    assert.match(lines[0], /^\d\d:\d\d:\d\d  START  Events: 14 registered$/);
    assert.match(lines[1], /^\d\d:\d\d:\d\d  INFO   plain$/);
    assert.match(lines[2], /^\d\d:\d\d:\d\d  WARN   Could not close: socket hang up$/);
    assert.match(lines[3], /^\d\d:\d\d:\d\d  ERROR  Failed to start bot: x is not a function \(TypeError\)$/);
    assert.match(lines[4], /^ {21}at /);
    assert.match(lines.at(-1), /^\d\d:\d\d:\d\d  STATUS Shutting down \(SIGTERM\)\.\.\.$/);
    assert.equal(plain.stdout.includes('hidden at info'), false);
    assert.equal(plain.stdout.includes('\u001b'), false);

    const coloured = run({ NODE_ENV: 'production', LOG_LEVEL: 'debug' });
    assert.match(coloured.stdout, /\u001b\[32mSTART \u001b\[39m Events: 14 registered\n/);
    assert.match(coloured.stdout, /\u001b\[90mDEBUG \u001b\[39m hidden at info\n/);

    // At LOG_LEVEL=warn in production the report and the status lines are still shown.
    const quiet = run({ NODE_ENV: 'production', LOG_LEVEL: 'warn', NO_COLOR: '1' }).stdout;
    assert.match(quiet, /  START  Events: 14 registered\n/);
    assert.match(quiet, /  STATUS Shutting down/);
    assert.equal(quiet.includes('plain'), false);
});

// ---------------------------------------------------------------------------------------------
// The startup report
// ---------------------------------------------------------------------------------------------

test('a list is wrapped between items and never inside one', () => {
    assert.deepEqual(wrapList([]), []);
    assert.deepEqual(wrapList(['a', 'b', 'c']), ['a · b · c']);
    assert.deepEqual(wrapList(['aaaa', 'bbbb', 'cccc'], { width: 11 }), ['aaaa · bbbb', 'cccc'], 'exactly the width still fits');
    assert.deepEqual(wrapList(['aaaa', 'bbbb', 'cccc'], { width: 10 }), ['aaaa', 'bbbb', 'cccc']);
    assert.deepEqual(wrapList(['a-very-long-item', 'b'], { width: 5 }), ['a-very-long-item', 'b']);
    assert.deepEqual(wrapList(['a', 'b'], { separator: ', ' }), ['a, b']);
    for (const line of wrapList(Array.from({ length: 60 }, (_, i) => `Category${i} ${i}`))) assert.ok(line.length <= 96, line);
});

test('commands are counted per category, with their subcommands', () => {
    const summary = summarizeCommands([
        { category: 'Utility', subcommands: 14 }, { category: 'AI', subcommands: 0 }, { category: 'Utility' }, { category: 'economy', subcommands: 2 }, {},
    ]);
    assert.deepEqual(summary, { total: 5, subcommands: 16, categories: [['AI', 1], ['economy', 1], ['uncategorised', 1], ['Utility', 2]] });
    assert.deepEqual(describeCommands(summary), [
        'Commands: 5 loaded in 4 categories, 16 subcommands',
        '  AI 1 · economy 1 · uncategorised 1 · Utility 2',
    ]);
    assert.deepEqual(describeCommands({ total: 1, subcommands: 1, categories: [['AI', 1]] }, { failed: 1 }), [
        'Commands: 1 loaded in 1 category, 1 subcommand; 1 file not loaded, see the messages above',
        '  AI 1',
    ]);
    assert.match(describeCommands({ total: 0, subcommands: 0, categories: [] }, { failed: 3 })[0], /^Commands: 0 loaded in 0 categories, 0 subcommands; 3 files not loaded/);
    assert.deepEqual(describeCommands(summarizeCommands([])), ['Commands: 0 loaded in 0 categories, 0 subcommands']);
});

test('events, interactions and the server are each announced in one line', () => {
    assert.equal(describeEvents(14), 'Events: 14 registered');
    assert.equal(describeEvents(13, { failed: 1 }), 'Events: 13 registered; 1 file not loaded, see the messages above');
    assert.equal(describeEvents(12, { failed: 2 }), 'Events: 12 registered; 2 files not loaded, see the messages above');
    assert.equal(describeInteractions({ buttons: 60, selectMenus: 5, modals: 12 }), 'Interactions: 60 buttons, 5 select menus, 12 modals');
    assert.equal(describeInteractions({ buttons: 1, selectMenus: 1, modals: 1 }, { failed: 1 }), 'Interactions: 1 button, 1 select menu, 1 modal; 1 handler not loaded, see the messages above');
    assert.match(describeInteractions({ buttons: 0, selectMenus: 0, modals: 0 }, { failed: 2 }), /^Interactions: 0 buttons, 0 select menus, 0 modals; 2 handlers not loaded/);

    assert.equal(describeServer({ id: '123', name: 'Home', connected: 1 }), 'Server: Home (123)');
    assert.equal(describeServer({ id: '123', name: 'Home', connected: 2 }), 'Server: Home (123); 1 other server is ignored');
    assert.equal(describeServer({ id: '123', name: 'Home', connected: 4 }), 'Server: Home (123); 3 other servers are ignored');
    assert.equal(describeServer({ id: '123', name: null, connected: 0 }), 'Server: not joined (123)');
    assert.equal(describeServer({ id: '123', name: null, connected: 1 }), 'Server: not joined (123); 1 other server is ignored');
});

test('the dashboard line gives the address, or the reason the login is off', () => {
    const ready = { CLIENT_ID: '456789012345678901', DISCORD_CLIENT_SECRET: 'secret' };
    const status = (env, guild = '123456789012345678') => dashboardLoginStatus({ ...ready, ...env }, guild);

    assert.deepEqual(status({ DASHBOARD_URL: 'https://bot.example.com' }), { origin: 'https://bot.example.com', insecure: false, reason: null, configured: true });
    assert.equal(describeDashboard(status({ DASHBOARD_URL: 'https://bot.example.com' })), 'https://bot.example.com/dashboard/');
    assert.equal(describeDashboard(status({ DASHBOARD_URL: 'http://203.0.113.5:11991', DASHBOARD_ALLOW_HTTP: 'true' })), 'http://203.0.113.5:11991/dashboard/ (plain HTTP)');
    assert.equal(describeDashboard(status({})), 'login off: DASHBOARD_URL is not set');
    assert.equal(describeDashboard(status({ DASHBOARD_URL: 'http://203.0.113.5:11991' })), 'login off: DASHBOARD_URL uses http:// and DASHBOARD_ALLOW_HTTP is not true');
    assert.equal(describeDashboard(status({ DASHBOARD_URL: 'https://bot.example.com/dashboard' })), 'login off: DASHBOARD_URL must be an address without a path');

    const address = { DASHBOARD_URL: 'https://bot.example.com' };
    for (const [label, incomplete] of Object.entries({
        'no secret': status({ ...address, DISCORD_CLIENT_SECRET: '' }),
        'no application id': status({ ...address, CLIENT_ID: undefined }),
        'application id is not an id': status({ ...address, CLIENT_ID: 'abc' }),
        'application id too short': status({ ...address, CLIENT_ID: '1234567890123456' }),
        'no server': status(address, null),
    })) {
        assert.equal(incomplete.configured, false, label);
        assert.equal(incomplete.origin, 'https://bot.example.com', label);
        assert.equal(describeDashboard(incomplete), 'login off: CLIENT_ID, DISCORD_CLIENT_SECRET or GUILD_ID is missing', label);
    }
    assert.equal(dashboardLoginStatus(undefined, '123456789012345678').configured, false);
});

test('the closing block lists what is running, and says so when the slash commands were refused', () => {
    const facts = {
        version: '2.1.0', seconds: 5.94, botTag: 'zentix#0667', guildId: '1528096614751928371', guildName: 'Zentix Community',
        loaded: { commands: 100, buttons: 60, selectMenus: 5, modals: 12 }, registered: true,
        database: 'PostgreSQL, persistent', port: 11991, dashboard: 'http://203.0.113.5:11991/dashboard/ (plain HTTP)', memoryBytes: 172.4 * 1024 * 1024,
    };
    const rule = '─'.repeat(60);
    assert.deepEqual(onlineSummary(facts), [
        rule,
        'ZentixBot 2.1.0 is ONLINE (startup took 5.9 s)',
        '  Bot        zentix#0667',
        '  Server     Zentix Community (1528096614751928371)',
        '  Loaded     100 commands, 60 buttons, 5 select menus, 12 modals',
        '  Database   PostgreSQL, persistent',
        '  Web        port 11991',
        '  Dashboard  http://203.0.113.5:11991/dashboard/ (plain HTTP)',
        '  Memory     172 MB',
        rule,
    ]);
    assert.deepEqual(onlineSummary({ ...facts, seconds: 12, botTag: null, guildName: null, port: null, registered: false, loaded: { commands: 1, buttons: 1, selectMenus: 1, modals: 1 }, memoryBytes: 172.6 * 1024 * 1024 }), [
        rule,
        'ZentixBot 2.1.0 is ONLINE (startup took 12.0 s)',
        '  Bot        waiting for Discord to confirm the login',
        '  Server     1528096614751928371 (the bot has not joined it)',
        '  Loaded     1 command, 1 button, 1 select menu, 1 modal',
        '  Warning    slash commands were NOT registered, see the error above; Discord may show none or old ones',
        '  Database   PostgreSQL, persistent',
        '  Web        not listening yet',
        '  Dashboard  http://203.0.113.5:11991/dashboard/ (plain HTTP)',
        '  Memory     173 MB',
        rule,
    ]);
});

test('a startup check lists every count and wraps between them', () => {
    assert.deepEqual(describeCheck('ticket panels', [['healthy', 3], ['deleted', 0], ['errors', 1]]), ['Check, ticket panels: healthy 3, deleted 0, errors 1']);
    assert.deepEqual(describeCheck('one', [['errors', 0]]), ['Check, one: errors 0']);
    assert.deepEqual(
        describeCheck('Join to Create', [
            ['interrupted creates', 0], ['stale records', 12], ['empty channels deleted', 0], ['owners transferred', 0],
            ['missing triggers', 0], ['waiting members served', 0], ['errors', 0],
        ]),
        [
            'Check, Join to Create: interrupted creates 0, stale records 12, empty channels deleted 0',
            '  owners transferred 0, missing triggers 0, waiting members served 0, errors 0',
        ],
    );
});

test('once Discord confirms the login, the ready event reports the bot, the server and each check', async (t) => {
    const { default: ready } = await import('../src/events/ready.js');
    const log = capture(t);
    const empty = () => ({ cache: new Map(), fetch: async () => new Map() });
    const guild = { id: '123456789012345678', name: 'Zentix Community', channels: empty(), members: empty(), roles: empty(), voiceStates: empty() };
    const client = {
        homeGuildId: guild.id, config: { features: { music: false } },
        user: { tag: 'zentix#0667', setPresence() {} },
        guilds: { cache: new Map([[guild.id, guild], ['999', { id: '999', name: 'Other' }]]) },
        db: { get: async () => null, set: async () => true, delete: async () => true, list: async () => [], getStatus: () => ({ connectionType: 'postgresql', isDegraded: false }), isAvailable: () => true },
    };
    await ready.execute(client);
    assert.deepEqual(log.of('startup').slice(0, 2), ['Discord: logged in as zentix#0667', 'Server: Zentix Community (123456789012345678); 1 other server is ignored']);
    // This client has no database, so every check meets an error and is printed as a warning.
    assert.equal(log.of('startup').length, 2);
    const checks = log.of('warn').filter((line) => /^(Check, |  )/.test(line));
    assert.deepEqual(checks.slice(0, 5), [
        'Check, ticket panels: healthy 0, deleted 0, channel missing 0, recovered 0, errors 1',
        'Check, verification panels: healthy 0, deleted 0, channel missing 0, recovered 0, errors 1',
        'Check, reaction role panels: stored 0, healthy 0, message missing 0, channel missing 0',
        '  not checkable 0, unreadable records 0, errors 1',
        'Check, level roles: members checked 0, roles given again 0, reward roles missing 0',
    ]);
    for (const line of checks) assert.ok(line.length <= 100, line);
    assert.ok(log.of('warn').some((line) => line.startsWith('Check, Join to Create: skipped (')));

    // Without the configured server only the first two lines appear, and a warning says why.
    log.seen.length = 0;
    client.guilds.cache.delete(guild.id);
    await ready.execute(client);
    assert.deepEqual(log.of('startup'), ['Discord: logged in as zentix#0667', 'Server: not joined (123456789012345678); 1 other server is ignored']);
    assert.deepEqual(log.of('warn'), ['Configured home guild is not available; startup reconciliation skipped.']);
    assert.deepEqual(log.of('error'), []);
});

// ---------------------------------------------------------------------------------------------
// The loaders
// ---------------------------------------------------------------------------------------------

/** Everything the loaders log, by kind: 'startup' for the report, otherwise the level. */
function capture(t) {
    const seen = [];
    const record = (kind) => (first) => { seen.push({ kind, message: String(first?.message ?? first) }); };
    t.mock.method(logger, 'log', (entry) => { seen.push({ kind: entry.displayLevel === 'startup' ? 'startup' : entry.level, message: entry.message }); });
    for (const level of ['info', 'debug', 'warn', 'error']) t.mock.method(logger, level, record(level));
    const of = (kind) => seen.filter((entry) => entry.kind === kind).map((entry) => entry.message);
    return { seen, of };
}

test('loading commands, events and interactions reports one summary each and nothing else above debug', async (t) => {
    const { loadCommands } = await import('../src/handlers/loaders/commandLoader.js');
    const { default: loadEvents } = await import('../src/handlers/loaders/events.js');
    const { default: loadInteractions } = await import('../src/handlers/loaders/interactions.js');
    const log = capture(t);
    const listeners = [];
    const client = { buttons: new Map(), selectMenus: new Map(), modals: new Map(), on: (name) => listeners.push(name), once: (name) => listeners.push(name) };

    await loadCommands(client);
    const commandLines = log.of('startup');
    const totals = /^Commands: (\d+) loaded in (\d+) categories, (\d+) subcommands$/.exec(commandLines[0]);
    assert.ok(totals, commandLines[0]);
    assert.equal(Number(totals[1]), client.commands.size);
    assert.ok(client.commands.size >= 90);
    const perCategory = commandLines.slice(1).flatMap((line) => { assert.match(line, /^ {2}\S/); return line.trim().split(' · '); });
    assert.equal(perCategory.length, Number(totals[2]));
    assert.equal(perCategory.reduce((sum, item) => sum + Number(item.split(' ').pop()), 0), client.commands.size, 'the category counts add up');
    assert.deepEqual(perCategory.map((item) => item.replace(/ \d+$/, '')), [...new Set([...client.commands.values()].map((command) => command.category))].sort((a, b) => a.localeCompare(b, 'en')));
    for (const line of commandLines) assert.ok(line.length <= 100, line);

    await loadEvents(client);
    assert.equal(log.of('startup').at(-1), `Events: ${listeners.length} registered`);
    assert.ok(listeners.includes('clientReady') && listeners.includes('interactionCreate'));

    await loadInteractions(client);
    assert.equal(log.of('startup').at(-1), `Interactions: ${client.buttons.size} buttons, ${client.selectMenus.size} select menus, ${client.modals.size} modals`);
    assert.ok(client.buttons.size > 10 && client.selectMenus.size > 1 && client.modals.size > 1);

    assert.equal(log.of('startup').length, commandLines.length + 2);
    assert.deepEqual(log.of('info'), [], 'nothing at info level');
    assert.deepEqual(log.of('warn'), []);
    assert.deepEqual(log.of('error'), []);

    // The detail is still there for LOG_LEVEL=debug: one line per command, event and handler.
    const debug = log.of('debug');
    assert.equal(debug.filter((line) => /^Command \S+ \[[^\]]+\]/.test(line)).length, client.commands.size);
    assert.ok(debug.includes('Command todo [Utility], subcommands: add, list, complete, remove, share/create, share/lists, share/add, share/removemember, share/leave, share/delete, share/view, share/addtask, share/complete, share/remove'));
    assert.ok(debug.includes('Command ping [Core]'), 'a command without subcommands has none listed');
    assert.equal(debug.filter((line) => /^Event \S+( \(once\))?$/.test(line)).length, listeners.length);
    assert.ok(debug.includes('Event clientReady (once)') && debug.includes('Event interactionCreate'));
    assert.equal(debug.filter((line) => /^Button \S+ \(\S+\.js\)$/.test(line)).length, client.buttons.size);
    assert.equal(debug.filter((line) => /^Select menu \S+ \(\S+\.js\)$/.test(line)).length, client.selectMenus.size);
    assert.equal(debug.filter((line) => /^Modal \S+ \(\S+\.js\)$/.test(line)).length, client.modals.size);
    for (const line of debug) assert.equal(line.includes(repo), false, `no absolute path: ${line}`);
});

test('a file that cannot be loaded is named, counted in the summary, and does not stop the others', async (t) => {
    const { loadCommands } = await import('../src/handlers/loaders/commandLoader.js');
    const { default: loadEvents } = await import('../src/handlers/loaders/events.js');
    const { default: loadInteractions } = await import('../src/handlers/loaders/interactions.js');
    const root = mkdtempSync(join(tmpdir(), 'zentix-loaders-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
    file('package.json', '{"type":"module"}');
    const command = (name) => `export default { data: { name: '${name}', toJSON: () => ({ name: '${name}', options: [] }) }, execute() {} };`;
    file('commands/Fun/joke.js', command('joke'));
    file('commands/Fun/broken.js', 'throw new Error("cannot start");');
    file('commands/Tools/empty.js', 'export default { execute() {} };');
    file('commands/Tools/timer.js', command('timer'));
    file('events/good.js', 'export default { name: "messageCreate", execute() {} };');
    file('events/noname.js', 'export default { execute() {} };');
    file('events/broken.js', 'throw new Error("cannot start");');
    file('interactions/buttons/ok.js', 'export default [{ name: "a", execute() {} }, { name: "b" }];');
    file('interactions/buttons/broken.js', 'throw new Error("cannot start");');
    file('interactions/modals/form.js', 'export default { name: "form", execute() {} };');

    const log = capture(t);
    const client = { buttons: new Map(), selectMenus: new Map(), modals: new Map(), on() {}, once() {} };
    await loadCommands(client, join(root, 'commands'));
    await loadEvents(client, join(root, 'events'));
    await loadInteractions(client, join(root, 'interactions'));

    assert.deepEqual(log.of('startup'), [
        'Commands: 2 loaded in 2 categories, 0 subcommands; 2 files not loaded, see the messages above',
        '  Fun 1 · Tools 1',
        'Events: 1 registered; 2 files not loaded, see the messages above',
        'Interactions: 1 button, 0 select menus, 1 modal; 2 handlers not loaded, see the messages above',
    ]);
    assert.deepEqual(log.of('warn').map((line) => line.replace(root, '')), [
        'Command at /commands/Tools/empty.js is missing required "data" or "execute" property.',
        'Event noname.js is missing required "name" or "execute" properties.',
        'Interaction buttons/ok.js in buttons is missing required properties.',
    ]);
    assert.deepEqual(log.of('error').map((line) => line.replace(root, '')), [
        'Error loading command from /commands/Fun/broken.js:',
        'Error loading event broken.js:',
        'Error loading interaction buttons/broken.js in buttons:',
    ]);
    assert.deepEqual([...client.commands.keys()].sort(), ['joke', 'timer']);
});

test('registering slash commands reports one line, warns at the limit, and logs a refusal once', async (t) => {
    const { loadCommands, registerCommands } = await import('../src/handlers/loaders/commandLoader.js');
    const log = capture(t);
    const client = {};
    await loadCommands(client);
    log.seen.length = 0;

    const sent = [];
    client.rest = { put: async (path, { body }) => { sent.push([path, body.length]); } };
    await registerCommands(client, { clientId: '456789012345678901', guildId: '123456789012345678' });
    assert.deepEqual(sent, [['/applications/456789012345678901/guilds/123456789012345678/commands', client.commands.size]]);
    assert.deepEqual(log.of('startup'), [`Slash commands: ${client.commands.size} registered for server 123456789012345678`]);
    assert.deepEqual(log.of('info'), []);
    assert.deepEqual(log.of('error'), []);
    if (client.commands.size >= 100) {
        assert.deepEqual(log.of('warn'), [`Slash commands: ${client.commands.size} loaded, and Discord registers at most 100 per server. A further command would be left out.`]);
    }

    log.seen.length = 0;
    client.rest = { put: async () => { throw new Error('Missing Access'); } };
    await assert.rejects(registerCommands(client, { clientId: '456789012345678901', guildId: '123456789012345678' }), /Missing Access/);
    assert.deepEqual(log.of('error'), ['Error registering commands:']);
    assert.deepEqual(log.of('startup'), []);
});

// ---------------------------------------------------------------------------------------------
// The whole startup, as the hosting panel shows it
// ---------------------------------------------------------------------------------------------

test('the bot starts with a short, aligned report and stops at the Discord login without a valid token', { skip: !pgEnabled }, async (t) => {
    const admin = new pg.Client({ host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' });
    await admin.connect();
    const database = `logtest_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE "${database}"`);
    const cwd = mkdtempSync(join(tmpdir(), 'zentix-log-'));
    t.after(async () => {
        rmSync(cwd, { recursive: true, force: true });
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
    });
    const port = 20000 + Math.floor(Math.random() * 20000);
    // An empty working directory keeps a developer's own .env out of the run.
    const start = (LOG_LEVEL) => spawnSync(process.execPath, [join(repo, 'src/app.js')], {
        encoding: 'utf8', timeout: 60000, cwd,
        env: {
            PATH: process.env.PATH, NODE_ENV: 'production', LOG_LEVEL, NO_COLOR: '1', WEB_PORT: String(port),
            DISCORD_TOKEN: 'invalid.token.value', CLIENT_ID: '456789012345678901', GUILD_ID: '123456789012345678',
            POSTGRES_URL: `postgresql://user@localhost:55432/${database}?host=/tmp/zentix-local-pg`, POSTGRES_SSL: 'false',
        },
    });

    const lines = start('info').stdout.split('\n').filter(Boolean);
    const login = lines.indexOf(lines.find((line) => line.endsWith('  START  Discord: logging in...')));
    assert.ok(login > 0, lines.join('\n'));
    const report = lines.slice(0, login + 1).filter((line) => !/  WARN   No schema version found/.test(line));
    for (const line of report) assert.match(line, /^\d\d:\d\d:\d\d  START  /, 'every line of the report is a START line');
    const text = report.map((line) => line.slice(17));
    const categories = text.filter((line) => line.startsWith('  '));
    assert.ok(categories.length >= 2 && categories.length <= 4);
    assert.deepEqual(text.filter((line) => !line.startsWith('  ')).map((line) => line.replace(/\d+/g, 'N')), [
        'ZentixBot N.N.N starting (Node vN.N.N, production mode, log level info)',
        'Database: PostgreSQL connected, data is persistent',
        'AI speech-to-text: OpenAI off (missing or invalid: AI_AUDIO_API_KEY, AI_AUDIO_MODEL)',
        'AI web search: Brave Search off (missing or invalid: AI_BRAVE_SEARCH_KEY)',
        'AI images: OpenAI off (missing or invalid: AI_IMAGE_API_KEY, AI_IMAGE_MODEL)',
        'Web port N taken from WEB_PORT',
        'Web server: listening on N.N.N.N:N (/health, /ready, /dashboard/)',
        'Commands: N loaded in N categories, N subcommands',
        'Events: N registered',
        'Interactions: N buttons, N select menus, N modals',
        'Music: N Lavalink nodes configured (vinster, trinium, nazha, serenetia, jirayu, millohost)',
        'Discord: logging in...',
    ]);
    assert.match(lines[login + 1], /^\d\d:\d\d:\d\d  ERROR  Failed to start bot: /, 'the failure names what failed');

    // With LOG_LEVEL=debug the same run lists every file.
    const detailed = start('debug').stdout.split('\n').filter(Boolean);
    assert.ok(detailed.filter((line) => /  DEBUG  Command \S+ \[/.test(line)).length >= 90);
    assert.ok(detailed.some((line) => line.endsWith('  DEBUG  Database tables created/verified')));
    assert.ok(detailed.length > lines.length + 150);
});
