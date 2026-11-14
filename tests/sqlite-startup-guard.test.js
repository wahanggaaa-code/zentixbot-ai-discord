import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseDatabase, DEFAULT_SQLITE_PATH } from '../src/config/database/engine.js';
import { db, initializeDatabase } from '../src/utils/database/wrapper.js';
import { pgDb } from '../src/utils/postgresDatabase.js';
import { createDatabaseReadinessProbe, createReadinessHandler } from '../src/services/storage/databaseReadiness.js';

// Which database the bot starts on. Someone who sets only a bot token gets SQLite in a file
// the bot creates; PostgreSQL is used only when it is configured. Neither falls back to the
// other or to memory.

const ENV_KEYS = [
    'DATABASE_ENGINE', 'DATABASE_DRIVER', 'DB_TYPE', 'DATABASE_URL', 'DATABASE_PATH',
    'POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
];

/** A clean environment, a fresh wrapper and a PostgreSQL driver that only counts calls. */
function setup(t) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-startup-'));
    const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedDb = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType, databasePath: db.databasePath };
    const connect = pgDb.connect;
    const state = { dir, connects: 0 };
    pgDb.connect = async () => { state.connects += 1; return false; };
    const closeFile = () => { if (db.db?.sqlite?.isOpen?.()) db.db.sqlite.close(); };
    const reset = () => {
        closeFile();
        Object.assign(db, { db: null, initialized: false, useFallback: false, connectionType: 'none', databasePath: undefined });
    };
    state.start = async (env) => {
        reset();
        for (const key of ENV_KEYS) delete process.env[key];
        Object.assign(process.env, env);
        return initializeDatabase();
    };
    for (const key of ENV_KEYS) delete process.env[key];
    reset();
    const cwd = process.cwd();
    t.after(() => {
        closeFile();
        process.chdir(cwd);
        pgDb.connect = connect;
        Object.assign(db, savedDb);
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        rmSync(dir, { recursive: true, force: true });
    });
    return state;
}

test('the choice: SQLite unless PostgreSQL is configured; an explicit engine wins; unclear settings stop', () => {
    assert.deepEqual(chooseDatabase({}), { engine: 'sqlite', path: resolve(DEFAULT_SQLITE_PATH), reason: 'no PostgreSQL connection is configured' });
    assert.equal(DEFAULT_SQLITE_PATH, 'data/zentix.db');
    // Empty and blank values count as not set, as they are in a copied .env file.
    assert.equal(chooseDatabase({ POSTGRES_URL: '', POSTGRES_HOST: '  ', DATABASE_URL: '' }).engine, 'sqlite');

    for (const env of [
        { POSTGRES_URL: 'postgresql://u:p@host/db' }, { DATABASE_URL: 'postgres://u:p@host/db' },
        { POSTGRES_HOST: 'localhost' }, { POSTGRES_PORT: '5432' }, { POSTGRES_DB: 'zentix' }, { POSTGRES_USER: 'bot' }, { POSTGRES_PASSWORD: 'x' },
    ]) assert.equal(chooseDatabase(env).engine, 'postgresql', JSON.stringify(env));

    for (const [env, path] of [
        [{ DATABASE_PATH: '/srv/bot/data.db' }, '/srv/bot/data.db'],
        [{ DATABASE_PATH: 'store/data.db' }, resolve('store/data.db')],
        [{ DATABASE_URL: 'sqlite:///srv/bot/data.db' }, '/srv/bot/data.db'],
        [{ DATABASE_URL: 'sqlite:./data.db' }, resolve('data.db')],
        [{ DATABASE_URL: 'file:./data.db' }, resolve('data.db')],
        [{ DATABASE_ENGINE: 'sqlite' }, resolve(DEFAULT_SQLITE_PATH)],
        [{ DATABASE_DRIVER: 'sqlite3' }, resolve(DEFAULT_SQLITE_PATH)],
        [{ DB_TYPE: 'SQLite' }, resolve(DEFAULT_SQLITE_PATH)],
        // An explicit engine wins over a connection that is still in the file.
        [{ DATABASE_ENGINE: 'sqlite', POSTGRES_URL: 'postgresql://u:p@host/db' }, resolve(DEFAULT_SQLITE_PATH)],
    ]) {
        const choice = chooseDatabase(env);
        assert.deepEqual([choice.engine, choice.path], ['sqlite', path], JSON.stringify(env));
    }
    for (const value of ['postgresql', 'postgres', 'pg', 'PostgreSQL']) {
        assert.equal(chooseDatabase({ DATABASE_ENGINE: value, DATABASE_PATH: 'x.db' }).engine, 'postgresql', value);
    }

    assert.throws(() => chooseDatabase({ DATABASE_ENGINE: 'mysql' }), { code: 'DATABASE_ENGINE_INVALID' });
    assert.throws(() => chooseDatabase({ DATABASE_ENGINE: 'sqlite', DB_TYPE: 'postgresql' }), { code: 'DATABASE_ENGINE_AMBIGUOUS' });
    assert.throws(() => chooseDatabase({ POSTGRES_URL: 'postgresql://u:p@host/db', DATABASE_PATH: 'x.db' }), { code: 'DATABASE_ENGINE_AMBIGUOUS' });
    assert.throws(() => chooseDatabase({ DATABASE_PATH: ':memory:' }), { code: 'DATABASE_PATH_INVALID' });
    assert.throws(() => chooseDatabase({ DATABASE_URL: 'sqlite::memory:' }), { code: 'DATABASE_PATH_INVALID' });
});

