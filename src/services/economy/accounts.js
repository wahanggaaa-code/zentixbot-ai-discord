// accounts.js — read-only access to economy accounts.
//
// On PostgreSQL the generic key-value layer answers a failed query with "no
// data", which turns into an empty account on screen. These readers ask the
// economy table directly and let a failed query fail.

import { pgConfig } from '../../config/database/postgres.js';
import { botConfig } from '../../config/bot.js';
import { DEFAULT_ECONOMY_DATA } from '../../utils/constants.js';
import { normalizeEconomyData } from '../../utils/schemas.js';
import { logger } from '../../utils/logger.js';
import { decodeEconomyRow } from './transaction.js';

const tables = pgConfig.tables;

/** The pg pool of a healthy PostgreSQL backend, or null for any other backend. */
export function economyPool(client) {
    const db = client?.db;
    const pool = db?.db?.pool;
    if (!pool || typeof pool.query !== 'function') return null;
    if (db.getStatus?.().isDegraded || db.isAvailable?.() === false) return null;
    return pool;
}

function newAccount() {
    return normalizeEconomyData({}, {
        ...DEFAULT_ECONOMY_DATA,
        wallet: botConfig.economy?.startingBalance ?? DEFAULT_ECONOMY_DATA.wallet,
    });
}

/**
 * One account as stored. A member without a row gets the values of a new
 * account; nothing is written. Throws when the query fails or the stored
 * balance is not a valid amount.
 */
export async function readEconomyAccount(pool, guildId, userId) {
    const result = await pool.query(
        `SELECT balance, bank, data FROM ${tables.economy} WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId],
    );
    if (result.rows.length === 0) return newAccount();
    return decodeEconomyRow(result.rows[0]);
}

/**
 * Wallet and bank of every account of a guild, in one query.
 * Rows whose balance cannot be read are left out and counted in `rejected`.
 */
export async function listEconomyBalances(pool, guildId) {
    const result = await pool.query(
        `SELECT user_id, balance, bank, data FROM ${tables.economy} WHERE guild_id = $1 ORDER BY user_id`,
        [guildId],
    );
    const accounts = [];
    let rejected = 0;
    for (const row of result.rows) {
        try {
            const data = decodeEconomyRow(row);
            accounts.push({ userId: row.user_id, wallet: data.wallet, bank: data.bank });
        } catch {
            rejected += 1;
        }
    }
    if (rejected > 0) logger.warn(`[ECONOMY] ${rejected} accounts with an invalid balance were left out`, { guildId });
    return { accounts, rejected };
}
