// guildConfig.js — the only module that should read/write guild configuration.

import { GUILD_CONFIG_DEFAULTS } from '../../config/guild/guildConfigDefaults.js';
import { readGuildConfig, writeGuildConfig, unwrapReplitData } from '../../utils/database/guildConfigStorage.js';
import { sqliteBackend } from '../storage/sqlite.js';
import { getGuildConfigKey, getWelcomeConfigKey } from '../../utils/database/keys.js';
import { normalizeGuildConfig, validateGuildConfigOrThrow } from '../../utils/schemas.js';
import { createError, ErrorTypes, wrapServiceBoundary } from '../../utils/errorHandler.js';
import { pgConfig } from '../../config/database/postgres.js';
import { assertOnboardingCompatible, assertOnboardingShape } from './onboardingConflict.js';

export { GUILD_CONFIG_DEFAULTS };

// Full configuration writes require a snapshot of the original read. This prevents
// an older Discord command from replacing a newer dashboard transaction.
const sqliteSnapshots=new WeakMap();
const postgresSnapshots=new WeakMap();
function sqliteForConfig(client,guildId){
 if(client?.db?.db?.sqlite?.dialect!=='sqlite')return null;
 const sqlite=sqliteBackend(client);if(!sqlite)throw createError('SQLite unavailable',ErrorTypes.DATABASE,'Persistent storage is unavailable.');
 if(!/^\d{17,20}$/.test(guildId||'')||(client.homeGuildId&&client.homeGuildId!==guildId))throw createError('Invalid guild',ErrorTypes.VALIDATION,'Invalid server.');
 return sqlite;
}
function snapshot(sqlite,guildId,value,raw){sqliteSnapshots.set(value,{sqlite,guildId,raw:JSON.stringify(raw)});return value;}
export function transferGuildConfigSnapshot(source,target){if(source&&target&&typeof target==='object'){for(const snapshots of [sqliteSnapshots,postgresSnapshots]){const entry=snapshots.get(source);if(entry)snapshots.set(target,entry);}}return target;}
function checkLegacy(raw){if(raw&&typeof raw==='object'&&raw.ok!==undefined&&raw.value!==undefined)throw createError('Legacy config requires migration',ErrorTypes.CONFIGURATION,'Legacy configuration must be migrated before editing.');}
function checkConflict(config,welcome){
 const verification=config.verification||{};
 if((welcome?.roleIds?.length&&(verification.enabled||verification.autoVerify?.enabled))||(verification.enabled&&(config.autoRole||verification.autoVerify?.enabled)))throw createError('Conflicting verification and autorole settings',ErrorTypes.CONFIGURATION,'Disable conflicting autorole or verification settings before saving.');
}
function persistConfig(tx,guildId,config,context){const key=getGuildConfigKey(guildId),raw=tx.botGet(key);checkLegacy(raw);const validated=validateGuildConfigOrThrow(config,{guildId,...context});const welcome=unwrapReplitData(tx.botGet(getWelcomeConfigKey(guildId))||{});checkConflict(validated,welcome);tx.botSet(key,validated);return validated;}
function mutateSQLiteConfig(sqlite,guildId,context,mutate){return sqlite.transaction(tx=>{const raw=tx.botGet(getGuildConfigKey(guildId));checkLegacy(raw);const current=normalizeGuildConfig(raw||{},GUILD_CONFIG_DEFAULTS);const result=persistConfig(tx,guildId,mutate(current),context);return snapshot(sqlite,guildId,result,result)});}

