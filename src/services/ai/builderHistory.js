// What the Server Builder created, per server, so that a build can be taken down again ("bongkar").
//
// One record per server: a list of builds, oldest first. Each build holds the Discord IDs of the objects
// that really were created, never just their names: taking a build down deletes those IDs and nothing else.
// The record sits beside the other AI settings (table cache_data, or the SQLite store).
import { pgConfig } from '../../config/database/postgres.js';
import { sqliteBackend } from '../storage/sqlite.js';

/** Builds kept per server. Older ones drop off the list and can then only be removed by hand. */
export const MAX_BUILDS = 20;
export const ITEM_TYPES = Object.freeze(['category', 'text', 'voice', 'forum', 'news', 'stage', 'role']);
export const BUILD_SOURCES = Object.freeze(['ai', 'theme', 'fallback']);

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const snowflake = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);

function validItem(item) {
    return Boolean(item) && typeof item === 'object' && ITEM_TYPES.includes(item.type) && snowflake(item.id)
        && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 100;
}

function validBuild(build) {
    return Boolean(build) && typeof build === 'object'
        && typeof build.id === 'string' && /^[0-9a-f]{8,40}$/.test(build.id)
        && Number.isSafeInteger(build.at) && build.at > 0
        && snowflake(build.actorId)
        && typeof build.label === 'string' && build.label.length <= 80
        && BUILD_SOURCES.includes(build.source)
        && Array.isArray(build.items) && build.items.length > 0 && build.items.length <= 100 && build.items.every(validItem);
}

/** Keeps the well-formed builds of a stored value, newest last, at most MAX_BUILDS. Never throws. */
export function sanitizeBuilds(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(validBuild).slice(-MAX_BUILDS).map((build) => ({
        id: build.id,
        at: build.at,
        actorId: build.actorId,
        label: build.label,
        source: build.source,
        edited: build.edited === true,
        partial: build.partial === true,
        items: build.items.map(({ type, id, name }) => ({ type, id, name })),
    }));
}

export function createBuilderHistory(client) {
    const key = (guildId) => `ai:builder:history:${guildId}`;
    const table = pgConfig.tables.cache_data;
    const pool = () => {
        const d = client.db;
        if (!d || d.getStatus?.().isDegraded || !d.isAvailable?.() || !d.db?.isAvailable?.() || !d.db.pool) throw err('Database persisten tidak tersedia.', 503);
        return d.db.pool;
    };
    return {
        /** The builds of a server, oldest first. */
        async read(guildId) {
            const sqlite = sqliteBackend(client);
            if (sqlite) return sanitizeBuilds(sqlite.get(key(guildId)));
            const result = await pool().query(`SELECT value FROM ${table} WHERE key=$1`, [key(guildId)]);
            return sanitizeBuilds(result.rows[0]?.value);
        },
        /** Replaces the builds of a server. */
        async save(guildId, builds) {
            const value = sanitizeBuilds(builds);
            const sqlite = sqliteBackend(client);
            if (sqlite) { sqlite.set(key(guildId), value); return value; }
            await pool().query(`INSERT INTO ${table} (key,value,expires_at) VALUES ($1,$2::jsonb,NULL) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=NULL`, [key(guildId), JSON.stringify(value)]);
            return value;
        },
    };
}

/** A history that lives in memory only: for tests and for a builder made without a database. */
export function createMemoryBuilderHistory() {
    const rows = new Map();
    return {
        rows,
        async read(guildId) { return sanitizeBuilds(rows.get(guildId)); },
        async save(guildId, builds) { const value = sanitizeBuilds(builds); rows.set(guildId, value); return value; },
    };
}
