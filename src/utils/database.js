// database.js — facade re-exporting split modules for backward compatibility

import { pgDb } from './postgresDatabase.js';
import { logger } from './logger.js';
import { pgConfig } from '../config/database/postgres.js';
import { assertOnboardingCompatible, assertOnboardingShape } from '../services/config/onboardingConflict.js';
import { createError, ErrorTypes, ZentixBotError } from './errorHandler.js';
import { BotConfig, getDefaultApplicationQuestions } from '../config/bot.js';
import {isSQLiteBirthdayBackend,readSQLiteBirthdays,setSQLiteBirthday,deleteSQLiteBirthday} from '../services/storage/sqliteBirthdays.js';
import {isPostgresBirthdayBackend,readPostgresBirthdays,setPostgresBirthday,deletePostgresBirthday} from '../services/storage/postgresBirthdays.js';

export {
    db,
    initializeDatabase,
    getFromDb,
    setInDb,
    deleteFromDb,
} from './database/wrapper.js';

export {
    getGuildConfigKey,
    getGuildBirthdaysKey,
    getBirthdayLeftBackupKey,
    getBirthdayTrackingKey,
    getTicketKey,
    getTicketCounterKey,
    getInviteTrackingKey,
    getMemberInvitesKey,
    getInviteUsesKey,
    getFakeAccountKey,
    getEconomyKey,
    getEconomyPrefix,
    getAFKKey,
    getWelcomeConfigKey,
    getLevelingKey,
    getUserLevelKey,
    getUserLevelPrefix,
    getApplicationRolesKey,
    getApplicationSettingsKey,
    getUserApplicationsKey,
    getApplicationKey,
    getApplicationsPrefix,
    getJoinToCreateConfigKey,
    getJoinToCreateChannelsKey,
    getWarningsKey,
    getWarningsPrefix,
    getUserNotesKey,
    getUserNotesListKey,
    getReactionRoleKey,
    getReactionRolesPrefix,
    getServerCountersKey,
    getGiveawayEntryKey,
    getGiveawayLockKey,
    canonicalizeKey,
    getLegacyVariantsForCanonical,
} from './database/keys.js';

export {
    getTicketData,
    getOpenTicketCountForUser,
    listOpenTicketsForUser,
    saveTicketData,
    deleteTicketData,
    getTicketCounter,
    incrementTicketCounter,
    getGuildTicketStats,
} from './database/tickets.js';

import { db, getFromDb, setInDb } from './database/wrapper.js';
import {
    getGuildConfigKey,
    getGuildBirthdaysKey,
    getLevelingKey,
    getUserLevelKey,
    getApplicationRolesKey,
    getApplicationSettingsKey,
    getUserApplicationsKey,
    getApplicationKey,
    getJoinToCreateConfigKey,
    getJoinToCreateChannelsKey,
    getWelcomeConfigKey,
    getEconomyKey,
    getAFKKey,
    getUserLevelPrefix,
} from './database/keys.js';

export async function insertVerificationAudit(record) {
    try {
        if (!db.initialized) {
            await db.initialize();
        }

        if (db.db?.sqlite?.dialect === 'sqlite' && (!db.isAvailable() || !db.db.isAvailable())) return false;
        if (db.isAvailable() && typeof db.db?.insertVerificationAudit === 'function') {
            return await db.db.insertVerificationAudit(record);
        }

        const key = `verification:audit:${record.guildId}`;
        const existing = await getFromDb(key, []);
        const auditEntries = Array.isArray(existing) ? existing : [];
        const maxInMemoryAuditEntries = BotConfig?.verification?.maxInMemoryAuditEntries ?? 1000;

        auditEntries.push({
            ...record,
            createdAt: record.createdAt || new Date().toISOString()
        });

        if (auditEntries.length > maxInMemoryAuditEntries) {
            auditEntries.splice(0, auditEntries.length - maxInMemoryAuditEntries);
        }

        return await setInDb(key, auditEntries);
    } catch (error) {
        logger.error('Error storing verification audit:', error);
        return false;
    }
}

export function unwrapReplitData(data) {
    if (
        typeof data === "object" &&
        data !== null &&
        data.ok !== undefined &&
        data.value !== undefined
    ) {
        return unwrapReplitData(data.value);
    }
    return data;
}

// Guild config access: import from services/config/guildConfig.js only.
// Low-level storage lives in ./database/guildConfigStorage.js

export { pgDb };

