// leveling.js

import { EmbedBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { getGuildConfig, setGuildConfig } from '../config/guildConfig.js';
import { ZentixBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { addXp } from './xpSystem.js';
import { getUserLevelKey } from '../../utils/database/keys.js';
import {isSQLiteLevelBackend,readSQLiteLevel,deleteSQLiteLevel} from './sqliteLevels.js';
import { Mutex } from '../../utils/mutex.js';
import { atomicLevelMutator, postgresLevelPool, readPostgresLevel, deletePostgresLevel } from './postgresLevels.js';

const BASE_XP = 100;
const XP_MULTIPLIER = 1.5;
const MAX_LEVEL = 1000;
const MIN_LEVEL = 0;

/**
 * Every writer of one member's level record in this process takes this lock:
 * XP from messages, /leveladd, /levelremove, /levelset and the web dashboard.
 * It is a process lock, not a database lock.
 */
export function getLevelLockKey(guildId, userId) {
  return `leveling:${guildId}:${userId}`;
}

// The leveling section as it was read. Saving a section that came from
// getLevelingConfig is refused when the stored section changed since, so a
// long-lived Discord dashboard cannot overwrite a newer web change.
const levelingSnapshots = new WeakMap();

export function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function trackLevelingSection(section, stored) {
  levelingSnapshots.set(section, canonicalJson(stored));
  return section;
}

export function getXpForLevel(level) {
  if (!Number.isInteger(level) || level < 0 || level > MAX_LEVEL) {
    throw new ZentixBotError(
      `Invalid level: ${level}. Must be between ${MIN_LEVEL} and ${MAX_LEVEL}`,
      ErrorTypes.VALIDATION,
      'The level must be a valid number.'
    );
  }
  return 5 * Math.pow(level, 2) + 50 * level + 50;
}

export function getLevelFromXp(xp) {
  if (!Number.isInteger(xp) || xp < 0) {
    throw new ZentixBotError(
      `Invalid XP: ${xp}`,
      ErrorTypes.VALIDATION,
      'XP must be a non-negative number.'
    );
  }

  let level = 0;
  let xpNeeded = 0;
  
  while (xp >= getXpForLevel(level) && level < MAX_LEVEL) {
    xpNeeded = getXpForLevel(level);
    xp -= xpNeeded;
    level++;
  }
  
  return {
    level: Math.min(level, MAX_LEVEL),
    currentXp: xp,
    xpNeeded: getXpForLevel(Math.min(level, MAX_LEVEL))
  };
}

export function calculateTotalXp(level, currentXp = 0) {
  let total = currentXp;
  for (let i = 0; i < level; i++) {
    total += getXpForLevel(i);
  }
  return total;
}

export async function getLeaderboard(client, guildId, limit = 10) {
  try {
    
    if (!guildId || typeof guildId !== 'string') {
      throw new ZentixBotError(
        'Invalid guild ID',
        ErrorTypes.VALIDATION,
        'Guild ID is required.'
      );
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      limit = Math.min(Math.max(limit, 1), 100);
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn(`Guild ${guildId} not found in cache`);
      return [];
    }
    
    const members = await guild.members.fetch().catch(error => {
      logger.error(`Failed to fetch members for guild ${guildId}:`, error);
      return new Map();
    });

    const leaderboard = [];
    
    for (const [userId, member] of members) {
      if (member.user.bot) continue;
      
      const data = await getUserLevelData(client, guildId, userId);
      if (data && (data.totalXp > 0 || data.level > 0)) {
        leaderboard.push({
          userId,
          username: member.user.username,
          discriminator: member.user.discriminator,
          ...data
        });
      }
    }
    
    leaderboard.sort((a, b) => b.totalXp - a.totalXp);
    
    leaderboard.forEach((entry, index) => {
      entry.rank = index + 1;
    });
    
    return leaderboard.slice(0, limit);
    
  } catch (error) {
    logger.error('Error getting leaderboard:', error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to fetch leaderboard: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not fetch the leaderboard at this time.'
    );
  }
}

export function createLeaderboardEmbed(leaderboard, guild) {
  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${guild.name} Leaderboard`)
    .setColor('#2ecc71')
    .setTimestamp();
    
  if (!leaderboard || leaderboard.length === 0) {
    embed.setDescription('No users on the leaderboard yet!');
    return embed;
  }
  
  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3);
  
  const top3Text = top3.map((user, index) => {
    const medal = ['🥇', '🥈', '🥉'][index];
    return `${medal} **#${user.rank}** ${user.username} - Level ${user.level} (${user.totalXp} XP)`;
  }).join('\n');
  
  const restText = rest.map(user => {
    return `**#${user.rank}** ${user.username} - Level ${user.level} (${user.totalXp} XP)`;
  }).join('\n');
  
  embed.setDescription(
    `**Top Members**\n${top3Text}${restText ? '\n\n' + restText : ''}`
  );
  
  return embed;
}

