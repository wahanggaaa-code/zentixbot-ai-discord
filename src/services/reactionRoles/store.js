// store.js — stored reaction role panels, read and written directly on PostgreSQL.
//
// One row per panel in `temp_data`, key `guild:{guildId}:reaction_roles:{messageId}`
// (older data may still sit under `reaction_roles:{guildId}:{messageId}`).
//
// The generic key-value layer answers a failed read with "no data" and a failed
// write with `false`. For panels that meant: a short database problem let a sixth
// panel through the limit, a save that failed was reported as "Success", and a
// member was told the panel "is no longer active". Here every failure is thrown,
// and a change is one transaction that holds a per-guild lock from read to write.

import { createHash } from 'node:crypto';
import { pgConfig } from '../../config/database/postgres.js';
import { sqliteFor, readRows, readPrefixes, changeRows } from '../storage/sqliteRows.js';

const table = pgConfig.tables.temp_data;
const SNOWFLAKE = /^\d{17,20}$/;

export const MAX_PANELS = 5;
export const MAX_ROLES = 25;
export const MAX_TITLE = 256;
export const MAX_DESCRIPTION = 2048;

export const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const isSnowflake = (value) => typeof value === 'string' && SNOWFLAKE.test(value);

/** The PostgreSQL pool. Throws REACTROLES_UNAVAILABLE when PostgreSQL cannot be used right now. */
export function panelPool(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql' || status.isDegraded || !db.isAvailable?.()
        || !db.db?.isAvailable?.() || typeof db.db.pool?.connect !== 'function') {
        throw fail('PostgreSQL unavailable for reaction role panels', 'REACTROLES_UNAVAILABLE');
    }
    return db.db.pool;
}

