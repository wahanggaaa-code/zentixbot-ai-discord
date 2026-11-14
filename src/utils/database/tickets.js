import { logger } from '../logger.js';
import { pgConfig } from '../../config/database/postgres.js';
import { db, getFromDb } from './wrapper.js';
import { getTicketCounterKey, getTicketKey } from './keys.js';
import {isSQLiteTicketBackend,readSQLiteTicket,saveSQLiteTicket,listSQLiteTicketKeys} from '../../services/storage/sqliteTickets.js';

export { getTicketKey, getTicketCounterKey } from './keys.js';

// A PostgreSQL ticket is saved back only if the stored record is still the one
// that was read. Without this, two actions on the same ticket (for example a
// claim and a close) would each write a full record and one change would be lost.
const postgresSnapshots = new WeakMap();
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function trackPostgresTicket(value, pool, guildId, channelId) {
    if (isRecord(value)) postgresSnapshots.set(value, { pool, guildId, channelId, raw: JSON.stringify(value) });
    return value;
}
const staleTicket = (message) => Object.assign(new Error(message), { code: 'TICKET_STALE' });

async function savePostgresTicket(guildId, channelId, data) {
    const pool = requireTicketPool();
    if (!isRecord(data)) throw Object.assign(new Error('Invalid ticket data'), { code: 'TICKET_INVALID' });
    const serialized = JSON.stringify(data);
    const snapshot = postgresSnapshots.get(data);
    const tracked = snapshot && snapshot.pool === pool && snapshot.guildId === guildId && snapshot.channelId === channelId;
    let result;
    if (tracked) {
        result = await pool.query(
            `UPDATE ${pgConfig.tables.tickets}
             SET data = $3::jsonb, expires_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE guild_id = $1 AND channel_id = $2 AND data = $4::jsonb`,
            [guildId, channelId, serialized, snapshot.raw],
        );
        if (result.rowCount !== 1) throw staleTicket('Ticket changed; reload before saving');
    } else {
        // A record that was not read from the database may only create a new ticket.
        await pool.query(
            `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
            [guildId],
        );
        result = await pool.query(
            `INSERT INTO ${pgConfig.tables.tickets} (guild_id, channel_id, data) VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (channel_id) DO NOTHING`,
            [guildId, channelId, serialized],
        );
        if (result.rowCount !== 1) throw staleTicket('Ticket already exists; reload before saving');
    }
    trackPostgresTicket(data, pool, guildId, channelId);
}

function requireTicketPool() {
    if (db.useFallback || !db.db?.isAvailable?.() || !db.db.pool) throw Object.assign(new Error('Persistent ticket database unavailable'), {code: 'TICKET_DB_UNAVAILABLE'});
    return db.db.pool;
}

export async function getTicketData(guildId, channelId) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (isSQLiteTicketBackend(db)) return readSQLiteTicket(db,guildId,channelId);
    const pool = requireTicketPool();
    const result = await pool.query(`SELECT data FROM ${pgConfig.tables.tickets} WHERE guild_id = $1 AND channel_id = $2`, [guildId, channelId]);
    return result.rows.length ? trackPostgresTicket(result.rows[0].data, pool, guildId, channelId) : null;
}

/**
 * The user's open tickets, as tracked records that can be saved back.
 */
export async function listOpenTicketsForUser(guildId, userId, limit = 25) {
    if (!db.initialized) {
        await db.initialize();
    }
    if (isSQLiteTicketBackend(db)) {
        const prefix = `guild:${guildId}:ticket:`;
        const open = [];
        for (const key of listSQLiteTicketKeys(db, guildId).sort()) {
            const channelId = key.slice(prefix.length);
            if (!/^\d{17,20}$/.test(channelId)) continue;
            const data = readSQLiteTicket(db, guildId, channelId);
            if (data && data.userId === userId && data.status === 'open') open.push({ channelId, data });
            if (open.length >= limit) break;
        }
        return open;
    }
    const pool = requireTicketPool();
    const result = await pool.query(
        `SELECT channel_id, data FROM ${pgConfig.tables.tickets}
         WHERE guild_id = $1
           AND data->>'userId' = $2
           AND data->>'status' = 'open'
         ORDER BY channel_id
         LIMIT $3`,
        [guildId, userId, limit],
    );
    return result.rows.map((row) => ({
        channelId: row.channel_id,
        data: trackPostgresTicket(row.data, pool, guildId, row.channel_id),
    }));
}

export async function getOpenTicketCountForUser(guildId, userId) {
    try {
        if (!db.initialized) {
            await db.initialize();
        }

        if (!isSQLiteTicketBackend(db)) {
            const result = await requireTicketPool().query(
                `SELECT COUNT(*)::int AS count FROM ${pgConfig.tables.tickets}
                 WHERE guild_id = $1
                   AND data->>'userId' = $2
                   AND data->>'status' = 'open'`,
                [guildId, userId],
            );

            return Number(result.rows?.[0]?.count || 0);
        }

        if (typeof db.list === 'function') {
            const ticketKeys = isSQLiteTicketBackend(db) ? listSQLiteTicketKeys(db,guildId) : await db.list(`guild:${guildId}:ticket:`);
            let count = 0;

            for (const key of ticketKeys) {
                if (key.endsWith(':counter')) continue;
                const ticket = isSQLiteTicketBackend(db) ? await getTicketData(guildId,key.slice(`guild:${guildId}:ticket:`.length)) : await getFromDb(key, null);
                if (ticket && ticket.userId === userId && ticket.status === 'open') {
                    count += 1;
                }
            }

            return count;
        }

        return 0;
    } catch (error) {
        logger.error(`Error counting open tickets for user ${userId} in guild ${guildId}:`, error);
        throw error;
    }
}

export async function saveTicketData(guildId, channelId, data) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (isSQLiteTicketBackend(db)) {saveSQLiteTicket(db,guildId,channelId,data);return;}
    await savePostgresTicket(guildId, channelId, data);
}

function backendSQLiteDelete(guildId, channelId) {
    // Checked like a read first, so a record that needs review is not removed unseen.
    if (readSQLiteTicket(db, guildId, channelId) === null) return false;
    return db.db.sqlite.transaction((tx) => tx.botDelete(getTicketKey(guildId, channelId)));
}

export async function deleteTicketData(guildId, channelId) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (isSQLiteTicketBackend(db)) {
        const removed = backendSQLiteDelete(guildId, channelId);
        if (!removed) throw Object.assign(new Error('Ticket data could not be deleted'), {code:'TICKET_DELETE_FAILED'});
        return;
    }
    const key = getTicketKey(guildId, channelId);
    if (!await db.delete(key)) throw Object.assign(new Error('Ticket data could not be deleted'), {code:'TICKET_DELETE_FAILED'});
}

export async function getTicketCounter(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (db.db?.sqlite?.dialect === 'sqlite') {
        const counter = await db.get(getTicketCounterKey(guildId));
        return counter ?? 0;
    }
    const result = await requireTicketPool().query(`SELECT value, expires_at FROM ${pgConfig.tables.temp_data} WHERE key=$1`, [getTicketCounterKey(guildId)]);
    if (!result.rows.length) return 0;
    const {value, expires_at: expiresAt} = result.rows[0];
    if (expiresAt !== null || !Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error('Invalid ticket counter'), {code:'TICKET_COUNTER_INVALID'});
    return value;
}

export async function incrementTicketCounter(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    const key = getTicketCounterKey(guildId);
    if (db.db?.sqlite?.dialect === 'sqlite') {
        const nextCounter = await db.increment(key, 1);
        return nextCounter.toString().padStart(3, '0');
    }
    const conn = await requireTicketPool().connect();
    try {
        await conn.query('BEGIN');
        await conn.query(`INSERT INTO ${pgConfig.tables.temp_data} (key,value) VALUES ($1,'0'::jsonb) ON CONFLICT (key) DO NOTHING`, [key]);
        const result = await conn.query(`SELECT value, expires_at FROM ${pgConfig.tables.temp_data} WHERE key=$1 FOR UPDATE`, [key]);
        const {value, expires_at: expiresAt} = result.rows[0];
        if (expiresAt !== null || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw Object.assign(new Error('Invalid ticket counter'), {code:'TICKET_COUNTER_INVALID'});
        const nextCounter = value + 1;
        await conn.query(`UPDATE ${pgConfig.tables.temp_data} SET value=$2::jsonb WHERE key=$1`, [key, JSON.stringify(nextCounter)]);
        await conn.query('COMMIT');
        return nextCounter.toString().padStart(3, '0');
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        conn.release();
    }
}

async function listGuildTickets(guildId) {
    if (!db.initialized) {
        await db.initialize();
    }

    if (!isSQLiteTicketBackend(db)) {
        const result = await requireTicketPool().query(
            `SELECT data FROM ${pgConfig.tables.tickets} WHERE guild_id = $1`,
            [guildId],
        );
        return result.rows.map((row) => row.data).filter(Boolean);
    }

    if (typeof db.list !== 'function') {
        return [];
    }

    const ticketKeys = isSQLiteTicketBackend(db) ? listSQLiteTicketKeys(db,guildId) : await db.list(`guild:${guildId}:ticket:`);
    const tickets = [];

    for (const key of ticketKeys) {
        if (key.endsWith(':counter')) continue;
        const ticket = isSQLiteTicketBackend(db) ? await getTicketData(guildId,key.slice(`guild:${guildId}:ticket:`.length)) : await getFromDb(key, null);
        if (ticket) tickets.push(ticket);
    }

    return tickets;
}

export async function getGuildTicketStats(guildId) {
    try {
        const tickets = await listGuildTickets(guildId);
        let openCount = 0;
        let closedCount = 0;
        let totalCloseMs = 0;
        let closeSamples = 0;
        let feedbackCount = 0;
        let ratingSum = 0;

        for (const ticket of tickets) {
            if (ticket.status === 'open') {
                openCount += 1;
            } else if (ticket.status === 'closed') {
                closedCount += 1;
                if (ticket.createdAt && ticket.closedAt) {
                    const duration = new Date(ticket.closedAt) - new Date(ticket.createdAt);
                    if (Number.isFinite(duration) && duration >= 0) {
                        totalCloseMs += duration;
                        closeSamples += 1;
                    }
                }
            }

            const rating = ticket.feedback?.rating;
            if (rating != null && Number.isFinite(Number(rating))) {
                feedbackCount += 1;
                ratingSum += Number(rating);
            }
        }

        return {
            openCount,
            closedCount,
            avgCloseTimeMs: closeSamples > 0 ? Math.round(totalCloseMs / closeSamples) : null,
            feedbackCount,
            avgRating: feedbackCount > 0 ? Math.round((ratingSum / feedbackCount) * 10) / 10 : null,
        };
    } catch (error) {
        logger.error(`Error computing ticket stats for guild ${guildId}:`, error);
        throw error;
    }
}
