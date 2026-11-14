// A small key/value helper for the AI features, on the same storage as the other AI settings:
// table cache_data on PostgreSQL, or the SQLite store.
import { pgConfig } from '../../config/database/postgres.js';
import { sqliteBackend } from '../storage/sqlite.js';

const err = (message, status = 503) => Object.assign(new Error(message), { status });

export function createKV(client) {
    const table = pgConfig.tables.cache_data;
    const pool = () => {
        const d = client.db;
        if (!d || d.getStatus?.().isDegraded || !d.isAvailable?.() || !d.db?.isAvailable?.() || !d.db.pool) throw err('Database persisten tidak tersedia.');
        return d.db.pool;
    };
    const ttl = (seconds) => (Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null);
    return {
        async get(key) {
            const sqlite = sqliteBackend(client);
            if (sqlite) return sqlite.get(key) ?? null;
            const result = await pool().query(`SELECT value FROM ${table} WHERE key=$1 AND (expires_at IS NULL OR expires_at > now())`, [key]);
            return result.rows[0]?.value ?? null;
        },
        /** `ttlSeconds` null keeps the value until it is replaced. */
        async set(key, value, ttlSeconds = null) {
            const seconds = ttl(ttlSeconds);
            const sqlite = sqliteBackend(client);
            if (sqlite) { sqlite.set(key, value, seconds ? Date.now() + seconds * 1000 : null); return value; }
            await pool().query(`INSERT INTO ${table} (key,value,expires_at) VALUES ($1,$2::jsonb,CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(secs => $3::int) END) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=EXCLUDED.expires_at`, [key, JSON.stringify(value), seconds]);
            return value;
        },
        /**
         * Reads, changes and writes one value under a lock, so two writers cannot lose each other's change.
         * `change(current)` gets the stored value or null, must not await, and returns the new value;
         * returning undefined leaves the stored value as it is. Resolves to what `change` returned.
         */
        async update(key, change, ttlSeconds = null) {
            const seconds = ttl(ttlSeconds);
            const sqlite = sqliteBackend(client);
            if (sqlite) {
                return sqlite.transaction((tx) => {
                    const next = change(tx.get(key) ?? null);
                    if (next !== undefined) tx.set(key, next, seconds ? Date.now() + seconds * 1000 : null);
                    return next;
                });
            }
            const conn = await pool().connect();
            try {
                await conn.query('BEGIN');
                await conn.query(`INSERT INTO ${table} (key,value) VALUES ($1,'null'::jsonb) ON CONFLICT (key) DO NOTHING`, [key]);
                const row = (await conn.query(`SELECT value, (expires_at IS NOT NULL AND expires_at <= now()) AS expired FROM ${table} WHERE key=$1 FOR UPDATE`, [key])).rows[0];
                const next = change(row && !row.expired ? row.value ?? null : null);
                if (next === undefined) { await conn.query('ROLLBACK'); return undefined; }
                await conn.query(`UPDATE ${table} SET value=$2::jsonb, expires_at=CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(secs => $3::int) END WHERE key=$1`, [key, JSON.stringify(next), seconds]);
                await conn.query('COMMIT');
                return next;
            } catch (error) {
                await conn.query('ROLLBACK').catch(() => {});
                throw error;
            } finally {
                conn.release();
            }
        },
    };
}

/** The same interface in memory: for tests and for services made without a database. */
export function createMemoryKV({ now = Date.now } = {}) {
    const rows = new Map();
    const live = (key) => {
        const row = rows.get(key);
        if (!row) return null;
        if (row.until !== null && row.until <= now()) { rows.delete(key); return null; }
        return structuredClone(row.value);
    };
    const put = (key, value, seconds) => rows.set(key, { value: structuredClone(value), until: Number.isSafeInteger(seconds) && seconds > 0 ? now() + seconds * 1000 : null });
    return {
        rows,
        async get(key) { return live(key); },
        async set(key, value, ttlSeconds = null) { put(key, value, ttlSeconds); return value; },
        async update(key, change, ttlSeconds = null) {
            const next = change(live(key));
            if (next !== undefined) put(key, next, ttlSeconds);
            return next;
        },
    };
}