export const getMessage = (key, replacements = {}) => {
    let message = BotConfig.messages[key] || key;
    for (const [k, v] of Object.entries(replacements)) {
        message = message.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
    return message;
};

export const getColor = (path, fallback = "#000000") => {
    const parts = path.split(".");
    let current = BotConfig.embeds.colors;

    for (const part of parts) {
        if (current[part] === undefined) {
            logger.warn(`Color path '${path}' not found in config, using fallback`);
            return fallback;
        }
        current = current[part];
    }

    return typeof current === "string" ? current : fallback;
};

export async function getGuildBirthdays(client, guildId) {
    const key = getGuildBirthdaysKey(guildId);
    try {
        if (!client.db || typeof client.db.get !== "function") {
            logger.error("Database client is not available for getGuildBirthdays.");
            return {};
        }

        if(isSQLiteBirthdayBackend(client))return readSQLiteBirthdays(client,guildId);
        if(isPostgresBirthdayBackend(client))return await readPostgresBirthdays(client,guildId);
        const rawData = await client.db.get(key, {});
        return unwrapReplitData(rawData) || {};
    } catch (error) {
        logger.error(`Error retrieving birthdays for guild ${guildId}:`, error);
        if(isSQLiteBirthdayBackend(client)||isPostgresBirthdayBackend(client))throw error;
        return {};
    }
}

export async function setBirthday(client, guildId, userId, month, day) {
    try {
        if (!client.db || typeof client.db.set !== "function") {
            logger.error("Database client is not available for setBirthday.");
            return false;
        }

        if(isSQLiteBirthdayBackend(client))return setSQLiteBirthday(client,guildId,userId,month,day);
        if(isPostgresBirthdayBackend(client))return await setPostgresBirthday(client,guildId,userId,month,day);
        const key = getGuildBirthdaysKey(guildId);
        const birthdays = await getGuildBirthdays(client, guildId);
        birthdays[userId] = { month, day };
        await client.db.set(key, birthdays);
        return true;
    } catch (error) {
        logger.error(`Error setting birthday for user ${userId} in guild ${guildId}:`, error);
        return false;
    }
}

export async function deleteBirthday(client, guildId, userId) {
    try {
        if (!client.db || typeof client.db.set !== "function") {
            logger.error("Database client is not available for deleteBirthday.");
            return false;
        }

        if(isSQLiteBirthdayBackend(client))return deleteSQLiteBirthday(client,guildId,userId);
        if(isPostgresBirthdayBackend(client)){await deletePostgresBirthday(client,guildId,userId);return true;}
        const key = getGuildBirthdaysKey(guildId);
        const birthdays = await getGuildBirthdays(client, guildId);
        if (birthdays[userId]) {
            delete birthdays[userId];
            await client.db.set(key, birthdays);
        }
        return true;
    } catch (error) {
        logger.error(`Error deleting birthday for user ${userId} in guild ${guildId}:`, error);
        return false;
    }
}

export function getMonthName(monthNum) {
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const index = Math.max(0, Math.min(monthNum - 1, 11));
    return monthNum >= 1 && monthNum <= 12 ? months[index] : 'Invalid Month';
}

function isPostgresSqlReady(dbWrapper) {
    return Boolean(
        dbWrapper?.db?.pool &&
        typeof dbWrapper.db.isAvailable === 'function' &&
        dbWrapper.db.isAvailable(),
    );
}

async function getEndedGiveawaysFromKv(client) {
    const wrapper = client?.db;
    if (!wrapper || typeof wrapper.list !== 'function' || typeof wrapper.get !== 'function') {
        return [];
    }

    const keys = await wrapper.list('guild:');
    const ended = [];
    const now = Date.now();

    for (const key of keys) {
        if (!key.endsWith(':giveaways')) {
            continue;
        }

        const guildId = key.split(':')[1];
        if (!guildId) {
            continue;
        }

        const rawGiveaways = await wrapper.get(key, {});
        const unwrapped = unwrapReplitData(rawGiveaways) || {};
        const giveaways = Array.isArray(unwrapped) ? unwrapped : Object.values(unwrapped);

        for (const giveaway of giveaways) {
            if (!giveaway?.messageId || giveaway.ended || giveaway.isEnded) {
                continue;
            }

            const endTime = giveaway.endsAt || giveaway.endTime;
            if (!endTime || now < Number(endTime)) {
                continue;
            }

            ended.push({
                id: giveaway.id || giveaway.messageId,
                guild_id: guildId,
                message_id: giveaway.messageId,
                data: giveaway,
                ends_at: new Date(Number(endTime)),
            });
        }
    }

    return ended.sort((a, b) => new Date(a.ends_at) - new Date(b.ends_at));
}

export async function getEndedGiveaways(client) {
    try {
        const wrapper = client?.db;
        if (!wrapper || typeof wrapper.get !== 'function') {
            return [];
        }

        if (wrapper.db?.sqlite?.dialect === 'sqlite') {
            const {readSQLiteGiveaways}=await import('../services/storage/sqliteGiveaways.js');
            const guildId=client.homeGuildId,now=Date.now(),items=readSQLiteGiveaways(client,guildId),due=[];
            for(const data of items){if(data.ended||data.isEnded)continue;const raw=data.endsAt??data.endTime;let time=typeof raw==='number'?raw:(typeof raw==='string'&&raw.trim()?(Number.isFinite(Number(raw))?Number(raw):Date.parse(raw)):NaN);if(!Number.isFinite(time)||Number.isNaN(new Date(time).getTime())||time>now)continue;due.push({id:data.id||data.messageId,guild_id:guildId,message_id:data.messageId,data,ends_at:new Date(time)});}
            return due.sort((a,b)=>a.ends_at-b.ends_at);
        }

        if (isPostgresSqlReady(wrapper)) {
            const { pgConfig } = await import('../config/database/postgres.js');

            const result = await wrapper.db.pool.query(
                `SELECT id, guild_id, message_id, data, ends_at 
                 FROM ${pgConfig.tables.giveaways} 
                 WHERE ends_at <= NOW() 
                 AND COALESCE((data->>'ended')::boolean, false) = false
                 ORDER BY ends_at ASC`,
            );

            return result.rows || [];
        }

        if (wrapper.isDegraded?.()) {
            logger.debug('Postgres SQL unavailable for ended giveaways; scanning key-value store');
        }

        return await getEndedGiveawaysFromKv(client);
    } catch (error) {
        logger.error('Error getting ended giveaways:', error);
        if(client?.db?.db?.sqlite?.dialect==='sqlite')throw error;
        try {
            return await getEndedGiveawaysFromKv(client);
        } catch {
            return [];
        }
    }
}

export async function markGiveawayEnded(client, giveawayId, endedData) {
    try {
        const wrapper = client?.db;
        if (!wrapper || typeof wrapper.get !== 'function') {
            return false;
        }

        if (wrapper.getStatus?.()?.connectionType === 'postgresql') {
            return false; // PostgreSQL must use the claim/ack transaction.
        }

        const guildId = endedData?.guildId;
        if (!guildId || !endedData?.messageId) {
            return false;
        }

        const { saveGiveaway } = await import('./giveaways.js');
        return saveGiveaway(client, guildId, endedData);
    } catch (error) {
        logger.error('Error marking giveaway as ended:', error);
        return false;
    }
}

export function normalizeWelcomeConfig(raw = {}) {
    const base = typeof raw === "object" && raw !== null ? raw : {};

    const channelId = base.channelId ?? null;
    const goodbyeChannelId = base.goodbyeChannelId ?? null;

    const welcomeMessage = base.welcomeMessage ?? "Welcome {user} to {server}!";
    const leaveMessage = base.leaveMessage ?? "{user.tag} has left the server.";

    const welcomeEmbed = base.welcomeEmbed ?? {
        title: "🎉 Welcome!",
        description: "Welcome {user} to {server}!",
        color: getColor("success"),
        thumbnail: true,
        footer: "Welcome to {server}!"
    };

    const leaveEmbed = base.leaveEmbed ?? {
        title: "👋 Goodbye",
        description: "{user.tag} has left the server.",
        color: getColor("error"),
        thumbnail: true,
        footer: "Goodbye from {server}!"
    };

    const roleIds = Array.isArray(base.roleIds) ? base.roleIds : [];

    return {
        ...base,
        enabled: Boolean(base.enabled),
        channelId,
        welcomeMessage,
        welcomeEmbed,
        welcomePing: Boolean(base.welcomePing),
        welcomeImage: base.welcomeImage ?? null,
        goodbyeEnabled: Boolean(base.goodbyeEnabled),
        goodbyeChannelId,
        leaveMessage,
        leaveEmbed,
        dmMessage: base.dmMessage ?? "",
        goodbyePing: Boolean(base.goodbyePing),
        roleIds,
        autoRoleDelay: base.autoRoleDelay ?? 0,
        joinLogs: base.joinLogs ?? { enabled: false, channelId: null },
        leaveLogs: base.leaveLogs ?? { enabled: false, channelId: null }
    };
}

export async function getWelcomeConfig(client, guildId) {
    if (!client.db) {
        logger.warn('Database not available for getWelcomeConfig');
        return normalizeWelcomeConfig();
    }
    
    const key = getWelcomeConfigKey(guildId);
    try {
        const config = await client.db.get(key, {});
        const unwrapped = unwrapReplitData(config);
        return normalizeWelcomeConfig(unwrapped);
    } catch (error) {
        logger.error(`Error getting welcome config for guild ${guildId}:`, error);
        return normalizeWelcomeConfig();
    }
}

// Welcome edits use a distinct, fail-closed read. Event delivery retains its
// legacy best-effort fallback and must not be used as a write snapshot.
const welcomePostgresSnapshots = new WeakMap();
function welcomePool(wrapper) {
    const status = wrapper?.getStatus?.();
    if (status?.connectionType !== 'postgresql') return null;
    if (status.isDegraded || !wrapper.isAvailable?.() || !wrapper.db?.isAvailable?.() ||
        !wrapper.db.pool?.query || !wrapper.db.pool?.connect) throw new Error('PostgreSQL unavailable');
    return wrapper.db.pool;
}
function checkedWelcome(raw) {
    const value = unwrapReplitData(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Stored welcome configuration is invalid');
    }
    return value;
}
function welcomeSnapshot(pool, guildId, value, raw, exists = true) {
    welcomePostgresSnapshots.set(value, {pool, guildId, raw, exists});
    return value;
}
async function readWelcomeForWrite(client, guildId) {
    const wrapper = client?.db;
    if (!wrapper || typeof wrapper.get !== 'function' || (wrapper.isAvailable && !wrapper.isAvailable())) {
        throw new Error('Welcome configuration database unavailable');
    }
    const pool = welcomePool(wrapper);
    if (pool) {
        const result = await pool.query(`SELECT config FROM ${pgConfig.tables.welcome_configs} WHERE guild_id=$1`, [guildId]);
        const exists = result.rows.length > 0;
        const raw = exists ? result.rows[0].config : {};
        const original = JSON.stringify(raw);
        const value = normalizeWelcomeConfig(checkedWelcome(raw));
        return welcomeSnapshot(pool, guildId, value, original, exists);
    }
    let raw = await wrapper.get(getWelcomeConfigKey(guildId), null);
    if (raw === null) raw = {};
    return normalizeWelcomeConfig(checkedWelcome(raw));
}
export async function getWelcomeConfigForEditing(client, guildId) {
    try { return await readWelcomeForWrite(client, guildId); }
    catch (error) {
        logger.error(`Error reading welcome config for editing in guild ${guildId}:`, error);
        throw createError('Failed to read welcome configuration', ErrorTypes.DATABASE,
            'Failed to load welcome settings. The database is unavailable or needs review.', {guildId});
    }
}
async function writePostgresWelcome(pool, guildId, changes, replace) {
    const entry = replace && welcomePostgresSnapshots.get(changes);
    if (replace && (!entry || entry.pool !== pool || entry.guildId !== guildId)) {
        throw createError('Welcome snapshot required', ErrorTypes.CONFIGURATION, 'Reload welcome settings before saving.');
    }
    // Clone before asynchronous I/O so a caller cannot alter the pending write.
    const requestedJSON = JSON.stringify(changes);
    const requested = JSON.parse(requestedJSON);
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        // Same lock order as the web welcome dashboard: guild, then welcome.
        await conn.query(`INSERT INTO ${pgConfig.tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`, [guildId]);
        const guild = await conn.query(`SELECT config FROM ${pgConfig.tables.guilds} WHERE id=$1 FOR UPDATE`, [guildId]);
        const created = await conn.query(`INSERT INTO ${pgConfig.tables.welcome_configs}(guild_id,config) VALUES($1,'{}'::jsonb) ON CONFLICT(guild_id) DO NOTHING RETURNING guild_id`, [guildId]);
        const result = await conn.query(`SELECT config, config = $2::jsonb AS matches FROM ${pgConfig.tables.welcome_configs} WHERE guild_id=$1 FOR UPDATE`, [guildId, entry?.raw ?? '{}']);
        const raw = result.rows[0]?.config;
        const current = checkedWelcome(raw);
        if (raw.ok !== undefined && raw.value !== undefined) {
            throw createError('Legacy welcome config', ErrorTypes.CONFIGURATION, 'Legacy welcome settings need review before editing.');
        }
        if (replace) {
            const unchanged = entry.exists ? created.rowCount === 0 && result.rows[0]?.matches === true : created.rowCount === 1;
            if (!unchanged) throw createError('Stale welcome configuration', ErrorTypes.CONFIGURATION, 'Welcome settings changed. Reload before saving.');
        }
        assertOnboardingShape(guild.rows[0]?.config, raw);
        const merged = {...normalizeWelcomeConfig(current), ...requested};
        assertOnboardingCompatible(guild.rows[0]?.config, merged);
        const serialized = JSON.stringify(merged);
        await conn.query(`UPDATE ${pgConfig.tables.welcome_configs} SET config=$2::jsonb, updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1`, [guildId, serialized]);
        await conn.query('COMMIT');
        const saved = JSON.parse(serialized);
        if (replace) {
            // A second collector may have mutated the same object while this
            // transaction was in flight. Force a fresh read instead of marking
            // those unsaved changes as a new authoritative snapshot.
            let unchangedObject = false;
            try { unchangedObject = JSON.stringify(changes) === requestedJSON; } catch {}
            if (unchangedObject) welcomeSnapshot(pool, guildId, changes, serialized);
            else welcomePostgresSnapshots.delete(changes);
        }
        return welcomeSnapshot(pool, guildId, saved, serialized);
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { conn.release(); }
}
async function writeWelcomeChanges(client, guildId, changes, replace = false) {
    try {
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || typeof client?.db?.set !== 'function') throw new Error('Invalid welcome write');
        const pool = welcomePool(client.db);
        if (pool) return await writePostgresWelcome(pool, guildId, changes, replace);
        const existing = await readWelcomeForWrite(client, guildId);
        const merged = { ...existing, ...changes };
        const success = await client.db.set(getWelcomeConfigKey(guildId), merged);
        if (success !== true) throw new Error('Database rejected welcome write');
        return merged;
    } catch (error) {
        logger.error(`Error saving welcome config for guild ${guildId}:`, error);
        if (error instanceof ZentixBotError) throw error;
        throw createError('Failed to save welcome configuration', ErrorTypes.DATABASE,
            'Failed to save welcome settings. The database is unavailable or needs review.', {guildId});
    }
}
export async function saveWelcomeConfig(client, guildId, config) {
    await writeWelcomeChanges(client, guildId, config, true);
    return true;
}
export async function updateWelcomeConfig(client, guildId, updates) {
    return writeWelcomeChanges(client, guildId, updates);
}

