import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgreSQLDatabase } from '../../src/utils/postgresDatabase.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLiteStore } from '../../src/services/storage/sqlite.js';
import { createSQLiteBotDatabase } from '../../src/services/storage/sqliteBotDatabase.js';

// node:sqlite exists from Node 22.5 on. On an older Node the PostgreSQL side of this fixture
// still has to load, so the module is looked up here instead of being imported at the top.
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));

/** Shared fixture for Join to Create tests against the disposable local PostgreSQL. */
// `ZENTIX_TEST_BACKEND=sqlite` runs the same suites on a SQLite file (see tests/sqlite-feature-suites.test.js).
export const onSQLite = process.env.ZENTIX_TEST_BACKEND === 'sqlite';
export const pgEnabled = onSQLite || process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
export const GUILD_ID = '123456789012345678';
export const TRIGGER_ID = '456789012345678901';
export const snowflake = (n) => String(100000000000000000n + BigInt(n));
export const hasCode = (code) => (error) => error.code === code;

/**
 * A generic `set` or `delete` on a row that has its own store is refused:
 * with `false` on PostgreSQL, with a `..._DISABLED` error on SQLite.
 */
export async function isRefused(write) {
    try {
        return (await write) === false;
    } catch (error) {
        if (/_DISABLED$/.test(error?.code ?? '')) return true;
        throw error;
    }
}

const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };

/**
 * The same fixture on a SQLite file. `pool.query` answers the statements the tests use to
 * arrange and inspect rows: temp_data is the bot table, cache_data the other namespace of the file.
 */
async function createJtcSQLite(t) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-jtc-sqlite-'));
    const file = join(dir, 'data.db');
    const sqlite = await openSQLiteStore({ path: file });
    const backend = createSQLiteBotDatabase(sqlite);
    // Tests switch the database off with `isConnected = false`, as they do on PostgreSQL.
    const available = backend.isAvailable.bind(backend);
    backend.isConnected = true;
    backend.isAvailable = () => backend.isConnected !== false && available();
    const raw = new DatabaseSync(file);
    t.after(() => {
        raw.close();
        if (sqlite.isOpen()) sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const client = {
        homeGuildId: GUILD_ID,
        db: {
            db: backend,
            getStatus: () => ({ connectionType: 'sqlite', isDegraded: false }),
            isAvailable: () => backend.isAvailable(),
        },
    };
    const key = `guild:${GUILD_ID}:jointocreate`;
    const millis = (expires) => (expires === null || expires === undefined ? null : new Date(expires).getTime());
    const upsert = raw.prepare('INSERT INTO zentix_bot_kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at');
    const put = async (value, expires = null) => { upsert.run(key, JSON.stringify(value), millis(expires)); };
    const data = async () => {
        const row = raw.prepare('SELECT value FROM zentix_bot_kv WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : undefined;
    };
    const statements = {
        'INSERT INTO cache_data(key,value) VALUES($1,$2)': (p) => raw.prepare('INSERT INTO zentix_kv(key,value) VALUES(?,?)').run(...p),
        'DELETE FROM cache_data': () => raw.exec('DELETE FROM zentix_kv'),
        'INSERT INTO temp_data(key,value) VALUES($1,$2)': (p) => raw.prepare('INSERT INTO zentix_bot_kv(key,value) VALUES(?,?)').run(...p),
        'DELETE FROM temp_data': () => raw.exec('DELETE FROM zentix_bot_kv'),
        'DELETE FROM temp_data WHERE key=$1': (p) => raw.prepare('DELETE FROM zentix_bot_kv WHERE key=?').run(...p),
        "UPDATE temp_data SET value=jsonb_set(value,'{temporaryChannels}',$1::jsonb)": (p) => raw.prepare("UPDATE zentix_bot_kv SET value=json_set(value,'$.temporaryChannels',json(?))").run(...p),
        'UPDATE temp_data SET value=$1::jsonb': (p) => raw.prepare('UPDATE zentix_bot_kv SET value=?').run(JSON.stringify(JSON.parse(p[0]))),
        // The size limit counts the text as it is stored: compact JSON here, PostgreSQL's own spacing there.
        'SELECT octet_length($1::jsonb::text) AS bytes': (p) => ({ rows: [{ bytes: Buffer.byteLength(JSON.stringify(JSON.parse(p[0]))) }] }),
        'SELECT count(*)::int AS n FROM temp_data': () => ({ rows: [{ n: raw.prepare('SELECT count(*) AS n FROM zentix_bot_kv').get().n }] }),
        // A write that the database refuses.
        "CREATE FUNCTION deny_jtc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$; CREATE TRIGGER deny BEFORE UPDATE ON temp_data FOR EACH ROW EXECUTE FUNCTION deny_jtc()":
            () => raw.exec("CREATE TRIGGER deny BEFORE UPDATE ON zentix_bot_kv BEGIN SELECT RAISE(ABORT, 'blocked'); END"),
        'ALTER TABLE temp_data RENAME TO temp_data_gone': () => raw.exec('ALTER TABLE zentix_bot_kv RENAME TO zentix_bot_kv_gone'),
        'ALTER TABLE temp_data_gone RENAME TO temp_data': () => raw.exec('ALTER TABLE zentix_bot_kv_gone RENAME TO zentix_bot_kv'),
    };
    const pool = {
        async query(sql, params = []) {
            const run = statements[String(sql).replace(/\s+/g, ' ').trim()];
            if (!run) throw Object.assign(new Error(`this statement is not available on the SQLite fixture: ${sql}`), { code: 'SQLITE_FIXTURE_SQL' });
            const result = run(params);
            return result?.rows ? result : { rows: [] };
        },
    };
    return { pool, client, backend, key, put, data, sqlite, raw };
}

/** Isolated schema with the two tables the protocol touches; dropped after the test. */
export async function createJtcDatabase(t, prefix = 'jtc') {
    if (onSQLite) return createJtcSQLite(t);
    const admin = new pg.Client(base);
    await admin.connect();
    const schema = `${prefix}_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
        CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY, value jsonb, expires_at timestamptz);
        CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY, value jsonb, expires_at timestamptz)`);

    const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 20 });
    t.after(async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    const backend = new PostgreSQLDatabase();
    backend.pool = pool;
    backend.isConnected = true;

    const client = {
        homeGuildId: GUILD_ID,
        db: {
            db: backend,
            getStatus: () => ({ connectionType: 'postgresql', isDegraded: false }),
            isAvailable: () => backend.isAvailable(),
        },
    };

    const key = `guild:${GUILD_ID}:jointocreate`;
    const put = (value, expires = null) => pool.query(
        'INSERT INTO temp_data(key,value,expires_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,expires_at=$3',
        [key, JSON.stringify(value), expires],
    );
    const data = async () => (await pool.query('SELECT value FROM temp_data WHERE key=$1', [key])).rows[0]?.value;

    return { pool, client, backend, key, put, data };
}

/**
 * A client whose n-th COMMIT succeeds in the database but reports failure,
 * as when the connection drops after the server committed.
 */
export function loseCommitResponse(client, pool, n) {
    let count = 0;
    return {
        ...client,
        db: {
            ...client.db,
            db: {
                isAvailable: () => true,
                pool: {
                    connect: async () => {
                        const real = await pool.connect();
                        return {
                            release: () => real.release(),
                            query: async (...args) => {
                                const result = await real.query(...args);
                                if (args[0] === 'COMMIT' && ++count === n) throw new Error('simulated lost COMMIT response');
                                return result;
                            },
                        };
                    },
                },
            },
        },
    };
}
