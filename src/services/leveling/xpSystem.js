// xpSystem.js

import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData } from './leveling.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';
import {isSQLiteLevelBackend,mutateSQLiteLevel} from './sqliteLevels.js';

/**
 * Award XP to a member. Returns null when XP is skipped (disabled/invalid amount).
 * Throws on storage or unexpected failures.
 */
export const addXp = wrapServiceBoundary(async function addXp(client, guild, member, xpToAdd, options = {}) {
  const lockKey = `leveling:${guild.id}:${member.user.id}`;
  return await Mutex.runExclusive(lockKey, async () => {
    if (!xpToAdd || xpToAdd <= 0) {
      return null;
    }

    const config = await getLevelingConfig(client, guild.id);

    if (!config.enabled) {
      return null;
    }

    if (isSQLiteLevelBackend(client)) {
      if (!Number.isSafeInteger(xpToAdd) || xpToAdd <= 0 || !Number.isSafeInteger(options.cooldownMs ?? 0) || (options.cooldownMs ?? 0)<0) throw new Error('Invalid XP amount or cooldown');
      const saved=mutateSQLiteLevel(client,guild.id,member.user.id,data=>{
        const now=Date.now();
        if ((options.cooldownMs ?? 0)>0 && data.lastMessage && now-data.lastMessage < options.cooldownMs) return {write:false,result:null};
        const initialLevel=data.level,levels=[];
        data.xp+=xpToAdd;data.totalXp+=xpToAdd;data.lastMessage=now;
        if (!Number.isSafeInteger(data.xp)||!Number.isSafeInteger(data.totalXp)) throw new Error('XP exceeds safe range');
        while(data.level<1000 && data.xp>=getXpForLevel(data.level)){
          data.xp-=getXpForLevel(data.level);data.level++;levels.push(data.level);
        }
        return {result:{data:{...data},initialLevel,levels}};
      });
      if (!saved) return null;
      const levelData=saved.data,didLevelUp=saved.levels.length>0;
      // Discord effects only occur after the SQLite commit. Delivery is best effort;
      // it is not an exactly-once outbox and failures may need manual recovery.
      for (const level of saved.levels) {
        logger.info(`🎉 ${member.user.tag} leveled up to level ${level} in ${guild.name}`);
        if (config.roleRewards?.[level]) await awardRoleReward(guild,member,config.roleRewards[level],level);
      }
      if (didLevelUp) {
        if (config.announceLevelUp) await sendLevelUpAnnouncement(guild,member,levelData,config);
        try { await logEvent({client,guildId:guild.id,eventType:EVENT_TYPES.LEVELING_LEVELUP,data:{title:'Level Up',lines:[formatLogLine('Member',`${member.user.tag} (\`${member.user.id}\`)`),formatLogLine('New Level',String(levelData.level)),formatLogLine('Levels Gained',String(levelData.level-saved.initialLevel)),formatLogLine('Total XP',String(levelData.totalXp))],userId:member.user.id}}); }
        catch (logError) { logger.debug('Failed to log leveling event:',logError.message); }
      }
      return {level:levelData.level,xp:levelData.xp,totalXp:levelData.totalXp,xpNeeded:getXpForLevel(Math.min(1000,levelData.level+1)),leveledUp:didLevelUp};
    }

    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    levelData.xp += xpToAdd;
    levelData.totalXp += xpToAdd;
    levelData.lastMessage = Date.now();

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);

      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

      if (config.roleRewards && config.roleRewards[levelData.level]) {
        await awardRoleReward(guild, member, config.roleRewards[levelData.level], levelData.level);
      }
    }

    if (didLevelUp) {
      if (config.announceLevelUp) {
        await sendLevelUpAnnouncement(guild, member, levelData, config);
      }

      try {
        await logEvent({
          client,
          guildId: guild.id,
          eventType: EVENT_TYPES.LEVELING_LEVELUP,
          data: {
            title: 'Level Up',
            lines: [
              formatLogLine('Member', `${member.user.tag} (\`${member.user.id}\`)`),
              formatLogLine('New Level', levelData.level.toString()),
              formatLogLine('Levels Gained', (levelData.level - initialLevel).toString()),
              formatLogLine('Total XP', levelData.totalXp.toString()),
            ],
            userId: member.user.id,
          },
        });
      } catch (logError) {
        logger.debug('Failed to log leveling event:', logError.message);
      }
    }

    await saveUserLevelData(client, guild.id, member.user.id, levelData);

    return {
      level: levelData.level,
      xp: levelData.xp,
      totalXp: levelData.totalXp,
      xpNeeded: getXpForLevel(Math.min(1000, levelData.level + 1)),
      leveledUp: didLevelUp,
    };
  });
}, {
  service: 'xpSystem',
  operation: 'addXp',
  userMessage: 'Failed to award XP. Please try again.',
});

async function awardRoleReward(guild, member, roleId, level) {
  try {
    const role = guild.roles.cache.get(roleId);

    if (!role) {
      logger.warn(`Role ${roleId} not found for level ${level} reward in guild ${guild.id}`);
      return;
    }

    if (member.roles.cache.has(roleId)) {
      return;
    }

    await member.roles.add(role, `Level ${level} reward`);
    logger.info(`✅ Awarded role ${role.name} to ${member.user.tag} for reaching level ${level}`);
  } catch (error) {
    logger.error(`Failed to award role reward to ${member.user.id}:`, error);
  }
}

async function sendLevelUpAnnouncement(guild, member, levelData, config) {
  try {
    const levelUpChannel = config.levelUpChannel
      ? guild.channels.cache.get(config.levelUpChannel)
      : guild.systemChannel;

    if (!levelUpChannel || !levelUpChannel.isTextBased()) {
      return;
    }

    const permissions = levelUpChannel.permissionsFor(guild.members.me);
    if (!permissions || !permissions.has(['SendMessages', 'EmbedLinks'])) {
      logger.warn(`Missing permissions to send levelup message in ${levelUpChannel.id}`);
      return;
    }

    const message = config.levelUpMessage
      .replace(/{user}/g, member.toString())
      .replace(/{level}/g, levelData.level)
      .replace(/{xp}/g, levelData.xp)
      .replace(/{xpNeeded}/g, getXpForLevel(Math.min(1000, levelData.level + 1)));

    await levelUpChannel.send(message).catch(error => {
      logger.error(`Failed to send level up message in channel ${levelUpChannel.id}:`, error);
    });
  } catch (error) {
    logger.error('Error sending level up announcement:', error);
  }
}