export async function getLevelingConfig(client, guildId) {
    const key = getLevelingKey(guildId);
    try {
        const config = await getFromDb(key, {
            enabled: false,
            xpPerMessage: 10,
            xpPerMinute: 60,
            cooldownEnabled: true,
            messageLengthMultiplier: true,
            levelUpMessages: true,
            levelUpChannel: null,
            roles: {},
            milestones: {}
        });
        
        return config;
    } catch (error) {
        logger.error('Error getting leveling config:', error);
        return {
            enabled: false,
            xpPerMessage: 10,
            xpPerMinute: 60,
            cooldownEnabled: true,
            messageLengthMultiplier: true,
            levelUpMessages: true,
            levelUpChannel: null,
            roles: {},
            milestones: {}
        };
    }
}

export async function saveLevelingConfig(client, guildId, config) {
    const key = getLevelingKey(guildId);
    try {
        await setInDb(key, config);
        return true;
    } catch (error) {
        logger.error(`Error saving leveling config for guild ${guildId}:`, error);
        return false;
    }
}

export async function getUserLevelData(client, guildId, userId) {
    const key = getUserLevelKey(guildId, userId);
    try {
        const data = await getFromDb(key, null);
        if (!data) {
            return {
                xp: 0,
                level: 0,
                totalXp: 0,
                lastMessage: 0,
                rank: 0,
                xpToNextLevel: getXpForLevel(1)
            };
        }
        
        const levelData = {
            xp: data.xp || 0,
            level: data.level || 0,
            totalXp: data.totalXp || 0,
            lastMessage: data.lastMessage || 0,
            rank: data.rank || 0,
            xpToNextLevel: getXpForLevel((data.level || 0) + 1)
        };
        
        return levelData;
    } catch (error) {
        logger.error(`Error getting level data for user ${userId} in guild ${guildId}:`, error);
        return {
            xp: 0,
            level: 0,
            totalXp: 0,
            lastMessage: 0,
            rank: 0,
            xpToNextLevel: getXpForLevel(1)
        };
    }
}