export async function getLevelingConfig(client, guildId) {
  try {
    const guildConfig = await getGuildConfig(client, guildId);
    if (guildConfig.leveling) {
      return trackLevelingSection(guildConfig.leveling, guildConfig.leveling);
    }
    return trackLevelingSection({
      enabled: true,
      xpPerMessage: { min: 15, max: 25 },
      xpCooldown: 20,
      levelUpMessage: '{user} has leveled up to level {level}!',
      levelUpChannel: null,
      ignoredChannels: [],
      ignoredRoles: [],
      blacklistedUsers: [],
      roleRewards: {},
      announceLevelUp: true,
      xpMultiplier: 1
    }, guildConfig.leveling);
  } catch (error) {
    logger.error(`Error getting leveling config for guild ${guildId}:`, error);
    // A persistent backend that cannot be read must not look like a server
    // with default settings: `/level setup` would then overwrite the real ones.
    if (isSQLiteLevelBackend(client)) throw error;
    if (client?.db?.getStatus?.()?.connectionType === 'postgresql') throw error;
    return {
      enabled: true,
      xpPerMessage: { min: 15, max: 25 },
      xpCooldown: 20,
      levelUpMessage: '{user} has leveled up to level {level}!',
      levelUpChannel: null,
      ignoredChannels: [],
      ignoredRoles: [],
      blacklistedUsers: [],
      roleRewards: {},
      announceLevelUp: true,
      xpMultiplier: 1
    };
  }
}

export async function getUserLevelData(client, guildId, userId) {
  try {
    if (!guildId || !userId) {
      throw new ZentixBotError(
        'Guild ID and User ID are required',
        ErrorTypes.VALIDATION
      );
    }

    if (isSQLiteLevelBackend(client)) return readSQLiteLevel(client, guildId, userId);
    // PostgreSQL is read directly: a failed query must fail the caller, never
    // look like a member without a level.
    const postgres = postgresLevelPool(client);
    if (postgres) return await readPostgresLevel(postgres, guildId, userId);
    const key = getUserLevelKey(guildId, userId);
    const data = await client.db.get(key);
    
    if (!data) {
      return {
        xp: 0,
        level: 0,
        totalXp: 0,
        lastMessage: 0,
        rank: 0
      };
    }
    
    return {
      xp: Math.max(0, data.xp || 0),
      level: Math.max(0, Math.min(data.level || 0, MAX_LEVEL)),
      totalXp: Math.max(0, data.totalXp || 0),
      lastMessage: data.lastMessage || 0,
      rank: data.rank || 0
    };
  } catch (error) {
    logger.error(`Error getting user level data for ${userId}:`, error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to fetch user data: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not fetch level data at this time.'
    );
  }
}

export async function saveUserLevelData(client, guildId, userId, data) {
  try {
    if (!guildId || !userId) {
      throw new ZentixBotError(
        'Guild ID and User ID are required',
        ErrorTypes.VALIDATION
      );
    }

    if (!data || typeof data !== 'object') {
      throw new ZentixBotError(
        'Invalid user level data',
        ErrorTypes.VALIDATION
      );
    }

    if (isSQLiteLevelBackend(client) || postgresLevelPool(client)) throw Object.assign(new Error('Use atomic level mutations.'), {code:'LEVEL_WRITE_DISABLED'});
    const sanitizedData = {
      xp: Math.max(0, Number(data.xp) || 0),
      level: Math.max(0, Math.min(Number(data.level) || 0, MAX_LEVEL)),
      totalXp: Math.max(0, Number(data.totalXp) || 0),
      lastMessage: Number(data.lastMessage) || 0,
      rank: Number(data.rank) || 0
    };

    const key = getUserLevelKey(guildId, userId);
    const stored = await client.db.set(key, sanitizedData);
    if (stored === false) throw new Error('Level data was not stored');
  } catch (error) {
    logger.error(`Error saving user level data for ${userId}:`, error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to save user data: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not save level data at this time.'
    );
  }
}