test('without any database setting the bot starts on a SQLite file it creates, and the data survives a restart', async (t) => {
    const fx = setup(t);
    // The default file is data/zentix.db below the folder the bot is started in.
    process.chdir(fx.dir);
    const file = join(process.cwd(), 'data', 'zentix.db');
    assert.equal(existsSync(file), false);

    await fx.start({});
    assert.equal(fx.connects, 0, 'PostgreSQL is never contacted');
    assert.equal(existsSync(file), true, 'the file and its folder are created');
    assert.deepEqual(db.getStatus(), { initialized: true, connectionType: 'sqlite', isDegraded: false, isAvailable: true, degradedReason: null, path: file });
    assert.equal(db.db.sqlite.dialect, 'sqlite');
    assert.equal(await db.set('temp:startup-check', { kept: true }), true);

    // "Restart": close the file and start again from the same settings.
    await fx.start({});
    assert.deepEqual(await db.get('temp:startup-check'), { kept: true });
    assert.equal(fx.connects, 0);

    // A path of one's own, in folders that do not exist yet.
    const own = join(fx.dir, 'nested', 'folder', 'bot.db');
    await fx.start({ DATABASE_PATH: own });
    assert.equal(existsSync(own), true);
    assert.equal(db.getStatus().path, own);
    assert.equal(await db.get('temp:startup-check'), null, 'another file is another database');
});

test('every way of asking for SQLite starts SQLite', async (t) => {
    const fx = setup(t);
    const file = join(fx.dir, 'data.db');
    for (const env of [
        { DATABASE_ENGINE: 'sqlite', DATABASE_PATH: file },
        { DATABASE_DRIVER: 'sqlite', DATABASE_PATH: file },
        { DB_TYPE: 'SQLite', DATABASE_PATH: file },
        { DATABASE_URL: `sqlite://${file}` },
        { DATABASE_URL: `file:${file}` },
        { DATABASE_PATH: file },
        { DATABASE_ENGINE: 'sqlite', DATABASE_PATH: file, POSTGRES_URL: 'postgresql://u:p@127.0.0.1:1/none' },
    ]) {
        await fx.start(env);
        assert.equal(db.getStatus().connectionType, 'sqlite', JSON.stringify(env));
        assert.equal(db.getStatus().path, file, JSON.stringify(env));
    }
    assert.equal(fx.connects, 0);
});

test('a SQLite file that cannot be opened stops the start: no memory fallback, no switch to PostgreSQL', async (t) => {
    const fx = setup(t);
    const blocker = join(fx.dir, 'not-a-folder');
    writeFileSync(blocker, 'x');
    for (const path of [join(blocker, 'data.db'), fx.dir]) {
        await assert.rejects(fx.start({ DATABASE_PATH: path }), (error) => /^SQLITE_/.test(error.code), path);
        assert.equal(db.db, null);
        assert.equal(db.initialized, false);
        assert.equal(db.useFallback, false);
        assert.equal(db.isAvailable(), false);
    }
    assert.equal(fx.connects, 0);
});

test('unclear settings stop the start before any database is touched', async (t) => {
    const fx = setup(t);
    const file = join(fx.dir, 'data.db');
    await assert.rejects(fx.start({ POSTGRES_URL: 'postgresql://u:p@127.0.0.1:1/none', DATABASE_PATH: file }), { code: 'DATABASE_ENGINE_AMBIGUOUS' });
    await assert.rejects(fx.start({ DATABASE_ENGINE: 'oracle' }), { code: 'DATABASE_ENGINE_INVALID' });
    await assert.rejects(fx.start({ DATABASE_PATH: ':memory:' }), { code: 'DATABASE_PATH_INVALID' });
    assert.equal(fx.connects, 0);
    assert.equal(existsSync(file), false);
    assert.equal(db.db, null);
});

test('a configured PostgreSQL that is down stops the start and is never replaced by SQLite', async (t) => {
    const fx = setup(t);
    for (const env of [{ POSTGRES_URL: 'postgresql://u:p@127.0.0.1:1/none' }, { POSTGRES_HOST: '127.0.0.1' }, { DATABASE_ENGINE: 'postgresql' }]) {
        await assert.rejects(fx.start(env), { code: 'POSTGRES_UNAVAILABLE' }, JSON.stringify(env));
        assert.equal(db.db, null);
        assert.equal(db.useFallback, false);
    }
    assert.equal(fx.connects, 3);
    assert.notEqual(db.getStatus().connectionType, 'sqlite');
});

test('/ready answers for SQLite: ready while the file is usable, not ready once it is closed', async (t) => {
    const fx = setup(t);
    await fx.start({ DATABASE_PATH: join(fx.dir, 'data.db') });
    const client = { db, isReady: () => true, guilds: { cache: new Map() }, commands: new Map() };
    const ask = async () => {
        const out = {};
        const res = { status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
        await createReadinessHandler(client, createDatabaseReadinessProbe())({}, res);
        return out;
    };

    const ready = await ask();
    assert.equal(ready.status, 200);
    assert.equal(ready.body.ready, true);
    assert.deepEqual(ready.body.metrics.database, { mode: 'sqlite', degraded: false, degradedReason: null, reachable: true });

    client.isReady = () => false;
    assert.deepEqual([(await ask()).status, (await ask()).body.reason], [503, 'Bot not Ready']);
    client.isReady = () => true;

    db.db.sqlite.close();
    const closed = await ask();
    assert.equal(closed.status, 503);
    assert.equal(closed.body.reason, 'Database unavailable');
    assert.equal(closed.body.metrics.database.reachable, false);
});