export async function saveUserLevelData(client, guildId, userId, data) {
    const key = getUserLevelKey(guildId, userId);
    try {
        const levelData = {
            ...data,
            xp: data.xp || 0,
            level: data.level || 0,
            totalXp: data.totalXp || 0,
            lastMessage: data.lastMessage || 0,
            rank: data.rank || 0,
            updatedAt: Date.now()
        };
        
        await setInDb(key, levelData);
        return true;
    } catch (error) {
        logger.error(`Error saving level data for user ${userId} in guild ${guildId}:`, error);
        return false;
    }
}

export function getXpForLevel(level) {
    return 5 * Math.pow(level, 2) + 50 * level + 50;
}

export async function getLeaderboard(client, guildId, limit = 10) {
    try {
        if (!client.db || typeof client.db.list !== "function") {
            logger.error("Database client is not available for getLeaderboard.");
            return [];
        }

        const prefix = getUserLevelPrefix(guildId);
        let keys = await client.db.list(prefix);
        
        if (!Array.isArray(keys)) {
            if (typeof keys === 'object' && keys !== null) {
                keys = Object.keys(keys).filter(key => key.startsWith(prefix));
            } else {
                return [];
            }
        }
        
        if (keys.length === 0) {
            return [];
        }
        
        const userDataPromises = keys.map(async (key) => {
            try {
                const userId = key.replace(prefix, '');
                const data = await client.db.get(key);
                if (!data) return null;
                
                const unwrapped = unwrapReplitData(data);
                return {
                    userId,
                    xp: unwrapped.xp || 0,
                    level: unwrapped.level || 0,
                    totalXp: unwrapped.totalXp || 0,
rank: 0
                };
            } catch (error) {
                logger.error(`Error processing leaderboard key ${key}:`, error);
                return null;
            }
        });
        
        let userData = (await Promise.all(userDataPromises)).filter(Boolean);
        
        userData.sort((a, b) => (b.totalXp || 0) - (a.totalXp || 0));
        
        userData = userData.map((user, index) => ({
            ...user,
            rank: index + 1
        }));
        
        return userData.slice(0, limit);
    } catch (error) {
        logger.error(`Error getting leaderboard for guild ${guildId}:`, error);
        return [];
    }
}