export async function saveLevelingConfig(client, guildId, config) {
  try {
    if (!guildId || !config) {
      throw new ZentixBotError(
        'Guild ID and config are required',
        ErrorTypes.VALIDATION
      );
    }

    const guildConfig = await getGuildConfig(client, guildId);

    if (config.xpCooldown && (config.xpCooldown < 0 || config.xpCooldown > 3600)) {
      throw new ZentixBotError(
        'XP cooldown must be between 0 and 3600 seconds',
        ErrorTypes.VALIDATION,
        'Cooldown must be between 0 and 3600 seconds.'
      );
    }

    if (config.xpRange && (config.xpRange.min < 1 || config.xpRange.max < 1 || config.xpRange.min > config.xpRange.max)) {
      throw new ZentixBotError(
        'Invalid XP range configuration',
        ErrorTypes.VALIDATION,
        'Minimum XP must be less than maximum XP, and both must be positive.'
      );
    }

    const expected = levelingSnapshots.get(config);
    if (expected !== undefined && canonicalJson(guildConfig.leveling) !== expected) {
      throw new ZentixBotError(
        'Stale leveling configuration',
        ErrorTypes.CONFIGURATION,
        'Leveling settings were changed somewhere else. Nothing was saved. Open the dashboard again and repeat the change.',
        { errorCode: 'LEVELING_CONFIG_STALE' }
      );
    }

    guildConfig.leveling = config;
    const saved = await setGuildConfig(client, guildId, guildConfig);
    const stored = saved && typeof saved === 'object' && saved.leveling ? saved.leveling : config;
    trackLevelingSection(config, stored);

    logger.info(`Leveling config updated for guild ${guildId}`);
  } catch (error) {
    logger.error(`Error saving leveling config for guild ${guildId}:`, error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to save config: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not save configuration at this time.'
    );
  }
}

export async function addLevels(client, guildId, userId, levels) {
  try {
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
      throw new ZentixBotError(
        'Leveling system is disabled on this server',
        ErrorTypes.CONFIGURATION,
        'The leveling system is currently disabled on this server.'
      );
    }

    if (!Number.isInteger(levels) || levels <= 0) {
      throw new ZentixBotError(
        `Invalid level amount: ${levels}`,
        ErrorTypes.VALIDATION,
        'You must add a positive number of levels.'
      );
    }

    const mutateLevel = atomicLevelMutator(client);
    if (mutateLevel) return await mutateLevel(guildId, userId, data => {
      const newLevel=data.level+levels;
      if (!Number.isSafeInteger(newLevel) || newLevel>MAX_LEVEL) throw new ZentixBotError('Maximum level exceeded',ErrorTypes.VALIDATION,`Maximum level is ${MAX_LEVEL}.`);
      data.level=newLevel;data.xp=0;data.totalXp=calculateTotalXp(newLevel,0);
      return {result:{...data}};
    });
    const userData = await Mutex.runExclusive(getLevelLockKey(guildId, userId), async () => {
      const current = await getUserLevelData(client, guildId, userId);
      const newLevel = current.level + levels;

      if (newLevel > MAX_LEVEL) {
        throw new ZentixBotError(
          `Level ${newLevel} exceeds maximum level ${MAX_LEVEL}`,
          ErrorTypes.VALIDATION,
          `Maximum level is ${MAX_LEVEL}.`
        );
      }

      current.level = newLevel;
      current.xp = 0;
      current.totalXp = calculateTotalXp(newLevel, 0);

      await saveUserLevelData(client, guildId, userId, current);
      return current;
    });

    logger.info(`Added ${levels} levels to user ${userId} in guild ${guildId}`);
    return userData;
  } catch (error) {
    logger.error(`Error adding levels for user ${userId}:`, error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to add levels: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not add levels at this time.'
    );
  }
}

