// engine.js: which database the bot uses, decided from the environment only.
//
//   DATABASE_ENGINE=sqlite or postgresql   an explicit choice always wins
//                                          (DATABASE_DRIVER and DB_TYPE are read the same way)
//   a PostgreSQL connection is configured  PostgreSQL
//   otherwise                              SQLite, in one file the bot creates itself
//
// "A PostgreSQL connection is configured" means POSTGRES_URL, a postgres:// DATABASE_URL,
// or any of POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD has a value.
//
// Settings that point both ways without an explicit DATABASE_ENGINE stop the bot:
// guessing could start it on an empty database while the real data sits in the other one.

import { resolve } from 'node:path';

export const DEFAULT_SQLITE_PATH = 'data/zentix.db';

const ENGINE_KEYS = ['DATABASE_ENGINE', 'DATABASE_DRIVER', 'DB_TYPE'];
const POSTGRES_KEYS = ['POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'];
const ENGINE_NAMES = { sqlite: 'sqlite', sqlite3: 'sqlite', postgresql: 'postgresql', postgres: 'postgresql', pg: 'postgresql' };

const fail = (message, code) => Object.assign(new Error(message), { code });
const text = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '');

/** The file a `sqlite:` or `file:` address points at, or '' when the address names none. */
function pathFromUrl(url) {
    const rest = url.replace(/^(sqlite|file):/i, '');
    // sqlite:///absolute/path names /absolute/path; sqlite://relative/path and sqlite:relative/path name relative/path.
    return rest.startsWith('//') ? rest.slice(2) : rest;
}

/**
 * @returns {{ engine: 'postgresql', reason: string } | { engine: 'sqlite', path: string, reason: string }}
 */
export function chooseDatabase(env = process.env) {
    const named = ENGINE_KEYS.map((key) => [key, text(env, key).toLowerCase()]).filter(([, value]) => value);
    const engines = new Set();
    for (const [key, value] of named) {
        if (!ENGINE_NAMES[value]) throw fail(`${key} must be "sqlite" or "postgresql".`, 'DATABASE_ENGINE_INVALID');
        engines.add(ENGINE_NAMES[value]);
    }
    if (engines.size > 1) throw fail(`${ENGINE_KEYS.join(', ')} name different databases.`, 'DATABASE_ENGINE_AMBIGUOUS');
    const explicit = [...engines][0] ?? null;

    const url = text(env, 'DATABASE_URL');
    const urlIsSQLite = /^(sqlite|file):/i.test(url);
    const sqlitePath = text(env, 'DATABASE_PATH') || (urlIsSQLite ? pathFromUrl(url) : '');
    const sqliteAsked = Boolean(text(env, 'DATABASE_PATH')) || urlIsSQLite;
    const postgresAsked = POSTGRES_KEYS.some((key) => text(env, key)) || (Boolean(url) && !urlIsSQLite);

    let engine = explicit;
    let reason = explicit ? 'DATABASE_ENGINE' : null;
    if (!engine) {
        if (postgresAsked && sqliteAsked) {
            throw fail(
                'Both a PostgreSQL connection and a SQLite file are configured. Set DATABASE_ENGINE=postgresql or DATABASE_ENGINE=sqlite to choose one.',
                'DATABASE_ENGINE_AMBIGUOUS',
            );
        }
        engine = postgresAsked ? 'postgresql' : 'sqlite';
        reason = postgresAsked ? 'a PostgreSQL connection is configured' : (sqliteAsked ? 'a SQLite file is configured' : 'no PostgreSQL connection is configured');
    }
    if (engine === 'postgresql') return { engine, reason };

    const path = sqlitePath || DEFAULT_SQLITE_PATH;
    if (path === ':memory:' || path.includes('\0')) throw fail('DATABASE_PATH must be a file on disk.', 'DATABASE_PATH_INVALID');
    return { engine, path: resolve(path), reason };
}