// These operations touch multiple application keys and may trigger cleanup or
// Discord side effects. Keep the entire SQLite feature closed until its indexed
// writes, legacy data, and recovery paths have been reconciled.
function requireApplicationBackend(client) {
    if (client?.db?.db?.sqlite?.dialect === 'sqlite') {
        throw Object.assign(new Error('Applications are unavailable during SQLite migration.'), { code: 'APPLICATION_SQLITE_INCOMPLETE' });
    }
}

export async function getApplicationRoles(client, guildId) {
    requireApplicationBackend(client);
    try {
        if (!client.db || typeof client.db.get !== "function") {
            logger.error("Database client is not available for getApplicationRoles.");
            return [];
        }

        const key = getApplicationRolesKey(guildId);
        const roles = await client.db.get(key, []);
        const unwrappedRoles = unwrapReplitData(roles);
        return Array.isArray(unwrappedRoles) ? unwrappedRoles : [];
    } catch (error) {
        logger.error(`Error getting application roles for guild ${guildId}:`, error);
        return [];
    }
}

export async function saveApplicationRoles(client, guildId, roles) {
    requireApplicationBackend(client);
    try {
        if (!client.db || typeof client.db.set !== "function") {
            logger.error("Database client is not available for saveApplicationRoles.");
            return false;
        }

        const key = getApplicationRolesKey(guildId);
        await client.db.set(key, roles);
        return true;
    } catch (error) {
        logger.error(`Error saving application roles for guild ${guildId}:`, error);
        return false;
    }
}

