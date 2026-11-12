// warningService.js

import { db } from '../../utils/database.js';
import { logger } from '../../utils/logger.js';
import { createError, ErrorTypes, wrapServiceClassMethods } from '../../utils/errorHandler.js';
import {readPostgresWarnings,addPostgresWarning,removePostgresWarning,clearPostgresWarnings,listPostgresWarningUsers} from './postgresWarnings.js';
import {isSQLiteWarningBackend,readSQLiteWarnings,addSQLiteWarning,removeSQLiteWarning,clearSQLiteWarnings,listSQLiteWarningUsers} from '../storage/sqliteWarnings.js';

class WarningService {

  static async addWarning({
    guildId,
    userId,
    moderatorId,
    reason,
    timestamp = Date.now()
  }) {
    if (!db.initialized) await db.initialize();
    if (isSQLiteWarningBackend(db)) return addSQLiteWarning(db,{guildId,userId,moderatorId,reason,timestamp});
    return addPostgresWarning(db,{guildId,userId,moderatorId,reason,timestamp});
  }

  static async getWarnings(guildId, userId) {
    if (!db.initialized) await db.initialize();
    if (isSQLiteWarningBackend(db)) return readSQLiteWarnings(db,guildId,userId).filter(w=>w.status!=='deleted');
    return (await readPostgresWarnings(db,guildId,userId)).filter(w => w.status !== 'deleted');
  }

  static async getWarningCount(guildId, userId) {
    const warnings = await this.getWarnings(guildId, userId);
    return warnings.length;
  }

  static async removeWarning(guildId, userId, warningId) {
    if (!db.initialized) await db.initialize();
    if (isSQLiteWarningBackend(db)) {
      if (!removeSQLiteWarning(db,guildId,userId,warningId)) throw createError('Warning not found',ErrorTypes.USER_INPUT,'That warning could not be found. It may have already been removed.',{guildId,userId,warningId});
      return {removed:true};
    }
    if (!await removePostgresWarning(db,guildId,userId,warningId)) throw createError('Warning not found',ErrorTypes.USER_INPUT,'That warning could not be found. It may have already been removed.',{guildId,userId,warningId});
    return {removed:true};
  }

  static async clearWarnings(guildId, userId) {
    if (!db.initialized) await db.initialize();
    if (isSQLiteWarningBackend(db)) return clearSQLiteWarnings(db,guildId,userId);
    return clearPostgresWarnings(db,guildId,userId);
  }

  static async getGuildWarnings(guildId, filters = {}) {
    const { moderatorId, limit = 100 } = filters;
    if (!db.initialized) await db.initialize();
    if (isSQLiteWarningBackend(db)) {
      const all=[];
      for (const userId of listSQLiteWarningUsers(db,guildId)) for(const warning of readSQLiteWarnings(db,guildId,userId)) {
        if(warning.status!=='deleted'&&(!moderatorId||warning.moderatorId===moderatorId))all.push(warning);
      }
      all.sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));return all.slice(0,limit);
    }
    const users = await listPostgresWarningUsers(db,guildId);
    const allWarnings = [];
    for (const userId of users) {
      const warnings = await readPostgresWarnings(db,guildId,userId);
      for (const warning of warnings) {
        if (warning.status === 'deleted' || (moderatorId && warning.moderatorId !== moderatorId)) continue;
        allWarnings.push(warning);
      }
    }

    allWarnings.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    logger.debug(`Fetched guild warnings for ${guildId} with ${allWarnings.length} total`);
    return allWarnings.slice(0, limit);
  }
}

wrapServiceClassMethods(WarningService);

export { WarningService };
