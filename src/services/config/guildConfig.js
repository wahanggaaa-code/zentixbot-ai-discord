// guildConfig.js — the only module that should read/write guild configuration.

import { GUILD_CONFIG_DEFAULTS } from '../../config/guild/guildConfigDefaults.js';
import { readGuildConfig, writeGuildConfig, unwrapReplitData } from '../../utils/database/guildConfigStorage.js';
import { sqliteBackend } from '../storage/sqlite.js';
import { getGuildConfigKey, getWelcomeConfigKey } from '../../utils/database/keys.js';
import { normalizeGuildConfig, validateGuildConfigOrThrow } from '../../utils/schemas.js';
import { createError, ErrorTypes, wrapServiceBoundary } from '../../utils/errorHandler.js';

export { GUILD_CONFIG_DEFAULTS };

// Full configuration writes require a snapshot of the original read. This prevents
// an older Discord command from replacing a newer dashboard transaction.
const sqliteSnapshots=new WeakMap();
function sqliteForConfig(client,guildId){
 if(client?.db?.db?.sqlite?.dialect!=='sqlite')return null;
 const sqlite=sqliteBackend(client);if(!sqlite)throw createError('SQLite unavailable',ErrorTypes.DATABASE,'Persistent storage is unavailable.');
 if(!/^\d{17,20}$/.test(guildId||'')||(client.homeGuildId&&client.homeGuildId!==guildId))throw createError('Invalid guild',ErrorTypes.VALIDATION,'Invalid server.');
 return sqlite;
}
function snapshot(sqlite,guildId,value,raw){sqliteSnapshots.set(value,{sqlite,guildId,raw:JSON.stringify(raw)});return value;}
export function transferGuildConfigSnapshot(source,target){const entry=source&&sqliteSnapshots.get(source);if(entry&&target&&typeof target==='object')sqliteSnapshots.set(target,entry);return target;}
function checkLegacy(raw){if(raw&&typeof raw==='object'&&raw.ok!==undefined&&raw.value!==undefined)throw createError('Legacy config requires migration',ErrorTypes.CONFIGURATION,'Legacy configuration must be migrated before editing.');}
function checkConflict(config,welcome){
 const verification=config.verification||{};
 if((welcome?.roleIds?.length&&(verification.enabled||verification.autoVerify?.enabled))||(verification.enabled&&(config.autoRole||verification.autoVerify?.enabled)))throw createError('Conflicting verification and autorole settings',ErrorTypes.CONFIGURATION,'Disable conflicting autorole or verification settings before saving.');
}
function persistConfig(tx,guildId,config,context){const key=getGuildConfigKey(guildId),raw=tx.botGet(key);checkLegacy(raw);const validated=validateGuildConfigOrThrow(config,{guildId,...context});const welcome=unwrapReplitData(tx.botGet(getWelcomeConfigKey(guildId))||{});checkConflict(validated,welcome);tx.botSet(key,validated);return validated;}
function mutateSQLiteConfig(sqlite,guildId,context,mutate){return sqlite.transaction(tx=>{const raw=tx.botGet(getGuildConfigKey(guildId));checkLegacy(raw);const current=normalizeGuildConfig(raw||{},GUILD_CONFIG_DEFAULTS);const result=persistConfig(tx,guildId,mutate(current),context);return snapshot(sqlite,guildId,result,result)});}


export const getGuildConfig = wrapServiceBoundary(async function getGuildConfig(client, guildId, context = {}) {
    const sqlite=sqliteForConfig(client,guildId);if(sqlite){const raw=sqlite.botGet(getGuildConfigKey(guildId));return snapshot(sqlite,guildId,normalizeGuildConfig(unwrapReplitData(raw)||{},GUILD_CONFIG_DEFAULTS),raw);}
    const config = await readGuildConfig(client, guildId, context);
    return normalizeGuildConfig(config, GUILD_CONFIG_DEFAULTS);
}, {
    service: 'guildConfigService',
    operation: 'getGuildConfig',
    message: 'Failed to fetch guild configuration',
    userMessage: 'Failed to load server configuration. Please try again.',
});

