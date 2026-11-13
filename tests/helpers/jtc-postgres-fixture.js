import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgreSQLDatabase } from '../../src/utils/postgresDatabase.js';

/** Shared fixture for Join to Create tests against the disposable local PostgreSQL. */
export const pgEnabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
export const GUILD_ID = '123456789012345678';
export const TRIGGER_ID = '456789012345678901';
export const snowflake = (n) => String(100000000000000000n + BigInt(n));
export const hasCode = (code) => (error) => error.code === code;

const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };

/** Isolated schema with the two tables the protocol touches; dropped after the test. */
export async function createJtcDatabase(t, prefix = 'jtc') {
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
