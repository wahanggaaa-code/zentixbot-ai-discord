// store.js — the stored list of server stats counters, read and written directly on PostgreSQL.
//
// The generic key-value layer answers a failed read with "no data" and a failed
// write with `false`. For counters that meant: a short database problem during
// `/serverstats create` replaced the whole list with the one new counter, and a
// save that failed was still reported as done. Here every failure is thrown,
// and a change is one transaction that holds the row lock from read to write.

import { createHash } from 'node:crypto';
import { pgConfig } from '../../config/database/postgres.js';

const tables = pgConfig.tables;
const SNOWFLAKE = /^\d{17,20}$/;
const COUNTER_ID = /^[A-Za-z0-9_-]{1,32}$/;

export const COUNTER_TYPES = ['members', 'members_only', 'bots'];
/** One counter per type, so the list cannot grow past this. */
export const MAX_COUNTERS = COUNTER_TYPES.length;

export const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/** The PostgreSQL pool. Throws SERVERSTATS_UNAVAILABLE when PostgreSQL cannot be used right now. */
export function counterPool(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql' || status.isDegraded || !db.isAvailable?.()
        || !db.db?.isAvailable?.() || typeof db.db.pool?.connect !== 'function') {
        throw fail('PostgreSQL unavailable for server stats counters', 'SERVERSTATS_UNAVAILABLE');
    }
    return db.db.pool;
}

function isCounterShape(entry) {
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)
        && typeof entry.id === 'string' && COUNTER_ID.test(entry.id)
        && typeof entry.type === 'string' && entry.type.length > 0 && entry.type.length <= 32
        && typeof entry.channelId === 'string' && SNOWFLAKE.test(entry.channelId));
}

function normalize(entry, guildId) {
    const counter = {
        id: entry.id,
        type: entry.type,
        channelId: entry.channelId,
        guildId,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
    };
    if (typeof entry.updatedAt === 'string') counter.updatedAt = entry.updatedAt;
    return counter;
}

/**
 * The stored column as a list of counters.
 * Entries that cannot be used (no id, type or channel) are left out and counted. A value that is not a list at all
 * is refused: writing over something this code does not understand would destroy it.
 */
export function decodeCounters(raw, guildId) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            throw fail('Stored counters are not valid JSON', 'SERVERSTATS_INVALID');
        }
    }
    if (value === null || value === undefined) return { counters: [], rejected: 0 };
    // A single counter stored without its list, as an older version wrote it.
    if (isCounterShape(value)) value = [value];
    if (!Array.isArray(value)) throw fail('Stored counters are not a list', 'SERVERSTATS_INVALID');

    const counters = [];
    const seen = new Set();
    let rejected = 0;
    for (const entry of value) {
        if (!isCounterShape(entry) || seen.has(entry.id)) {
            rejected += 1;
            continue;
        }
        seen.add(entry.id);
        counters.push(normalize(entry, guildId));
    }
    return { counters, rejected };
}

/** A content hash of the list. Not a version number: A→B→A is not detected. */
export function revisionOf(counters) {
    const canonical = counters.map((c) => [c.id, c.type, c.channelId, c.enabled, c.createdAt, c.updatedAt ?? null]);
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function assertGuild(guildId) {
    if (!SNOWFLAKE.test(guildId || '')) throw fail('Invalid guild id', 'SERVERSTATS_INVALID');
}

/** The stored counters with their revision. Throws on a database error. */
export async function readCounters(client, guildId) {
    assertGuild(guildId);
    const pool = counterPool(client);
    const result = await pool.query(`SELECT counters FROM ${tables.guilds} WHERE id = $1`, [guildId]);
    const { counters, rejected } = decodeCounters(result.rows[0]?.counters ?? null, guildId);
    return { counters, rejected, revision: revisionOf(counters) };
}

/**
 * Change the list inside one transaction.
 *
 * `mutate(counters, revision)` must be synchronous and free of Discord or network effects. It returns
 * `{counters, result}` to store a new list, or `{write: false, result}` to leave the stored value untouched.
 * Anything it throws rolls the transaction back and is passed on.
 */
export async function mutateCounters(client, guildId, mutate) {
    assertGuild(guildId);
    if (typeof mutate !== 'function' || mutate.constructor?.name === 'AsyncFunction') {
        throw fail('Counter mutation must be synchronous', 'SERVERSTATS_INVALID');
    }
    const pool = counterPool(client);
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        await conn.query(`INSERT INTO ${tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`, [guildId]);
        const rows = await conn.query(`SELECT counters FROM ${tables.guilds} WHERE id = $1 FOR UPDATE`, [guildId]);
        if (!rows.rows.length) throw fail('Guild row unavailable', 'SERVERSTATS_UNAVAILABLE');

        const { counters } = decodeCounters(rows.rows[0].counters, guildId);
        const out = mutate(counters.map((counter) => ({ ...counter })), revisionOf(counters));
        if (!out || typeof out !== 'object' || typeof out.then === 'function') throw fail('Invalid counter mutation result', 'SERVERSTATS_INVALID');

        if (out.write === false) {
            await conn.query('ROLLBACK');
            return out.result;
        }

        const { counters: next, rejected } = decodeCounters(out.counters, guildId);
        if (rejected > 0 || next.length > MAX_COUNTERS) throw fail('Refusing to store an invalid counter list', 'SERVERSTATS_INVALID');
        await conn.query(
            `UPDATE ${tables.guilds} SET counters = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [guildId, JSON.stringify(next)],
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
