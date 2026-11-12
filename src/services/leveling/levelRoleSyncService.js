import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from './leveling.js';
import { getUserLevelPrefix } from '../../utils/database/keys.js';

async function listLevelUserIds(client, guildId) {
    if (!client.db?.list) throw new Error('Level database listing unavailable');
    const prefixes = [getUserLevelPrefix(guildId), `${guildId}:leveling:users:`];
    const userIds = new Set();
    for (const prefix of prefixes) {
        const keys = await client.db.list(prefix);
        if (!Array.isArray(keys)) throw new Error('Invalid level database listing');
        for (const key of keys) {
            if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
            const userId = key.slice(prefix.length);
            if (/^\d{17,20}$/.test(userId)) userIds.add(userId);
        }
    }
    return [...userIds];
}

export async function reconcileLevelRoles(client, guildId = null) {
    const summary = {scannedGuilds:0,prunedRewardEntries:0,missingRewardEntries:0,rolesReAwarded:0,errors:0};
    const guilds = guildId ? [client.guilds.cache.get(guildId)].filter(Boolean) : [...client.guilds.cache.values()];
    for (const guild of guilds) {
        summary.scannedGuilds += 1;
        try {
            const cfg = await getLevelingConfig(client, guild.id);
            if (cfg.enabled === false) continue;
            const rewards = Object.entries(cfg.roleRewards || {});
            if (!rewards.length) continue;
            const usable = [];
            for (const [levelStr,roleId] of rewards) {
                const level=Number(levelStr);
                if (!Number.isInteger(level)||level<0||level>1000||typeof roleId!=='string'||!roleId) {
                    summary.errors++;logger.warn(`Invalid level reward configuration in guild ${guild.id}`);continue;
                }
                let role=guild.roles.cache.get(roleId);
                if (!role) {
                    try { role=await guild.roles.fetch(roleId); }
                    catch (error) {
                        if (Number(error?.code)===10011) {
                            summary.missingRewardEntries++;
                            logger.warn(`Missing level ${level} reward role ${roleId} in guild ${guild.id}; configuration preserved.`);
                        } else {
                            summary.errors++;
                            logger.warn(`Unable to check level reward role ${roleId} in guild ${guild.id}:`,error?.message);
                        }
                        continue;
                    }
                }
                if (!role) {summary.errors++;logger.warn(`Role lookup returned no result for ${roleId} in guild ${guild.id}; configuration preserved.`);continue;}
                usable.push({level,levelStr,roleId,role});
            }
            if (!usable.length) continue;
            const userIds=await listLevelUserIds(client,guild.id);
            for (const userId of userIds) {
                let member;
                try { member=await guild.members.fetch(userId); }
                catch(error){if(Number(error?.code)!==10007){summary.errors++;logger.warn(`Could not fetch member ${userId} in guild ${guild.id}:`,error?.message)}continue}
                if (!member) {summary.errors++;continue;}
                for (const {level,levelStr,roleId,role} of usable) {
                    if (member.roles.cache.has(roleId)) continue;
                    // Re-check after member fetch; Discord and the database are not
                    // one transaction, so a later concurrent change may still race.
                    const current=await getLevelingConfig(client,guild.id);
                    if(current.enabled===false||current.roleRewards?.[levelStr]!==roleId)continue;
                    const levelData=await getUserLevelData(client,guild.id,userId);
                    if(levelData.level<level)continue;
                    try {await member.roles.add(role,`Level ${level} reward (startup sync)`);summary.rolesReAwarded++;}
                    catch(error){summary.errors++;logger.warn(`Could not re-award level ${level} role to ${userId} in guild ${guild.id}:`,error?.message)}
                }
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Level role sync failed for guild ${guild.id}:`, error.message);
        }
    }
    return summary;
}