export async function removeLevels(client, guildId, userId, levels) {
  try {
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
      throw new ZentixBotError(
        'Leveling system is disabled on this server',
        ErrorTypes.CONFIGURATION,
        'The leveling system is currently disabled on this server.'
      );
    }

    if (!Number.isInteger(levels) || levels <= 0) {
      throw new ZentixBotError(
        `Invalid level amount: ${levels}`,
        ErrorTypes.VALIDATION,
        'You must remove a positive number of levels.'
      );
    }

    const mutateLevel = atomicLevelMutator(client);
    if (mutateLevel) return await mutateLevel(guildId, userId, data => {
      const newLevel=Math.max(MIN_LEVEL,data.level-levels);data.level=newLevel;data.xp=0;data.totalXp=calculateTotalXp(newLevel,0);
      return {result:{...data}};
    });
    const userData = await Mutex.runExclusive(getLevelLockKey(guildId, userId), async () => {
      const current = await getUserLevelData(client, guildId, userId);
      const newLevel = Math.max(MIN_LEVEL, current.level - levels);

      current.level = newLevel;
      current.xp = 0;
      current.totalXp = calculateTotalXp(newLevel, 0);

      await saveUserLevelData(client, guildId, userId, current);
      return current;
    });

    logger.info(`Removed ${levels} levels from user ${userId} in guild ${guildId}`);
    return userData;
  } catch (error) {
    logger.error(`Error removing levels for user ${userId}:`, error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to remove levels: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not remove levels at this time.'
    );
  }
}

export async function setUserLevel(client, guildId, userId, level) {
  try {
    const levelingConfig = await getLevelingConfig(client, guildId);
    if (!levelingConfig?.enabled) {
      throw new ZentixBotError(
        'Leveling system is disabled on this server',
        ErrorTypes.CONFIGURATION,
        'The leveling system is currently disabled on this server.'
      );
    }

    if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
      throw new ZentixBotError(
        `Invalid level: ${level}`,
        ErrorTypes.VALIDATION,
        `Level must be between ${MIN_LEVEL} and ${MAX_LEVEL}.`
      );
    }

    const mutateLevel = atomicLevelMutator(client);
    if (mutateLevel) return await mutateLevel(guildId, userId, data => {
      data.level=level;data.xp=0;data.totalXp=calculateTotalXp(level,0);return {result:{...data}};
    });
    const userData = await Mutex.runExclusive(getLevelLockKey(guildId, userId), async () => {
      const current = await getUserLevelData(client, guildId, userId);

      current.level = level;
      current.xp = 0;
      current.totalXp = calculateTotalXp(level, 0);

      await saveUserLevelData(client, guildId, userId, current);
      return current;
    });

    logger.info(`Set level for user ${userId} to ${level} in guild ${guildId}`);
    return userData;
  } catch (error) {
    logger.error(`Error setting level for user ${userId}:`, error);
    if (error instanceof ZentixBotError) throw error;
    throw new ZentixBotError(
      `Failed to set level: ${error.message}`,
      ErrorTypes.DATABASE,
      'Could not set level at this time.'
    );
  }
}

export async function deleteUserLevelData(client, guildId, userId) {
  try {
    if (!guildId || !userId) {
      throw new ZentixBotError(
        'Guild ID and User ID are required',
        ErrorTypes.VALIDATION
      );
    }

    if (isSQLiteLevelBackend(client)) return deleteSQLiteLevel(client,guildId,userId);
    const postgres = postgresLevelPool(client);
    if (postgres) {
      await deletePostgresLevel(postgres, guildId, userId);
      logger.debug(`Deleted level data for user ${userId} in guild ${guildId}`);
      return;
    }
    const key = getUserLevelKey(guildId, userId);
    await Mutex.runExclusive(getLevelLockKey(guildId, userId), () => client.db.delete(key));

    logger.debug(`Deleted level data for user ${userId} in guild ${guildId}`);
  } catch (error) {
    logger.error(`Error deleting level data for user ${userId}:`, error);
    if (isSQLiteLevelBackend(client)) throw error;
    if (error instanceof ZentixBotError) throw error;
    logger.warn(`Could not delete level data for user ${userId} in guild ${guildId}`);
  }
}