function buildApplicationSettingsDefaults() {
    return {
        enabled: false,
        applicationChannelId: null,
        logChannelId: null,
        questions: getDefaultApplicationQuestions(),
        roles: {
            admin: null,
            reviewer: null,
            accepted: null,
            denied: null
        },
        requiredRoles: [],
        deniedRoles: [],
        minAccountAge: 0,
        maxApplications: 1,
        cooldown: BotConfig.applications?.applicationCooldown ?? 7,
        allowMultipleApplications: false,
        requireVerification: false,
        customWelcomeMessage: "",
        pendingApplicationRetentionDays: 30,
        reviewedApplicationRetentionDays: BotConfig.applications?.deleteApprovedAfter ?? 14,
    };
}

export async function getApplicationSettings(client, guildId) {
    requireApplicationBackend(client);
    if (!client.db) {
        logger.warn('Database not available for getApplicationSettings');
        return buildApplicationSettingsDefaults();
    }
    
    const key = getApplicationSettingsKey(guildId);
    try {
        const settings = await client.db.get(key, {});
        const unwrapped = unwrapReplitData(settings);
        
        const defaultSettings = buildApplicationSettingsDefaults();
        
        return { ...defaultSettings, ...unwrapped };
    } catch (error) {
        logger.error(`Error getting application settings for guild ${guildId}:`, error);
        return buildApplicationSettingsDefaults();
    }
}

function getApplicationRetentionDays(settings = {}) {
    const pendingRaw = Number(settings.pendingApplicationRetentionDays);
    const reviewedRaw = Number(settings.reviewedApplicationRetentionDays);

    const pendingDays = Number.isFinite(pendingRaw) ? Math.min(Math.max(pendingRaw, 1), 3650) : 30;
    const reviewedDays = Number.isFinite(reviewedRaw) ? Math.min(Math.max(reviewedRaw, 1), 3650) : 14;

    return { pendingDays, reviewedDays };
}

function isApplicationExpired(application, retentionDays, now = Date.now()) {
    if (!application || typeof application !== 'object') {
        return false;
    }

    const createdAt = Number(application.createdAt) || now;
    const updatedAt = Number(application.updatedAt) || createdAt;
    const reviewedAt = application.reviewedAt ? Number(new Date(application.reviewedAt)) : null;
    const status = typeof application.status === 'string' ? application.status.toLowerCase() : 'pending';

    const ageMsFromCreated = now - createdAt;
    const ageMsFromReviewed = now - (reviewedAt || updatedAt || createdAt);
    const pendingRetentionMs = retentionDays.pendingDays * 24 * 60 * 60 * 1000;
    const reviewedRetentionMs = retentionDays.reviewedDays * 24 * 60 * 60 * 1000;

    if (status === 'pending') {
        return ageMsFromCreated > pendingRetentionMs;
    }

    if (status === 'approved' || status === 'denied') {
        return ageMsFromReviewed > reviewedRetentionMs;
    }

    return ageMsFromCreated > pendingRetentionMs;
}

