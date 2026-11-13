// postgresLevels.js — level records on PostgreSQL, read and written directly.
//
// The generic key-value layer answers a failed read with "no data" and a
// failed write with `false`. For levels that turned a short database problem
// into a member reset to level 0, or into a level-up that was announced but
// never stored. Here every failure is thrown, and a change is one transaction
// that holds the row lock from read to write.

import { pgConfig } from '../../config/database/postgres.js';
import { isSQLiteLevelBackend, mutateSQLiteLevel } from './sqliteLevels.js';

const tables = pgConfig.tables;
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_LEVEL = 1000;

const fail = (message, code = 'LEVEL_INVALID') => Object.assign(new Error(message), { code });

/**
 * The PostgreSQL pool when the bot runs on PostgreSQL, otherwise null.
 * Throws when PostgreSQL is the backend but cannot be used right now.
 */
export function postgresLevelPool(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql') return null;
    if (status.isDegraded || !db.isAvailable?.() || !db.db?.isAvailable?.() || typeof db.db.pool?.connect !== 'function') {
        throw fail('PostgreSQL unavailable for level data', 'LEVEL_UNAVAILABLE');
    }
    return db.db.pool;
}

function assertIdentity(guildId, userId) {
    if (!SNOWFLAKE.test(guildId || '') || !SNOWFLAKE.test(userId || '')) throw fail('Invalid level identity');
}

function toMillis(value) {
    if (value instanceof Date) return Math.max(0, value.getTime());
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function fromRow(row) {
    return validate({
        xp: Number(row.xp ?? 0),
        level: Number(row.level ?? 0),
        totalXp: Number(row.total_xp ?? 0),
        lastMessage: toMillis(row.last_message),
        rank: Number(row.rank ?? 0),
    });
}

function validate(value) {
    for (const field of ['xp', 'level', 'totalXp', 'lastMessage', 'rank']) {
        if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw fail('Invalid level value');
    }
    if (value.level > MAX_LEVEL) throw fail('Level outside supported range');
    return value;
}

const defaults = () => ({ xp: 0, level: 0, totalXp: 0, lastMessage: 0, rank: 0 });

/** The stored level record, or zeros when the member has none. Throws on a database error. */
export async function readPostgresLevel(pool, guildId, userId) {
    assertIdentity(guildId, userId);
    const result = await pool.query(
        `SELECT xp, level, total_xp, last_message, rank FROM ${tables.user_levels} WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId],
    );
    return result.rows.length ? fromRow(result.rows[0]) : defaults();
}

/**
 * Change one level record inside a transaction.
 *
 * `mutate(data, exists)` must be synchronous and free of Discord or network
 * effects. It changes `data` in place and returns `{result}` to save, or
 * `{write:false, result}` to leave the record untouched. Same contract as
 * `mutateSQLiteLevel`.
 */
export async function mutatePostgresLevel(pool, guildId, userId, mutate) {
    assertIdentity(guildId, userId);
    if (typeof mutate !== 'function' || mutate.constructor?.name === 'AsyncFunction') {
        throw fail('Level mutation must be synchronous');
    }

    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        await conn.query(`INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [guildId]);
        await conn.query(`INSERT INTO ${tables.users} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [userId]);
        const created = await conn.query(
            `INSERT INTO ${tables.user_levels} (guild_id, user_id, xp, level, total_xp, last_message, rank)
             VALUES ($1, $2, 0, 0, 0, $3, 0) ON CONFLICT (guild_id, user_id) DO NOTHING`,
            [guildId, userId, new Date(0)],
        );
        const rows = await conn.query(
            `SELECT xp, level, total_xp, last_message, rank FROM ${tables.user_levels}
             WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
            [guildId, userId],
        );
        if (!rows.rows.length) throw fail('Level record unavailable', 'LEVEL_UNAVAILABLE');

        const data = fromRow(rows.rows[0]);
        const out = mutate(data, created.rowCount === 0);
        if (!out || typeof out !== 'object' || typeof out.then === 'function') throw fail('Invalid level mutation result');

        if (out.write === false) {
            // Nothing to keep, also not the empty row made above.
            await conn.query('ROLLBACK');
            return out.result;
        }

        const value = validate(data);
        await conn.query(
            `UPDATE ${tables.user_levels}
             SET xp = $3, level = $4, total_xp = $5, last_message = $6, rank = $7, updated_at = CURRENT_TIMESTAMP
             WHERE guild_id = $1 AND user_id = $2`,
            [guildId, userId, value.xp, value.level, value.totalXp, new Date(value.lastMessage), value.rank],
        );
        await conn.query('COMMIT');
        return out.result;
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        conn.release();
    }
}

/** Remove a member's level record. Throws on a database error. */
export async function deletePostgresLevel(pool, guildId, userId) {
    assertIdentity(guildId, userId);
    await pool.query(`DELETE FROM ${tables.user_levels} WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
    return true;
}

/**
 * `(guildId, userId, mutate) => result` for backends that can change a level
 * record atomically (SQLite, PostgreSQL), or null for any other backend.
 */
export function atomicLevelMutator(client) {
    if (isSQLiteLevelBackend(client)) {
        return (guildId, userId, mutate) => mutateSQLiteLevel(client, guildId, userId, mutate);
    }
    const pool = postgresLevelPool(client);
    if (pool) return (guildId, userId, mutate) => mutatePostgresLevel(pool, guildId, userId, mutate);
    return null;
}
