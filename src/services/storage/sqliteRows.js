// sqliteRows.js: the key and value rows of a feature on SQLite.
//
// On PostgreSQL every feature store opens a connection, takes a lock, reads its rows,
// changes them and commits. SQLite here is one file opened by one process, and its
// transactions are synchronous: nothing may be awaited between BEGIN and COMMIT.
//
// Two ways to change rows follow from that:
//
//   changeRows(sqlite, work)        `work` is synchronous. It runs inside one SQLite
//                                   transaction, so it is atomic and nothing can interleave.
//
//   rowTransaction(sqlite, name, work)
//                                   `work` may await. Calls with the same `name` run one
//                                   after the other. Reads come from the file, writes are kept
//                                   aside and stored together at the end. Before storing, every
//                                   row that was read is compared with the file again; when
//                                   something else changed one of them, nothing is stored and
//                                   the call fails with SQLITE_ROW_CONFLICT.
//
// Rows live in the table `zentix_bot_kv`. A row past its expiry time reads as absent.

import { sqliteBackend } from './sqlite.js';

const fail = (message, code) => Object.assign(new Error(message), { code });

/** The SQLite store behind `client`, or null when the bot runs on another database. */
export const sqliteRowsOf = (client) => sqliteBackend(client);

/** True when `client` is set up for SQLite, also while the file cannot be used. */
export const usesSQLite = (client) => client?.db?.getStatus?.()?.connectionType === 'sqlite';

/** One value, `undefined` when there is no such row. */
export function readRow(sqlite, key) {
    const value = sqlite.botGet(key);
    return value === null ? undefined : value;
}

/** The rows of `keys` that exist, as a Map from key to value. */
export function readRows(sqlite, keys) {
    const found = new Map();
    for (const key of keys) {
        const value = sqlite.botGet(key);
        if (value !== null) found.set(key, value);
    }
    return found;
}

/** Every row whose key starts with one of `prefixes`, as `{ key, value }`. */
export function readPrefixes(sqlite, ...prefixes) {
    return prefixes.flatMap((prefix) => sqlite.botRows(prefix));
}

const view = (tx) => ({
    get: (key) => {
        const value = tx.botGet(key);
        return value === null ? undefined : value;
    },
    getMany: (keys) => {
        const found = new Map();
        for (const key of keys) {
            const value = tx.botGet(key);
            if (value !== null) found.set(key, value);
        }
        return found;
    },
    rows: (...prefixes) => prefixes.flatMap((prefix) => tx.botRows(prefix)),
    put: (key, value, expiresAt = null) => { tx.botSet(key, value, expiresAt); },
    del: (...keys) => { for (const key of keys.flat()) tx.botDelete(key); },
});

/** Runs the synchronous `work({ get, getMany, rows, put, del })` in one SQLite transaction. */
export function changeRows(sqlite, work) {
    if (typeof work !== 'function' || work.constructor?.name === 'AsyncFunction') {
        throw fail('A SQLite row change must be synchronous', 'SQLITE_INVALID');
    }
    return sqlite.transaction((tx) => work(view(tx)));
}

const queues = new WeakMap();

function lockOf(sqlite, name) {
    let byName = queues.get(sqlite);
    if (!byName) queues.set(sqlite, byName = new Map());
    const before = byName.get(name) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const tail = before.then(() => mine);
    byName.set(name, tail);
    return {
        ready: before,
        release: () => {
            release();
            if (byName.get(name) === tail) byName.delete(name);
        },
    };
}

const stamp = (value) => (value === undefined ? null : JSON.stringify(value));

/**
 * Runs `work(tx)` alone among the calls that share `name`, then stores what it wrote
 * in one SQLite transaction. `tx` has get, getMany, rows, put and del; they may be awaited.
 */
export async function rowTransaction(sqlite, name, work) {
    const lock = lockOf(sqlite, name);
    await lock.ready;
    try {
        const written = new Map(); // key -> { value, expiresAt } | null (deleted)
        const seenKeys = new Map(); // key -> JSON text as first read from the file
        const seenPrefixes = new Map(); // prefix -> JSON text of the rows as first read
        const fromFile = (key) => {
            const value = readRow(sqlite, key);
            if (!seenKeys.has(key)) seenKeys.set(key, stamp(value));
            return value;
        };
        const get = (key) => {
            if (written.has(key)) return written.get(key)?.value;
            return fromFile(key);
        };
        const tx = {
            get,
            getMany: (keys) => {
                const found = new Map();
                for (const key of keys) {
                    const value = get(key);
                    if (value !== undefined) found.set(key, value);
                }
                return found;
            },
            rows: (...prefixes) => {
                const merged = new Map();
                for (const prefix of prefixes) {
                    const rows = sqlite.botRows(prefix);
                    if (!seenPrefixes.has(prefix)) seenPrefixes.set(prefix, JSON.stringify(rows));
                    for (const row of rows) merged.set(row.key, row.value);
                    for (const [key, entry] of written) {
                        if (!key.startsWith(prefix)) continue;
                        if (entry === null) merged.delete(key);
                        else merged.set(key, entry.value);
                    }
                }
                return [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => ({ key, value }));
            },
            put: (key, value, expiresAt = null) => {
                // Stored as JSON, so what a later read returns is what the file will hold.
                written.set(key, { value: JSON.parse(JSON.stringify(value)), expiresAt });
            },
            del: (...keys) => { for (const key of keys.flat()) written.set(key, null); },
        };

        const result = await work(tx);

        if (written.size > 0) {
            sqlite.transaction((file) => {
                for (const [key, before] of seenKeys) {
                    const now = file.botGet(key);
                    if (stamp(now === null ? undefined : now) !== before) throw fail('A row changed while it was being updated', 'SQLITE_ROW_CONFLICT');
                }
                for (const [prefix, before] of seenPrefixes) {
                    if (JSON.stringify(file.botRows(prefix)) !== before) throw fail('Rows changed while they were being updated', 'SQLITE_ROW_CONFLICT');
                }
                for (const [key, entry] of written) {
                    if (entry === null) file.botDelete(key);
                    else file.botSet(key, entry.value, entry.expiresAt);
                }
            });
        }
        return result;
    } finally {
        lock.release();
    }
}

/**
 * The SQLite store to use for `client`, or null when the bot runs on another database.
 * Throws `unavailable()` when the bot is set up for SQLite but the file cannot be used.
 */
export function sqliteFor(client, unavailable) {
    const sqlite = sqliteBackend(client);
    if (sqlite?.isOpen?.()) return sqlite;
    if (sqlite || usesSQLite(client)) throw unavailable();
    return null;
}