const canonicalPrefix = (guildId) => `guild:${guildId}:reaction_roles:`;
const legacyPrefix = (guildId) => `reaction_roles:${guildId}:`;
export const panelKey = (guildId, messageId) => `${canonicalPrefix(guildId)}${messageId}`;
const legacyKey = (guildId, messageId) => `${legacyPrefix(guildId)}${messageId}`;
/** `_` and `%` are wildcards in LIKE; the prefix must match literally. */
const like = (prefix) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`;

function assertGuild(guildId) {
    if (!isSnowflake(guildId)) throw fail('Invalid guild id', 'REACTROLES_INVALID');
}

function cleanText(value, max) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text.length > 0 && text.length <= max ? text : null;
}

/**
 * A stored value as a panel, or `null` when this code cannot use it.
 * `roles` was once written as an emoji → role object; both forms are read, a list is written.
 */
export function decodePanel(raw, guildId, messageId) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!isSnowflake(messageId) || !isSnowflake(value.channelId)) return null;
    if (value.messageId !== undefined && value.messageId !== messageId) return null;

    let roles = value.roles;
    if (roles && typeof roles === 'object' && !Array.isArray(roles)) roles = Object.values(roles);
    if (!Array.isArray(roles) || roles.some((id) => !isSnowflake(id))) return null;
    roles = [...new Set(roles)];
    if (roles.length > MAX_ROLES) return null;

    const panel = {
        guildId,
        channelId: value.channelId,
        messageId,
        roles,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    };
    if (typeof value.updatedAt === 'string') panel.updatedAt = value.updatedAt;
    const title = cleanText(value.title, MAX_TITLE);
    const description = cleanText(value.description, MAX_DESCRIPTION);
    if (title) panel.title = title;
    if (description) panel.description = description;
    return panel;
}

/** A content hash of one panel. Not a version number: A→B→A is not detected. */
export function revisionOf(panel) {
    const canonical = [panel.messageId, panel.channelId, panel.roles, panel.title ?? null, panel.description ?? null];
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function decodeRows(rows, guildId) {
    const byMessage = new Map();
    let rejected = 0;
    // Canonical keys sort after legacy ones here so that they win when both exist.
    const ordered = [...rows].sort((a, b) => Number(a.key.startsWith('guild:')) - Number(b.key.startsWith('guild:')));
    for (const row of ordered) {
        const messageId = row.key.slice(row.key.lastIndexOf(':') + 1);
        const panel = decodePanel(row.value, guildId, messageId);
        if (!panel) {
            rejected += 1;
            continue;
        }
        byMessage.set(messageId, panel);
    }
    const panels = [...byMessage.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId));
    return { panels, rejected };
}

const SELECT = `SELECT key, value FROM ${table} WHERE (key LIKE $1 OR key LIKE $2) AND (expires_at IS NULL OR expires_at > NOW())`;

/** Every stored panel of the guild. `rejected` counts rows this code cannot read. Throws on a database error. */
const unavailable = () => fail('Database unavailable for reaction role panels', 'REACTROLES_UNAVAILABLE');

/**
 * What a mutation asked for, checked against the panels that exist. Returns the keys to
 * delete and the panels to store, or null when nothing is to be written.
 */
function planChange(panels, out, guildId) {
    if (!out || typeof out !== 'object' || typeof out.then === 'function') throw fail('Invalid panel mutation result', 'REACTROLES_INVALID');
    if (out.write === false) return null;
    const remove = [...new Set(out.remove ?? [])];
    const put = out.put ?? [];
    if (remove.some((id) => !isSnowflake(id))) throw fail('Invalid message id', 'REACTROLES_INVALID');
    const after = new Map(panels.map((panel) => [panel.messageId, panel]));
    for (const id of remove) after.delete(id);
    for (const entry of put) {
        const panel = decodePanel(entry, guildId, entry?.messageId);
        if (!panel || panel.roles.length === 0) throw fail('Refusing to store an invalid panel', 'REACTROLES_INVALID');
        after.set(panel.messageId, panel);
    }
    if (after.size > MAX_PANELS && after.size > panels.length) throw fail('Panel limit reached', 'REACTROLES_LIMIT', { limit: MAX_PANELS });
    return { remove, store: put.map((entry) => after.get(entry.messageId)) };
}

function mutateOnSQLite(sqlite, guildId, mutate) {
    return changeRows(sqlite, (rows) => {
        const { panels } = decodeRows(rows.rows(canonicalPrefix(guildId), legacyPrefix(guildId)), guildId);
        const out = mutate(panels.map((panel) => ({ ...panel, roles: [...panel.roles] })));
        const plan = planChange(panels, out, guildId);
        if (plan) {
            for (const id of plan.remove) rows.del(panelKey(guildId, id), legacyKey(guildId, id));
            for (const panel of plan.store) {
                rows.put(panelKey(guildId, panel.messageId), panel);
                rows.del(legacyKey(guildId, panel.messageId));
            }
        }
        return out.result;
    });
}

export async function readPanels(client, guildId) {
    assertGuild(guildId);
    const sqlite = sqliteFor(client, unavailable);
    if (sqlite) return decodeRows(readPrefixes(sqlite, canonicalPrefix(guildId), legacyPrefix(guildId)), guildId);
    const pool = panelPool(client);
    const result = await pool.query(SELECT, [like(canonicalPrefix(guildId)), like(legacyPrefix(guildId))]);
    return decodeRows(result.rows, guildId);
}

/** One stored panel or `null`. Throws on a database error. */
export async function readPanel(client, guildId, messageId) {
    assertGuild(guildId);
    if (!isSnowflake(messageId)) return null;
    const sqlite = sqliteFor(client, unavailable);
    if (sqlite) {
        const rows = [...readRows(sqlite, [panelKey(guildId, messageId), legacyKey(guildId, messageId)])].map(([key, value]) => ({ key, value }));
        return decodeRows(rows, guildId).panels[0] ?? null;
    }
    const pool = panelPool(client);
    const result = await pool.query(
        `SELECT key, value FROM ${table} WHERE key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > NOW())`,
        [[panelKey(guildId, messageId), legacyKey(guildId, messageId)]],
    );
    return decodeRows(result.rows, guildId).panels[0] ?? null;
}

/**
 * Change the guild's panels inside one transaction.
 *
 * `mutate(panels)` must be synchronous and free of Discord or network effects. It returns
 * `{put: [panel…], remove: [messageId…], result}` to write, or `{write: false, result}` to
 * leave everything untouched. Anything it throws rolls the transaction back and is passed on.
 * Rows this code cannot read are never touched.
 */
export async function mutatePanels(client, guildId, mutate) {
    assertGuild(guildId);
    if (typeof mutate !== 'function' || mutate.constructor?.name === 'AsyncFunction') {
        throw fail('Panel mutation must be synchronous', 'REACTROLES_INVALID');
    }
    const sqlite = sqliteFor(client, unavailable);
    if (sqlite) return mutateOnSQLite(sqlite, guildId, mutate);
    const pool = panelPool(client);
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        // One writer per guild: the panel limit counts rows, so a row lock alone would not hold it.
        await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zentix:reaction_roles:${guildId}`]);
        const rows = await conn.query(`${SELECT} FOR UPDATE`, [like(canonicalPrefix(guildId)), like(legacyPrefix(guildId))]);
        const { panels } = decodeRows(rows.rows, guildId);

        const out = mutate(panels.map((panel) => ({ ...panel, roles: [...panel.roles] })));
        const plan = planChange(panels, out, guildId);
        if (!plan) {
            await conn.query('ROLLBACK');
            return out.result;
        }

        for (const id of plan.remove) {
            await conn.query(`DELETE FROM ${table} WHERE key = ANY($1::text[])`, [[panelKey(guildId, id), legacyKey(guildId, id)]]);
        }
        for (const panel of plan.store) {
            await conn.query(
                `INSERT INTO ${table} (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`,
                [panelKey(guildId, panel.messageId), JSON.stringify(panel)],
            );
            await conn.query(`DELETE FROM ${table} WHERE key = $1`, [legacyKey(guildId, panel.messageId)]);
        }
        await conn.query('COMMIT');
        return out.result;
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        conn.release();
    }
}
