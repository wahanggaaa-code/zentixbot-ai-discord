// levelRoleSyncService.js — gives missing reward roles to members who already
// reached the level. Used at startup and by the manual sync in the dashboard.
//
// The sync only adds roles. It never removes a role and never changes the
// reward configuration, also not when a role is gone or Discord is unreachable.

import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from './leveling.js';
import { getUserLevelPrefix } from '../../utils/database/keys.js';
import { pgConfig } from '../../config/database/postgres.js';
import { checkRewardRole, resolveRewardRole, syncMemberRewardRoles } from './rewardRoles.js';

const USER_ID = /^\d{17,20}$/;

function postgresPool(client) {
    const db = client?.db;
    if (db?.getStatus?.()?.connectionType !== 'postgresql') return null;
    const pool = db.db?.pool;
    return typeof pool?.query === 'function' ? pool : null;
}

async function listLevelUserIds(client, guildId, minLevel) {
    // PostgreSQL: ask for eligible members only, and let a failed query fail
    // the sync instead of looking like an empty server.
    const pool = postgresPool(client);
    if (pool) {
        const result = await pool.query(
            `SELECT user_id FROM ${pgConfig.tables.user_levels} WHERE guild_id = $1 AND level >= $2 ORDER BY user_id`,
            [guildId, minLevel],
        );
        return result.rows.map(row => row.user_id).filter(id => USER_ID.test(id));
    }

    if (!client.db?.list) throw new Error('Level database listing unavailable');
    const prefixes = [getUserLevelPrefix(guildId), `${guildId}:leveling:users:`];
    const userIds = new Set();
    for (const prefix of prefixes) {
        const keys = await client.db.list(prefix);
        if (!Array.isArray(keys)) throw new Error('Invalid level database listing');
        for (const key of keys) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
            const userId = key.slice(prefix.length);
            if (USER_ID.test(userId)) userIds.add(userId);
        }
    }
    return [...userIds];
}

/**
 * Check every configured reward once. Returns the entries that can be given.
 * Problems are counted in `summary`; the configuration is left as it is.
 */
async function findUsableRewards(guild, config, summary) {
    const usable = [];
    for (const [levelStr, roleId] of Object.entries(config.roleRewards || {})) {
        const level = Number(levelStr);
        if (!Number.isInteger(level) || level < 0 || level > 1000 || typeof roleId !== 'string' || !roleId) {
            summary.errors += 1;
            logger.warn(`Invalid level reward configuration in guild ${guild.id}`);
            continue;
        }

        const found = await resolveRewardRole(guild, roleId);
        if (found.error) {
            summary.errors += 1;
            logger.warn(`Unable to check level reward role ${roleId} in guild ${guild.id}:`, found.error?.message);
            continue;
        }
        if (found.missing) {
            summary.missingRewardEntries += 1;
            logger.warn(`Missing level ${level} reward role ${roleId} in guild ${guild.id}; configuration preserved.`);
            continue;
        }

        const verdict = checkRewardRole(guild, found.role);
        if (!verdict.ok) {
            summary.unusableRewardEntries += 1;
            logger.warn(`Level ${level} reward role ${roleId} in guild ${guild.id} cannot be given (${verdict.code}); configuration preserved.`);
            continue;
        }

        usable.push({ level, levelStr, roleId });
    }
    return usable;
}

export async function reconcileLevelRoles(client, guildId = null, options = {}) {
    const summary = {
        scannedGuilds: 0,
        prunedRewardEntries: 0,
        missingRewardEntries: 0,
        unusableRewardEntries: 0,
        membersChecked: 0,
        rolesReAwarded: 0,
        errors: 0,
    };
    const source = options.source || 'startup sync';
    const guilds = guildId ? [client.guilds.cache.get(guildId)].filter(Boolean) : [...client.guilds.cache.values()];

    for (const guild of guilds) {
        summary.scannedGuilds += 1;
        try {
            const cfg = await getLevelingConfig(client, guild.id);
            if (cfg.enabled === false) continue;
            if (!Object.keys(cfg.roleRewards || {}).length) continue;

            const usable = await findUsableRewards(guild, cfg, summary);
            if (!usable.length) continue;

            const lowestLevel = Math.min(...usable.map(entry => entry.level));
            const userIds = await listLevelUserIds(client, guild.id, lowestLevel);

            for (const userId of userIds) {
                let member;
                try {
                    member = await guild.members.fetch(userId);
                } catch (error) {
                    // 10007: the member left; that is not a failure of the sync.
                    if (Number(error?.code) !== 10007) {
                        summary.errors += 1;
                        logger.warn(`Could not fetch member ${userId} in guild ${guild.id}:`, error?.message);
                    }
                    continue;
                }
                if (!member) {
                    summary.errors += 1;
                    continue;
                }
                summary.membersChecked += 1;

                if (usable.every(entry => member.roles.cache.has(entry.roleId))) continue;

                // Read again after the member fetch: the level or the reward
                // may have changed while Discord answered.
                const current = await getLevelingConfig(client, guild.id);
                if (current.enabled === false) continue;
                const stillConfigured = {};
                for (const entry of usable) {
                    if (current.roleRewards?.[entry.levelStr] === entry.roleId) stillConfigured[entry.levelStr] = entry.roleId;
                }
                const levelData = await getUserLevelData(client, guild.id, userId);

                const result = await syncMemberRewardRoles(
                    guild,
                    member,
                    levelData.level,
                    { enabled: true, roleRewards: stillConfigured },
                    { source },
                );
                summary.rolesReAwarded += result.added.length;
                summary.errors += result.failed.length;
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Level role sync failed for guild ${guild.id}:`, error.message);
        }
    }
    return summary;
}

// ---- manual sync -----------------------------------------------------------
// One run per guild at a time, started from the dashboard. The state lives in
// memory: after a restart it is empty, and the startup sync has run anyway.

const jobs = new Map();

function publicStatus(job) {
    if (!job) return { running: false, startedAt: null, finishedAt: null, summary: null, failed: false };
    return {
        running: job.running,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        summary: job.summary,
        failed: job.failed,
    };
}

export function getRewardSyncStatus(guildId) {
    return publicStatus(jobs.get(guildId));
}

/**
 * Start a sync for one guild in the background.
 * Returns `{started:true, status}` or `{started:false, status}` when a run
 * for this guild is still going.
 */
export function startRewardSync(client, guildId, options = {}) {
    const existing = jobs.get(guildId);
    if (existing?.running) return { started: false, status: publicStatus(existing) };

    const job = {
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: null,
        failed: false,
        promise: null,
    };
    jobs.set(guildId, job);

    const run = options.run || reconcileLevelRoles;
    job.promise = Promise.resolve()
        .then(() => run(client, guildId, { source: 'manual sync' }))
        .then(summary => {
            job.summary = summary;
        })
        .catch(error => {
            job.failed = true;
            logger.warn(`Manual level role sync failed for guild ${guildId}:`, error?.message);
        })
        .finally(() => {
            job.running = false;
            job.finishedAt = new Date().toISOString();
        });

    return { started: true, status: publicStatus(job) };
}

/** Resolves when the current manual sync of the guild (if any) has finished. */
export async function waitForRewardSync(guildId) {
    await jobs.get(guildId)?.promise;
    return getRewardSyncStatus(guildId);
}
