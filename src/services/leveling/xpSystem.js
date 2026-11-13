// xpSystem.js

import { logger } from '../../utils/logger.js';
import { getLevelingConfig, getXpForLevel, getUserLevelData, saveUserLevelData, getLevelLockKey } from './leveling.js';
import { syncMemberRewardRoles } from './rewardRoles.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { Mutex } from '../../utils/mutex.js';
import { wrapServiceBoundary } from '../../utils/errorHandler.js';
import { atomicLevelMutator } from './postgresLevels.js';

/**
 * Award XP to a member. Returns null when XP is skipped (disabled, invalid
 * amount, or the member is still inside `options.cooldownMs`).
 * Throws on storage or unexpected failures.
 *
 * Order: the level record is saved first; reward roles, the announcement and
 * the log entry follow and are best effort. A reward role that could not be
 * given is retried on the member's next level-up, by the startup sync and by
 * the manual sync; nothing is rolled back.
 */
export const addXp = wrapServiceBoundary(async function addXp(client, guild, member, xpToAdd, options = {}) {
  const lockKey = getLevelLockKey(guild.id, member.user.id);
  return await Mutex.runExclusive(lockKey, async () => {
    if (!xpToAdd || xpToAdd <= 0) {
      return null;
    }

    const config = await getLevelingConfig(client, guild.id);

    if (!config.enabled) {
      return null;
    }

    // SQLite and PostgreSQL: cooldown check, XP and level are one transaction.
    const mutateLevel = atomicLevelMutator(client);
    if (mutateLevel) {
      if (!Number.isSafeInteger(xpToAdd) || xpToAdd <= 0 || !Number.isSafeInteger(options.cooldownMs ?? 0) || (options.cooldownMs ?? 0)<0) throw new Error('Invalid XP amount or cooldown');
      const saved=await mutateLevel(guild.id,member.user.id,data=>{
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
      // Discord effects only occur after the commit. Delivery is best effort;
      // it is not an exactly-once outbox and failures may need manual recovery.
      for (const level of saved.levels) {
        logger.info(`🎉 ${member.user.tag} leveled up to level ${level} in ${guild.name}`);
      }
      let rewardRoles = null;
      if (didLevelUp) {
        rewardRoles = await syncMemberRewardRoles(guild, member, levelData.level, config, { source: 'level up' });
        if (config.announceLevelUp) await sendLevelUpAnnouncement(guild,member,levelData,config);
        try { await logEvent({client,guildId:guild.id,eventType:EVENT_TYPES.LEVELING_LEVELUP,data:{title:'Level Up',lines:[formatLogLine('Member',`${member.user.tag} (\`${member.user.id}\`)`),formatLogLine('New Level',String(levelData.level)),formatLogLine('Levels Gained',String(levelData.level-saved.initialLevel)),formatLogLine('Total XP',String(levelData.totalXp))],userId:member.user.id}}); }
        catch (logError) { logger.debug('Failed to log leveling event:',logError.message); }
      }
      return {level:levelData.level,xp:levelData.xp,totalXp:levelData.totalXp,xpNeeded:getXpForLevel(Math.min(1000,levelData.level+1)),leveledUp:didLevelUp,rewardRoles};
    }

    // Any other backend: read and write are separate calls, guarded only by
    // the process lock above.
    if (!Number.isSafeInteger(xpToAdd)) {
      throw new Error('Invalid XP amount');
    }
    const cooldownMs = options.cooldownMs ?? 0;
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) {
      throw new Error('Invalid XP cooldown');
    }

    const levelData = await getUserLevelData(client, guild.id, member.user.id);

    // Checked here, under the lock, so two messages sent together cannot both
    // pass the cooldown and both receive XP.
    const now = Date.now();
    if (cooldownMs > 0 && levelData.lastMessage && now - levelData.lastMessage < cooldownMs) {
      return null;
    }

    levelData.xp += xpToAdd;
    levelData.totalXp += xpToAdd;
    levelData.lastMessage = now;

    let xpNeededForNextLevel = getXpForLevel(levelData.level);
    let didLevelUp = false;
    const initialLevel = levelData.level;

    while (levelData.xp >= xpNeededForNextLevel && levelData.level < 1000) {
      levelData.xp -= xpNeededForNextLevel;
      levelData.level += 1;
      didLevelUp = true;
      xpNeededForNextLevel = getXpForLevel(levelData.level);
    }

    // Save before any Discord effect: a member must never hold a reward role
    // for a level that was not stored.
    await saveUserLevelData(client, guild.id, member.user.id, levelData);

    let rewardRoles = null;
    if (didLevelUp) {
      logger.info(`🎉 ${member.user.tag} leveled up to level ${levelData.level} in ${guild.name}`);

      rewardRoles = await syncMemberRewardRoles(guild, member, levelData.level, config, { source: 'level up' });

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

    return {
      level: levelData.level,
      xp: levelData.xp,
      totalXp: levelData.totalXp,
      xpNeeded: getXpForLevel(Math.min(1000, levelData.level + 1)),
      leveledUp: didLevelUp,
      rewardRoles,
    };
  });
}, {
  service: 'xpSystem',
  operation: 'addXp',
  userMessage: 'Failed to award XP. Please try again.',
});

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
