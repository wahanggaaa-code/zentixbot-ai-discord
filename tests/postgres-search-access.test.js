import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { createCoreApi } from '../src/dashboard/coreApi.js';
import { isCommandEnabled } from '../src/services/commandAccessService.js';
import { resolveSlashAccessKey } from '../src/utils/messageAdapter.js';
import search from '../src/commands/Search/search.js';

// /search has no settings of its own. What an administrator can do is switch each of its
// subcommands off from the "Akses perintah" page; this checks that with the real command definition.

const enabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
const guildId = '123456789012345678';

async function setup(t) {
    const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };
    const admin = new pg.Client(base);
    await admin.connect();
    const schema = `search_access_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY, config jsonb DEFAULT '{}', updated_at timestamp DEFAULT now());
        CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY, config jsonb DEFAULT '{}')`);
    const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 5 });
    t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
    const backend = new PostgreSQLDatabase();
    backend.pool = pool;
    backend.isConnected = true;

    // The command loader names the category after the folder.
    const commands = new Map([
        ['search', { ...search, category: 'Search' }],
        ['ping', { category: 'Core', data: { name: 'ping', description: 'Ping', toJSON: () => ({ name: 'ping', options: [] }) } }],
    ]);
    const guild = { id: guildId, name: 'Server' };
    const client = {
        commands, isReady: () => true, guilds: { cache: new Map([[guildId, guild]]) },
        db: { db: backend, getStatus: () => ({ connectionType: 'postgresql', isDegraded: false }), isAvailable: () => Boolean(backend.isAvailable()) },
    };
    const app = express();
    app.use('/api', createCoreApi(client, { auth: (req, res, next) => { req.guild = guild; next(); }, csrf: (req, res, next) => next() }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/api/core/commands`;
    const view = async () => (await fetch(url)).json();
    const change = async (target, disabled, kind = 'command') => {
        const { revision } = await view();
        return fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, revision, kind, target, disabled }) });
    };
    const allowed = (key) => isCommandEnabled(client, guildId, key, 'Search');
    return { client, view, change, allowed };
}

/** The key the interaction handler checks for a slash command, taken from the same function it uses. */
const keyFor = (subcommand) => resolveSlashAccessKey({ commandName: 'search', options: { getSubcommandGroup: () => null, getSubcommand: () => subcommand } });

test('access page: each /search subcommand is listed and can be switched off on its own', { skip: !enabled }, async (t) => {
    const { view, change, allowed } = await setup(t);

    const listed = (await view()).categories.find((category) => category.key === 'search');
    assert.equal(listed.name, 'Search');
    assert.deepEqual(listed.commands.map((command) => [command.name, command.enabled, command.protected]), [
        ['search', true, false], ['search define', true, false], ['search google', true, false], ['search urban', true, false],
    ]);
    assert.match(listed.commands.find((command) => command.name === 'search urban').description, /age-restricted channels only/);
    assert.deepEqual(['define', 'google', 'urban'].map(keyFor), ['search define', 'search google', 'search urban']);

    // Only Urban Dictionary off.
    assert.equal((await change('search urban', true)).status, 200);
    assert.deepEqual(await Promise.all(['define', 'google', 'urban'].map((sub) => allowed(keyFor(sub)))), [true, true, false]);
    const after = (await view()).categories.find((category) => category.key === 'search');
    assert.deepEqual(after.commands.map((command) => [command.name, command.enabled, command.ownDisabled]), [
        ['search', true, false], ['search define', true, false], ['search google', true, false], ['search urban', false, true],
    ]);

    // And on again.
    assert.equal((await change('search urban', false)).status, 200);
    assert.deepEqual(await Promise.all(['define', 'google', 'urban'].map((sub) => allowed(keyFor(sub)))), [true, true, true]);

    // The whole command, then the whole category.
    assert.equal((await change('search', true)).status, 200);
    assert.deepEqual(await Promise.all(['define', 'google', 'urban'].map((sub) => allowed(keyFor(sub)))), [false, false, false]);
    assert.equal((await change('search', false)).status, 200);
    assert.equal((await change('search', true, 'category')).status, 200);
    assert.deepEqual(await Promise.all(['define', 'google', 'urban'].map((sub) => allowed(keyFor(sub)))), [false, false, false]);

    // A subcommand that does not exist is not accepted as a target.
    assert.equal((await change('search bing', true)).status, 400);
});