export async function deleteApplication(client, guildId, applicationId, userIdHint = null) {
    requireApplicationBackend(client);
    const key = getApplicationKey(guildId, applicationId);

    try {
        const existing = unwrapReplitData(await client.db.get(key, null));
        const userId = userIdHint || existing?.userId || null;

        await client.db.delete(key);

        if (userId) {
            const userKey = getUserApplicationsKey(guildId, userId);
            const userApplications = await client.db.get(userKey, []);
            const unwrapped = unwrapReplitData(userApplications);
            const ids = Array.isArray(unwrapped) ? unwrapped : [];
            const filtered = ids.filter(id => id !== applicationId);
            await client.db.set(userKey, filtered);
        }

        return true;
    } catch (error) {
        logger.error(`Error deleting application ${applicationId} in guild ${guildId}:`, error);
        return false;
    }
}

export async function cleanupExpiredApplications(client, guildId) {
    requireApplicationBackend(client);
    try {
        if (!client.db || typeof client.db.list !== 'function') {
            return { removed: 0, scanned: 0 };
        }

        const settings = await getApplicationSettings(client, guildId);
        const retentionDays = getApplicationRetentionDays(settings);
        const prefix = `guild:${guildId}:applications:`;
        let keys = await client.db.list(prefix);

        if (!Array.isArray(keys)) {
            if (typeof keys === 'object' && keys !== null) {
                keys = Object.keys(keys).filter(key => key.startsWith(prefix));
            } else {
                return { removed: 0, scanned: 0 };
            }
        }

        const applicationKeyPattern = new RegExp(`^guild:${guildId}:applications:[^:]+$`);
        const applicationKeys = keys.filter(key => applicationKeyPattern.test(key));

        const now = Date.now();
        let removed = 0;

        for (const key of applicationKeys) {
            const app = unwrapReplitData(await client.db.get(key, null));
            if (!app) {
                continue;
            }

            if (isApplicationExpired(app, retentionDays, now)) {
                const deleted = await deleteApplication(client, guildId, app.id, app.userId);
                if (deleted) {
                    removed += 1;
                }
            }
        }

        return { removed, scanned: applicationKeys.length };
    } catch (error) {
        logger.error(`Error cleaning expired applications for guild ${guildId}:`, error);
        return { removed: 0, scanned: 0 };
    }
}

export async function saveApplicationSettings(client, guildId, settings) {
    requireApplicationBackend(client);
    const key = getApplicationSettingsKey(guildId);
    try {
        const existingSettings = await getApplicationSettings(client, guildId);
        const mergedSettings = { ...existingSettings, ...settings };
        
        await client.db.set(key, mergedSettings);
        return true;
    } catch (error) {
        logger.error(`Error saving application settings for guild ${guildId}:`, error);
        return false;
    }
}

function getApplicationRoleSettingsKey(guildId, roleId) {
    return `guild:${guildId}:applications:role:${roleId}:settings`;
}

export async function getApplicationRoleSettings(client, guildId, roleId) {
    requireApplicationBackend(client);
    try {
        if (!client.db || typeof client.db.get !== "function") {
            return { questions: null, logChannelId: null };
        }

        const key = getApplicationRoleSettingsKey(guildId, roleId);
        const settings = await client.db.get(key, {});
        return unwrapReplitData(settings) || { questions: null, logChannelId: null };
    } catch (error) {
        logger.error(`Error getting application role settings for ${guildId}:${roleId}:`, error);
        return { questions: null, logChannelId: null };
    }
}

export async function saveApplicationRoleSettings(client, guildId, roleId, settings) {
    requireApplicationBackend(client);
    try {
        if (!client.db || typeof client.db.set !== "function") {
            logger.error("Database client is not available for saveApplicationRoleSettings.");
            return false;
        }

        const key = getApplicationRoleSettingsKey(guildId, roleId);
        await client.db.set(key, settings);
        return true;
    } catch (error) {
        logger.error(`Error saving application role settings for ${guildId}:${roleId}:`, error);
        return false;
    }
}

export async function deleteApplicationRoleSettings(client, guildId, roleId) {
    requireApplicationBackend(client);
    try {
        if (!client.db || typeof client.db.delete !== "function") {
            logger.error("Database client is not available for deleteApplicationRoleSettings.");
            return false;
        }

        const key = getApplicationRoleSettingsKey(guildId, roleId);
        await client.db.delete(key);
        return true;
    } catch (error) {
        logger.error(`Error deleting application role settings for ${guildId}:${roleId}:`, error);
        return false;
    }
}

