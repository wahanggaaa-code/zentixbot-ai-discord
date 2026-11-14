// store.js — the stored counting game of a server, read and written directly on PostgreSQL.
//
// One row in `temp_data`, key `countingGame:{guildId}`.
//
// The generic key-value layer answers a failed read with "no data" and a failed
// write with `false`. For this game that meant: one failed read while a correct
// number was being recorded stored a fresh, disabled game over the real one, and
// a save that failed was reported as done. Here every failure is thrown, and a
// change is one transaction that holds a lock from read to write, so two numbers
// arriving together are judged one after the other.

import { createHash } from 'node:crypto';
import { pgConfig } from '../../config/database/postgres.js';
import { isCountingSystem } from './systems.js';
import { sqliteFor, readRow, changeRows } from '../storage/sqliteRows.js';

const table = pgConfig.tables.temp_data;
const SNOWFLAKE = /^\d{17,20}$/;

export const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const isSnowflake = (value) => typeof value === 'string' && SNOWFLAKE.test(value);
export const gameKey = (guildId) => `countingGame:${guildId}`;

const count = (value, least) => (Number.isSafeInteger(value) && value >= least ? value : least);

/** A game nobody has set up yet. */
export const emptyGame = () => ({
    enabled: false, channelId: null, system: 'decimal', nextNumber: 1, lastUserId: null, currentStreak: 0, bestStreak: 0, leaderboard: {},
});

/**
 * A stored value as a game. Fields this code cannot use fall back to their
 * defaults; a value that is not an object at all is refused, so that it is
 * never overwritten by accident.
 */
export function decodeGame(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            value = undefined;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Stored counting game is not an object', 'COUNTING_INVALID');

    const leaderboard = {};
    if (value.leaderboard && typeof value.leaderboard === 'object' && !Array.isArray(value.leaderboard)) {
        for (const [userId, counts] of Object.entries(value.leaderboard)) {
            if (isSnowflake(userId) && Number.isSafeInteger(counts) && counts > 0) leaderboard[userId] = counts;
        }
    }
    const channelId = isSnowflake(value.channelId) ? value.channelId : null;
    return {
        // A game without a channel cannot run.
        enabled: value.enabled === true && channelId !== null,
        channelId,
        system: isCountingSystem(value.system) ? value.system : 'decimal',
        nextNumber: count(value.nextNumber, 1),
        lastUserId: isSnowflake(value.lastUserId) ? value.lastUserId : null,
        currentStreak: count(value.currentStreak, 0),
        bestStreak: count(value.bestStreak, 0),
        leaderboard,
    };
}

/**
 * A hash of the settings of a game (on/off, channel, system). The numbers that
 * change with every count are left out on purpose: a page showing a running game
 * would otherwise be out of date all the time.
 */
export function revisionOf(game) {
    return createHash('sha256').update(JSON.stringify([game.enabled, game.channelId, game.system])).digest('hex');
}

/** The PostgreSQL pool. Throws COUNTING_UNAVAILABLE when PostgreSQL cannot be used right now. */
export function countingPool(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql' || status.isDegraded || !db.isAvailable?.()
        || !db.db?.isAvailable?.() || typeof db.db.pool?.connect !== 'function') {
        throw fail('PostgreSQL unavailable for the counting game', 'COUNTING_UNAVAILABLE');
    }
    return db.db.pool;
}

function assertGuild(guildId) {
    if (!isSnowflake(guildId)) throw fail('Invalid guild id', 'COUNTING_INVALID');
}

const wrap = (error) => (error?.code?.startsWith?.('COUNTING_') ? error : fail('Counting game storage failed', 'COUNTING_UNAVAILABLE', { cause: error }));

/** The stored game, or an empty one when the server has none. A failed read is thrown, never "no game". */
const unavailable = () => fail('Database unavailable for the counting game', 'COUNTING_UNAVAILABLE');

function mutateOnSQLite(sqlite, guildId, mutate) {
    try {
        return changeRows(sqlite, (rows) => {
            const stored = rows.get(gameKey(guildId));
            const current = stored === undefined ? emptyGame() : decodeGame(stored);
            const out = mutate({ ...current, leaderboard: { ...current.leaderboard } });
            if (!out || typeof out !== 'object' || typeof out.then === 'function') throw fail('Invalid counting game mutation result', 'COUNTING_INVALID');
            if (out.write !== false) rows.put(gameKey(guildId), decodeGame(out.game));
            return out.result;
        });
    } catch (error) {
        throw wrap(error);
    }
}

export async function readGame(client, guildId) {
    assertGuild(guildId);
    const sqlite = sqliteFor(client, unavailable);
    if (sqlite) {
        try {
            const stored = readRow(sqlite, gameKey(guildId));
            return stored === undefined ? emptyGame() : decodeGame(stored);
        } catch (error) {
            throw wrap(error);
        }
    }
    const pool = countingPool(client);
    let result;
    try {
        result = await pool.query(`SELECT value FROM ${table} WHERE key = $1`, [gameKey(guildId)]);
    } catch (error) {
        throw wrap(error);
    }
    return result.rows.length ? decodeGame(result.rows[0].value) : emptyGame();
}

/**
 * Change the game in one transaction.
 *
 * `mutate(game)` must be synchronous and free of Discord or network effects. It gets a copy and
 * returns `{game, result}` to store that game, or `{write: false, result}` to leave everything
 * untouched. Anything it throws rolls the transaction back and is passed on.
 */
export async function mutateGame(client, guildId, mutate) {
    assertGuild(guildId);
    if (typeof mutate !== 'function' || mutate.constructor?.name === 'AsyncFunction') {
        throw fail('Counting game mutation must be synchronous', 'COUNTING_INVALID');
    }
    const sqlite = sqliteFor(client, unavailable);
    if (sqlite) return mutateOnSQLite(sqlite, guildId, mutate);
    const pool = countingPool(client);
    let conn;
    try {
        conn = await pool.connect();
    } catch (error) {
        throw wrap(error);
    }
    let committing = false;
    try {
        await conn.query('BEGIN');
        // The row may not exist yet, so a row lock alone would not keep two first writers apart.
        await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zentix:counting_game:${guildId}`]);
        const rows = await conn.query(`SELECT value FROM ${table} WHERE key = $1 FOR UPDATE`, [gameKey(guildId)]);
        const current = rows.rows.length ? decodeGame(rows.rows[0].value) : emptyGame();

        const out = mutate({ ...current, leaderboard: { ...current.leaderboard } });
        if (!out || typeof out !== 'object' || typeof out.then === 'function') throw fail('Invalid counting game mutation result', 'COUNTING_INVALID');
        if (out.write === false) {
            await conn.query('ROLLBACK');
            return out.result;
        }
        const next = decodeGame(out.game);
        await conn.query(
            `INSERT INTO ${table} (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`,
            [gameKey(guildId), JSON.stringify(next)],
        );
        committing = true;
        await conn.query('COMMIT');
        return out.result;
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        // A COMMIT whose answer was lost may or may not have been applied.
        if (committing) throw fail('Counting game commit outcome unknown', 'COUNTING_UNCERTAIN', { cause: error });
        throw wrap(error);
    } finally {
        conn.release();
    }
}
