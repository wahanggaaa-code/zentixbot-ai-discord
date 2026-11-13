// store.js — to-do lists, read and written directly on PostgreSQL.
//
// Three kinds of rows in `temp_data`:
//   todo_{userId}               the personal list of a member
//   shared_todo_{listId}        a shared list (name, owner, members, tasks)
//   user_shared_lists_{userId}  the ids of the shared lists a member belongs to
//
// The generic key-value layer answers a failed read with "no data" and a failed
// write with `false`. For a to-do list that meant: one failed read while a task
// was being added stored a list with only that task over the real one, and a
// save that failed was reported as done. Here every failure is thrown, and a
// change is one transaction that holds a lock from read to write, so two members
// changing the same list are served one after the other.

import { pgConfig } from '../../config/database/postgres.js';

const table = pgConfig.tables.temp_data;
const SNOWFLAKE = /^\d{17,20}$/;
// Ids made by this bot are 32 hex characters. The wider pattern is what the buttons always accepted.
const LIST_ID = /^[a-zA-Z0-9-]{1,64}$/;

export const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const isSnowflake = (value) => typeof value === 'string' && SNOWFLAKE.test(value);
export const isListId = (value) => typeof value === 'string' && LIST_ID.test(value);

export const personalKey = (userId) => `todo_${userId}`;
export const sharedKey = (listId) => `shared_todo_${listId}`;
export const indexKey = (userId) => `user_shared_lists_${userId}`;

const parse = (raw) => {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
};
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isoOrNull = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);

/**
 * Stored tasks as tasks. An entry without a usable number or text cannot be shown,
 * completed or removed by anyone, so it is left out; so is a second entry with a number
 * that is already taken.
 */
function decodeTasks(raw) {
    const tasks = [];
    const seen = new Set();
    for (const entry of Array.isArray(raw) ? raw : []) {
        if (!isRecord(entry) || !Number.isSafeInteger(entry.id) || entry.id < 1 || seen.has(entry.id)) continue;
        if (typeof entry.text !== 'string' || entry.text.trim() === '') continue;
        seen.add(entry.id);
        const task = { id: entry.id, text: entry.text, completed: entry.completed === true, createdAt: isoOrNull(entry.createdAt) };
        if (isSnowflake(entry.createdBy)) task.createdBy = entry.createdBy;
        if (task.completed && isSnowflake(entry.completedBy)) task.completedBy = entry.completedBy;
        tasks.push(task);
    }
    return tasks;
}

/** The number the next task gets: never one that is, or was, in use. */
function decodeNextId(raw, tasks) {
    const highest = tasks.reduce((most, task) => Math.max(most, task.id), 0);
    return Math.max(Number.isSafeInteger(raw) && raw >= 1 ? raw : 1, highest + 1);
}

/** A list nobody has written to yet. */
export const emptyPersonal = () => ({ tasks: [], nextId: 1 });

/** A stored value as a personal list. A value that is not an object is refused, so it is never overwritten by accident. */
export function decodePersonal(raw) {
    const value = parse(raw);
    if (!isRecord(value)) throw fail('Stored to-do list is not an object', 'TODO_INVALID');
    const tasks = decodeTasks(value.tasks);
    return { tasks, nextId: decodeNextId(value.nextId, tasks) };
}

/** A stored value as a shared list. Without an owner the list belongs to nobody and is refused. */
export function decodeShared(raw, listId) {
    const value = parse(raw);
    if (!isRecord(value) || !isSnowflake(value.creatorId)) throw fail('Stored shared to-do list is unusable', 'TODO_INVALID');
    const members = [...new Set([value.creatorId, ...(Array.isArray(value.members) ? value.members.filter(isSnowflake) : [])])];
    const tasks = decodeTasks(value.tasks);
    return {
        id: listId,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Untitled list',
        creatorId: value.creatorId,
        members,
        tasks,
        nextId: decodeNextId(value.nextId, tasks),
        createdAt: isoOrNull(value.createdAt),
    };
}

/** Stored list ids of a member. Anything else in the array is dropped. */
export function decodeIndex(raw) {
    const value = parse(raw);
    return Array.isArray(value) ? [...new Set(value.filter(isListId))] : [];
}

/** The PostgreSQL pool. Throws TODO_UNAVAILABLE when PostgreSQL cannot be used right now. */
export function todoPool(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql' || status.isDegraded || !db.isAvailable?.()
        || !db.db?.isAvailable?.() || typeof db.db.pool?.connect !== 'function') {
        throw fail('PostgreSQL unavailable for to-do lists', 'TODO_UNAVAILABLE');
    }
    return db.db.pool;
}

const wrap = (error) => (error?.code?.startsWith?.('TODO_') ? error : fail('To-do storage failed', 'TODO_UNAVAILABLE', { cause: error }));

/** One stored value, or `undefined` when there is no row. A failed read is thrown, never "no data". */
export async function readRow(client, key) {
    const pool = todoPool(client);
    try {
        const result = await pool.query(`SELECT value FROM ${table} WHERE key = $1`, [key]);
        return result.rows[0]?.value;
    } catch (error) {
        throw wrap(error);
    }
}

/** Stored values by key, for the keys that exist. */
export async function readRows(client, keys) {
    if (keys.length === 0) return new Map();
    const pool = todoPool(client);
    try {
        const result = await pool.query(`SELECT key, value FROM ${table} WHERE key = ANY($1::text[])`, [keys]);
        return new Map(result.rows.map((row) => [row.key, row.value]));
    } catch (error) {
        throw wrap(error);
    }
}

/**
 * Run `work(tx)` in one transaction and return what it returns.
 *
 *   tx.lock(name)      wait for the lock `name`; held until the transaction ends
 *   tx.get(key)        the stored value or `undefined`
 *   tx.getMany(keys)   Map of key → stored value
 *   tx.put(key, value) store a value
 *   tx.del(key)        delete a row
 *
 * Take locks in the order "shared list, then member index" and never two of a kind;
 * that order is what keeps two transactions from waiting on each other forever.
 * Anything `work` throws rolls everything back and is passed on.
 */
export async function transaction(client, work) {
    const pool = todoPool(client);
    let conn;
    try {
        conn = await pool.connect();
    } catch (error) {
        throw wrap(error);
    }
    let committing = false;
    const tx = {
        lock: (name) => conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zentix:todo:${name}`]),
        get: async (key) => (await conn.query(`SELECT value FROM ${table} WHERE key = $1 FOR UPDATE`, [key])).rows[0]?.value,
        getMany: async (keys) => new Map(keys.length === 0 ? [] : (await conn.query(`SELECT key, value FROM ${table} WHERE key = ANY($1::text[])`, [keys])).rows.map((row) => [row.key, row.value])),
        put: (key, value) => conn.query(
            `INSERT INTO ${table} (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`,
            [key, JSON.stringify(value)],
        ),
        del: (key) => conn.query(`DELETE FROM ${table} WHERE key = $1`, [key]),
    };
    try {
        await conn.query('BEGIN');
        const result = await work(tx);
        committing = true;
        await conn.query('COMMIT');
        return result;
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        // A COMMIT whose answer was lost may or may not have been applied.
        if (committing) throw fail('To-do commit outcome unknown', 'TODO_UNCERTAIN', { cause: error });
        throw wrap(error);
    } finally {
        conn.release();
    }
}