export async function createApplication(client, application) {
    requireApplicationBackend(client);
    const { guildId, userId } = application;
    const applicationId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key = getApplicationKey(guildId, applicationId);
    
    const newApplication = {
        ...application,
        id: applicationId,
status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reviewedBy: null,
        reviewedAt: null,
        notes: []
    };
    
    try {
        if (!client.db || typeof client.db.set !== "function") {
            logger.error("Database client is not available for createApplication.");
            throw new Error("Database not available");
        }

        await client.db.set(key, newApplication);
        
        const userKey = getUserApplicationsKey(guildId, userId);
        const userApplications = await client.db.get(userKey, []);
        const unwrappedApplications = unwrapReplitData(userApplications);
        
        const applicationsArray = Array.isArray(unwrappedApplications) ? unwrappedApplications : [];
        applicationsArray.push(applicationId);
        
        await client.db.set(userKey, applicationsArray);
        if (process.env.NODE_ENV !== 'production') {
            logger.debug(`Successfully created application ${applicationId} for user ${userId}`);
        }
        
        return newApplication;
    } catch (error) {
        logger.error(`Error creating application for user ${userId} in guild ${guildId}:`, error);
        throw error;
    }
}

export async function getApplication(client, guildId, applicationId) {
    requireApplicationBackend(client);
    const key = getApplicationKey(guildId, applicationId);
    try {
        await cleanupExpiredApplications(client, guildId);
        const application = await client.db.get(key, null);
        return unwrapReplitData(application);
    } catch (error) {
        logger.error(`Error getting application ${applicationId} in guild ${guildId}:`, error);
        return null;
    }
}

export async function updateApplication(client, guildId, applicationId, updates) {
    requireApplicationBackend(client);
    const key = getApplicationKey(guildId, applicationId);
    try {
        const existingApplication = await getApplication(client, guildId, applicationId);
        if (!existingApplication) {
            throw new Error(`Application ${applicationId} not found`);
        }
        
        const updatedApplication = {
            ...existingApplication,
            ...updates,
            updatedAt: Date.now()
        };
        
        await client.db.set(key, updatedApplication);
        return updatedApplication;
    } catch (error) {
        logger.error(`Error updating application ${applicationId} in guild ${guildId}:`, error);
        throw error;
    }
}

export async function getUserApplications(client, guildId, userId) {
    requireApplicationBackend(client);
    const userKey = getUserApplicationsKey(guildId, userId);
    try {
        if (!client.db || typeof client.db.get !== "function") {
            logger.error("Database client is not available for getUserApplications.");
            return [];
        }

        await cleanupExpiredApplications(client, guildId);

        const applicationIds = await client.db.get(userKey, []);
        const unwrappedIds = unwrapReplitData(applicationIds);
        
        const idsArray = Array.isArray(unwrappedIds) ? unwrappedIds : [];
        
        const applicationPromises = idsArray.map(id => 
            getApplication(client, guildId, id)
        );
        
        const applications = await Promise.all(applicationPromises);
        return applications.filter(Boolean);
    } catch (error) {
        logger.error(`Error getting applications for user ${userId} in guild ${guildId}:`, error);
        return [];
    }
}

export async function getApplications(client, guildId, filters = {}) {
    requireApplicationBackend(client);
    const {
        status,
        userId,
        limit = 50,
        offset = 0
    } = filters;
    
    try {
        if (!client.db || typeof client.db.list !== "function") {
            logger.error("Database client is not available for getApplications.");
            return [];
        }

        await cleanupExpiredApplications(client, guildId);

        const prefix = `guild:${guildId}:applications:`;
        let keys = await client.db.list(prefix);
        
        if (!Array.isArray(keys)) {
            if (typeof keys === 'object' && keys !== null) {
                const keyArray = Object.keys(keys).filter(key => key.startsWith(prefix));
                keys = keyArray;
            } else {
                return [];
            }
        }
        
        const applicationKeyPattern = new RegExp(`^guild:${guildId}:applications:[^:]+$`);
        const applicationKeys = keys.filter(key => applicationKeyPattern.test(key));
        
        const applicationPromises = applicationKeys.map(key => client.db.get(key));
        let applications = (await Promise.all(applicationPromises))
            .map(unwrapReplitData)
            .filter(Boolean);
        
        if (status) {
            applications = applications.filter(app => app.status === status);
        }
        
        if (userId) {
            applications = applications.filter(app => app.userId === userId);
        }
        
        applications.sort((a, b) => b.createdAt - a.createdAt);
        
        return applications.slice(offset, offset + limit);
    } catch (error) {
        logger.error(`Error getting applications for guild ${guildId}:`, error);
        return [];
    }
}

function generateCaseId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 4)}`;
}