export const setGuildConfig = wrapServiceBoundary(async function setGuildConfig(client, guildId, config, context = {}) {
    const sqlite=sqliteForConfig(client,guildId);if(sqlite){const entry=config&&sqliteSnapshots.get(config);if(!entry||entry.sqlite!==sqlite||entry.guildId!==guildId)throw createError('Configuration snapshot required',ErrorTypes.CONFIGURATION,'Reload server configuration before saving.');
      const saved=sqlite.transaction(tx=>{const raw=tx.botGet(getGuildConfigKey(guildId));checkLegacy(raw);if(JSON.stringify(raw)!==entry.raw)throw createError('Stale guild configuration',ErrorTypes.CONFIGURATION,'Server settings changed. Reload before saving.');return persistConfig(tx,guildId,normalizeGuildConfig(config,GUILD_CONFIG_DEFAULTS),context)});
      snapshot(sqlite,guildId,config,saved);return snapshot(sqlite,guildId,saved,saved);
    }
    const normalized = normalizeGuildConfig(config, GUILD_CONFIG_DEFAULTS);
    return await writeGuildConfig(client, guildId, normalized, context);
}, {
    service: 'guildConfigService',
    operation: 'setGuildConfig',
    message: 'Failed to save guild configuration',
    userMessage: 'Failed to save server configuration. Please try again.',
});

export const updateGuildConfig = wrapServiceBoundary(async function updateGuildConfig(client, guildId, updates, context = {}) {
    const sqlite=sqliteForConfig(client,guildId);if(sqlite)return mutateSQLiteConfig(sqlite,guildId,context,current=>({...current,...updates}));
    const currentConfig = await readGuildConfig(client, guildId, context);
    const merged = { ...currentConfig, ...updates };
    const normalized = normalizeGuildConfig(merged, GUILD_CONFIG_DEFAULTS);
    return await writeGuildConfig(client, guildId, normalized, context);
}, {
    service: 'guildConfigService',
    operation: 'updateGuildConfig',
    message: 'Failed to update guild configuration',
    userMessage: 'Failed to update server configuration. Please try again.',
});

export const getConfigValue = wrapServiceBoundary(async function getConfigValue(client, guildId, key, defaultValue = null, context = {}) {
    const config = await getGuildConfig(client, guildId, context);
    return config[key] !== undefined ? config[key] : defaultValue;
}, {
    service: 'guildConfigService',
    operation: 'getConfigValue',
    message: 'Failed to read guild configuration value',
    userMessage: 'Failed to read a server setting. Please try again.',
});

export const setConfigValue = wrapServiceBoundary(async function setConfigValue(client, guildId, key, value, context = {}) {
    return await updateGuildConfig(client, guildId, { [key]: value }, context);
}, {
    service: 'guildConfigService',
    operation: 'setConfigValue',
    message: 'Failed to update guild configuration value',
    userMessage: 'Failed to update a server setting. Please try again.',
});

/**
 * Merge partial updates into a nested config object (e.g. verification, logging).
 */
export const patchGuildConfig = wrapServiceBoundary(async function patchGuildConfig(client, guildId, patch, context = {}) {
    if (!patch || typeof patch !== 'object') {
        throw createError(
            'Invalid guild config patch',
            ErrorTypes.VALIDATION,
            'Invalid configuration update.',
            { guildId, ...context },
        );
    }

    const sqlite=sqliteForConfig(client,guildId);if(sqlite)return mutateSQLiteConfig(sqlite,guildId,context,current=>deepMergeGuildConfig(current,patch));
    const currentConfig = await readGuildConfig(client, guildId, context);
    const merged = deepMergeGuildConfig(currentConfig, patch);
    const normalized = normalizeGuildConfig(merged, GUILD_CONFIG_DEFAULTS);
    validateGuildConfigOrThrow(normalized, { guildId, ...context });
    return await writeGuildConfig(client, guildId, normalized, context);
}, {
    service: 'guildConfigService',
    operation: 'patchGuildConfig',
    message: 'Failed to patch guild configuration',
    userMessage: 'Failed to update server configuration. Please try again.',
});

function deepMergeGuildConfig(base, patch) {
    const result = { ...base };

    for (const [key, value] of Object.entries(patch)) {
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            base[key] &&
            typeof base[key] === 'object' &&
            !Array.isArray(base[key])
        ) {
            result[key] = { ...base[key], ...value };
        } else {
            result[key] = value;
        }
    }

    return result;
}