// PostgreSQL mutations serialize on the same guild row locked by the dashboard.
// Full replacements additionally compare the exact JSONB snapshot that was read.
function postgresForConfig(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql') return null;
    if (status.isDegraded || !db.isAvailable?.() || !db.db?.isAvailable?.() || !db.db.pool?.connect) {
        throw createError('PostgreSQL unavailable for guild config', ErrorTypes.DATABASE, 'Server configuration database is unavailable.');
    }
    return db.db.pool;
}
function postgresSnapshot(pool, guildId, value, raw, exists = true) {
    postgresSnapshots.set(value, {pool, guildId, raw, exists});
    return value;
}
function checkedConfigObject(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw createError('Invalid stored guild configuration', ErrorTypes.DATABASE, 'Server configuration needs review.');
    }
    const cleaned = unwrapReplitData(raw);
    if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
        throw createError('Invalid stored guild configuration', ErrorTypes.DATABASE, 'Server configuration needs review.');
    }
    return cleaned;
}
async function readPostgresConfig(pool, guildId) {
    const rows = await pool.query(`SELECT config FROM ${pgConfig.tables.guilds} WHERE id=$1`, [guildId]);
    const exists = rows.rows.length > 0;
    const raw = exists ? rows.rows[0].config : {};
    const original = JSON.stringify(raw);
    const config = normalizeGuildConfig(checkedConfigObject(raw), GUILD_CONFIG_DEFAULTS);
    return postgresSnapshot(pool, guildId, config, original, exists);
}
async function checkPostgresOnboarding(conn, guildId, config, originalGuild) {
    const result = await conn.query(`SELECT config FROM ${pgConfig.tables.welcome_configs} WHERE guild_id=$1 FOR UPDATE`, [guildId]);
    const welcome = result.rows.length ? result.rows[0].config : {};
    assertOnboardingShape(originalGuild, welcome);
    assertOnboardingCompatible(config, welcome);
}
async function replacePostgresConfig(pool, guildId, config, context) {
    const entry = config && postgresSnapshots.get(config);
    if (!entry || entry.pool !== pool || entry.guildId !== guildId) {
        throw createError('Configuration snapshot required', ErrorTypes.CONFIGURATION, 'Reload server configuration before saving.');
    }
    const saved = validateGuildConfigOrThrow(normalizeGuildConfig(config, GUILD_CONFIG_DEFAULTS), {guildId, ...context});
    const serialized = JSON.stringify(saved);
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        const created = await conn.query(`INSERT INTO ${pgConfig.tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING RETURNING id`, [guildId]);
        const rows = await conn.query(`SELECT config, config = $2::jsonb AS matches FROM ${pgConfig.tables.guilds} WHERE id=$1 FOR UPDATE`, [guildId, entry.raw]);
        const unchanged = entry.exists ? created.rowCount === 0 && rows.rows[0]?.matches === true : created.rowCount === 1;
        if (!unchanged) throw createError('Stale guild configuration', ErrorTypes.CONFIGURATION, 'Server settings changed. Reload before saving.');
        await checkPostgresOnboarding(conn, guildId, saved, rows.rows[0]?.config);
        await conn.query(`UPDATE ${pgConfig.tables.guilds} SET config=$2::jsonb, updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [guildId, serialized]);
        await conn.query('COMMIT');
        postgresSnapshot(pool, guildId, config, serialized);
        return postgresSnapshot(pool, guildId, JSON.parse(serialized), serialized);
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { conn.release(); }
}
async function mutatePostgresConfig(pool, guildId, context, mutate) {
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        // Inserts serialize creation as well as existing rows. Roll back the
        // placeholder if validation or any later statement fails.
        await conn.query(`INSERT INTO ${pgConfig.tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`, [guildId]);
        const rows = await conn.query(`SELECT config FROM ${pgConfig.tables.guilds} WHERE id=$1 FOR UPDATE`, [guildId]);
        const current = normalizeGuildConfig(checkedConfigObject(rows.rows[0]?.config), GUILD_CONFIG_DEFAULTS);
        const normalized = normalizeGuildConfig(mutate(current), GUILD_CONFIG_DEFAULTS);
        const validated = validateGuildConfigOrThrow(normalized, {guildId, ...context});
        await checkPostgresOnboarding(conn, guildId, validated, rows.rows[0]?.config);
        const serialized = JSON.stringify(validated);
        await conn.query(`UPDATE ${pgConfig.tables.guilds} SET config=$2::jsonb, updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [guildId, serialized]);
        await conn.query('COMMIT');
        return postgresSnapshot(pool, guildId, validated, serialized);
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { conn.release(); }
}



export const getGuildConfig = wrapServiceBoundary(async function getGuildConfig(client, guildId, context = {}) {
    const sqlite=sqliteForConfig(client,guildId);if(sqlite){const raw=sqlite.botGet(getGuildConfigKey(guildId));return snapshot(sqlite,guildId,normalizeGuildConfig(unwrapReplitData(raw)||{},GUILD_CONFIG_DEFAULTS),raw);}
    const postgres=postgresForConfig(client);if(postgres)return readPostgresConfig(postgres,guildId);
    const config = await readGuildConfig(client, guildId, context);
    return normalizeGuildConfig(config, GUILD_CONFIG_DEFAULTS);
}, {
    service: 'guildConfigService',
    type: ErrorTypes.DATABASE,
    operation: 'getGuildConfig',
    message: 'Failed to fetch guild configuration',
    userMessage: 'Failed to load server configuration. Please try again.',
});

export const setGuildConfig = wrapServiceBoundary(async function setGuildConfig(client, guildId, config, context = {}) {
    const sqlite=sqliteForConfig(client,guildId);if(sqlite){const entry=config&&sqliteSnapshots.get(config);if(!entry||entry.sqlite!==sqlite||entry.guildId!==guildId)throw createError('Configuration snapshot required',ErrorTypes.CONFIGURATION,'Reload server configuration before saving.');
      const saved=sqlite.transaction(tx=>{const raw=tx.botGet(getGuildConfigKey(guildId));checkLegacy(raw);if(JSON.stringify(raw)!==entry.raw)throw createError('Stale guild configuration',ErrorTypes.CONFIGURATION,'Server settings changed. Reload before saving.');return persistConfig(tx,guildId,normalizeGuildConfig(config,GUILD_CONFIG_DEFAULTS),context)});
      snapshot(sqlite,guildId,config,saved);return snapshot(sqlite,guildId,saved,saved);
    }
    const postgres=postgresForConfig(client);if(postgres)return replacePostgresConfig(postgres,guildId,config,context);
    const normalized = normalizeGuildConfig(config, GUILD_CONFIG_DEFAULTS);
    return await writeGuildConfig(client, guildId, normalized, context);
}, {
    service: 'guildConfigService',
    type: ErrorTypes.DATABASE,
    operation: 'setGuildConfig',
    message: 'Failed to save guild configuration',
    userMessage: 'Failed to save server configuration. Please try again.',
});

export const updateGuildConfig = wrapServiceBoundary(async function updateGuildConfig(client, guildId, updates, context = {}) {
    const sqlite=sqliteForConfig(client,guildId);if(sqlite)return mutateSQLiteConfig(sqlite,guildId,context,current=>({...current,...updates}));
    const postgres=postgresForConfig(client);if(postgres)return mutatePostgresConfig(postgres,guildId,context,current=>({...current,...updates}));
    const currentConfig = await readGuildConfig(client, guildId, context);
    const merged = { ...currentConfig, ...updates };
    const normalized = normalizeGuildConfig(merged, GUILD_CONFIG_DEFAULTS);
    return await writeGuildConfig(client, guildId, normalized, context);
}, {
    service: 'guildConfigService',
    type: ErrorTypes.DATABASE,
    operation: 'updateGuildConfig',
    message: 'Failed to update guild configuration',
    userMessage: 'Failed to update server configuration. Please try again.',
});

export const getConfigValue = wrapServiceBoundary(async function getConfigValue(client, guildId, key, defaultValue = null, context = {}) {
    const config = await getGuildConfig(client, guildId, context);
    return config[key] !== undefined ? config[key] : defaultValue;
}, {
    service: 'guildConfigService',
    type: ErrorTypes.DATABASE,
    operation: 'getConfigValue',
    message: 'Failed to read guild configuration value',
    userMessage: 'Failed to read a server setting. Please try again.',
});

export const setConfigValue = wrapServiceBoundary(async function setConfigValue(client, guildId, key, value, context = {}) {
    return await updateGuildConfig(client, guildId, { [key]: value }, context);
}, {
    service: 'guildConfigService',
    type: ErrorTypes.DATABASE,
    operation: 'setConfigValue',
    message: 'Failed to update guild configuration value',
    userMessage: 'Failed to update a server setting. Please try again.',
});

/**
 * Merge partial updates into a nested config object (e.g. verification, logging).
 */
export const patchGuildConfig = wrapServiceBoundary(async function patchGuildConfig(client, guildId, patch, context = {}) {
    // Capture and validate the entire request before any await. The caller may
    // otherwise mutate its object while waiting for a database lock.
    const capturedPatch = captureGuildConfigPatch(patch);
    const sqlite=sqliteForConfig(client,guildId);if(sqlite)return mutateSQLiteConfig(sqlite,guildId,context,current=>deepMergeGuildConfig(current,capturedPatch));
    const postgres=postgresForConfig(client);if(postgres)return mutatePostgresConfig(postgres,guildId,context,current=>deepMergeGuildConfig(current,capturedPatch));
    const currentConfig = await readGuildConfig(client, guildId, context);
    const merged = deepMergeGuildConfig(currentConfig, capturedPatch);
    const normalized = normalizeGuildConfig(merged, GUILD_CONFIG_DEFAULTS);
    validateGuildConfigOrThrow(normalized, { guildId, ...context });
    return await writeGuildConfig(client, guildId, normalized, context);
}, {
    service: 'guildConfigService',
    type: ErrorTypes.DATABASE,
    operation: 'patchGuildConfig',
    message: 'Failed to patch guild configuration',
    userMessage: 'Failed to update server configuration. Please try again.',
});

// Patches are JSON records; arrays and scalars replace values, whereas records
// recursively merge. Disallow accessors and dangerous keys even inside arrays.
const unsafePatchKeys = new Set(['__proto__', 'prototype', 'constructor']);
const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function captureGuildConfigPatch(patch) {
    const invalid = () => { throw createError('Invalid guild config patch', ErrorTypes.VALIDATION, 'Invalid configuration update.'); };
    if (!plainRecord(patch)) invalid();
    const ancestors = new Set();
    let nodes = 0;
    function copy(value, depth) {
        if (++nodes > 20000 || depth > 32) invalid();
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return value; }
        if (!Array.isArray(value) && !plainRecord(value)) invalid();
        if (ancestors.has(value)) invalid();
        ancestors.add(value);
        if (Object.getOwnPropertySymbols(value).length) invalid();
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Array.isArray(value)) {
            const keys = Object.keys(descriptors).filter(key => key !== 'length');
            if (keys.length !== value.length) invalid();
            const result = [];
            for (let i = 0; i < value.length; i++) {
                const d = descriptors[String(i)];
                if (!d || !d.enumerable || !Object.hasOwn(d, 'value')) invalid();
                result.push(copy(d.value, depth + 1));
            }
            ancestors.delete(value);
            return result;
        }
        const result = {};
        for (const [key, d] of Object.entries(descriptors)) {
            if (unsafePatchKeys.has(key) || !d.enumerable || !Object.hasOwn(d, 'value')) invalid();
            Object.defineProperty(result, key, { value: copy(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
        }
        ancestors.delete(value);
        return result;
    }
    return copy(patch, 0);
}
function deepMergeGuildConfig(base, patch) {
    const result = plainRecord(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
        const previous = Object.hasOwn(result, key) ? result[key] : undefined;
        const next = plainRecord(value) ? deepMergeGuildConfig(previous, value) : value;
        Object.defineProperty(result, key, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return result;
}
