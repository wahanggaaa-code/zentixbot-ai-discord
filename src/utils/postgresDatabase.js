// postgresDatabase.js

import pg from 'pg';
import { pgConfig, resolvePostgresPoolConfig } from '../config/database/postgres.js';
import { logger } from './logger.js';
import { assertAllowlistedIdentifier, quoteIdentifier } from './sqlIdentifiers.js';
import {
    canonicalizeKey,
    getLegacyVariantsForCanonical,
} from './database/keys.js';
import {
    parseKey,
    isTempBackedType,
    getStructuredListPlan,
} from './database/keyParser.js';
import { auditLegacyKeysOnStartup } from './database/legacyKeyStartupAudit.js';
import { inspectStartupSchema } from './database/schemaStartupPreflight.js';
import {
    tableStatements,
    indexStatements,
    UPDATE_TIMESTAMP_FUNCTION,
    triggerDefinitions,
} from './database/schema.js';

function normalizeTimestampInput(value, fallback = new Date()) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value;
    }

    const numericValue = typeof value === 'string' && /^[0-9]+$/.test(value)
        ? Number(value)
        : Number(value);

    if (Number.isFinite(numericValue) && numericValue >= 0) {
        const date = new Date(numericValue);
        if (!Number.isNaN(date.getTime())) {
            return date;
        }
    }

    const parsedDate = new Date(value);
    return !Number.isNaN(parsedDate.getTime()) ? parsedDate : fallback;
}

// Data with its own transactional writer. The generic key/value methods
// (set, delete, increment, decrement) refuse these so that no code path can
// replace a whole record behind the protocol's back. Reads stay available.
const PROTOCOL_ONLY_KEY_TYPES = [
    'guild_config',
    'welcome_config',
    'guild_birthdays',
    'birthday_left',
    'guild_giveaways',
    'jointocreate_config',
    'jointocreate_channels',
    // Written by src/services/serverStats/store.js (row lock from read to write).
    'counters',
    // Written by src/services/reactionRoles/store.js (per-guild lock, validated panels).
    'reaction_role',
    'counting_game',
];
// To-do lists have no key type of their own; they are written by src/services/todo/store.js
// (lock from read to write, failures thrown instead of answered with "no data").
// Role applications (settings, forms, per-form settings, applications) are written by
// src/services/applications/store.js under one lock per server.
const PROTOCOL_ONLY_KEY_PATTERN = /^(?:todo_|shared_todo_|user_shared_lists_|guild:[^:]+:applications:)/;

function isProtocolOnlyKey(key) {
    if (typeof key !== 'string') return false;
    const canonical = canonicalizeKey(key);
    return PROTOCOL_ONLY_KEY_PATTERN.test(canonical) || PROTOCOL_ONLY_KEY_TYPES.includes(parseKey(canonical).type);
}

class PostgreSQLDatabase {
    constructor() {
        this.pool = null;
        this.isConnected = false;
        this.connectionPromise = null;
        this.allowedTableIdentifiers = new Set(Object.values(pgConfig.tables));
        this.allowedMigrationIdentifiers = new Set([pgConfig.migration.table]);
        this.lastFailureReason = null;
        this.lastFailureMessage = null;
    }

    async connect() {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        if (this.isAvailable()) {
            return true;
        }
        const pending = this._establishConnection();
        this.connectionPromise = pending;
        try {
            return await pending;
        } finally {
            if (this.connectionPromise === pending) this.connectionPromise = null;
        }
    }

    async _establishConnection() {
        const retries = Number.isFinite(pgConfig.options.retries) ? pgConfig.options.retries : 0;
        const baseDelay = Number.isFinite(pgConfig.options.backoffBase) ? pgConfig.options.backoffBase : 100;
        const multiplier = Number.isFinite(pgConfig.options.backoffMultiplier) ? pgConfig.options.backoffMultiplier : 2;
        const attempts = Math.max(1, retries + 1);

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                await new Promise(resolve => setTimeout(resolve, 100));

                this.pool = new pg.Pool(resolvePostgresPoolConfig());

                this.pool.on('error', (error, client) => {
                    logger.error('PostgreSQL pool error:', error);
                });

                const client = await this.pool.connect();
                try {
                    await client.query('SELECT NOW()');
                } catch (error) {
                    client.release(error);
                    throw error;
                }
                client.release();

                this.lastFailureReason = null;
                this.lastFailureMessage = null;

                // Check before DDL so an unversioned existing installation is
                // never stamped as fresh merely because CREATE IF NOT EXISTS succeeded.
                const schemaState = pgConfig.migration.enabled ? await inspectStartupSchema(this.pool) : null;
                if (schemaState?.fresh && !pgConfig.features.autoMigrate) {
                    throw Object.assign(new Error('Schema bootstrap is disabled.'), {code:'SCHEMA_VERSION_MISMATCH'});
                }

                if (pgConfig.features.autoCreateTables) {
                    await this.createTables();

                    try {
                        const columnCheck = await this.pool.query(`
                            SELECT column_name 
                            FROM information_schema.columns 
                            WHERE table_name = 'guilds' AND column_name = 'counters'
                        `);

                        if (columnCheck.rows.length === 0) {
                            await this.pool.query(`
                                ALTER TABLE ${pgConfig.tables.guilds} 
                                ADD COLUMN counters JSONB DEFAULT '[]'
                            `);
                            logger.info('Added counters column to guilds table');
                        }
                    } catch (error) {
                        logger.warn('Could not add counters column to guilds table:', error.message);
                    }
                }

                if (pgConfig.migration.enabled) {
                    const migrationCheck = await this.verifySchemaVersion();
                    if (!migrationCheck.ok) {
                        const shouldBootstrapSchema =
                            migrationCheck.reason === 'MISSING_MIGRATION_VERSION'
                            && pgConfig.features.autoMigrate;

                        if (shouldBootstrapSchema) {
                            await this.setSchemaVersion(
                                pgConfig.migration.expectedVersion,
                                pgConfig.migration.expectedLabel
                            );
                            logger.warn(
                                `No schema version found. Bootstrapped schema ledger to version ${pgConfig.migration.expectedVersion} (${pgConfig.migration.expectedLabel}).`
                            );
                            await this.runStartupKeyMigration();
                            this.isConnected = true;
                            logger.debug('PostgreSQL Database initialized successfully');
                            return true;
                        }

                        const error = new Error(
                            `Schema version check failed: expected ${migrationCheck.expectedVersion} but found ${migrationCheck.currentVersion === null ? 'none' : migrationCheck.currentVersion}`
                        );
                        error.code = 'SCHEMA_VERSION_MISMATCH';
                        throw error;
                    }
                }

                await this.runStartupKeyMigration();
                this.isConnected = true;
                logger.debug('PostgreSQL Database initialized successfully');
                return true;
            } catch (error) {
                this.isConnected = false;
                this.lastFailureReason = error.code || 'POSTGRES_CONNECTION_FAILED';
                this.lastFailureMessage = error.message || 'Unknown PostgreSQL error';

                if (this.pool) {
                    try {
                        await this.pool.end();
                    } catch (closeError) {
                        logger.warn('Failed to close PostgreSQL pool after error:', closeError.message);
                    }
                    this.pool = null;
                }

                const isLastAttempt = attempt >= attempts;
                const isSchemaMismatch = ['SCHEMA_VERSION_MISMATCH','SCHEMA_UNVERSIONED_EXISTING','SCHEMA_INCOMPLETE','LEGACY_KEYS_REQUIRE_REVIEW','LEGACY_KEY_AUDIT_LIMIT'].includes(error.code);
                if (isLastAttempt) {
                    logger.error('Failed to initialize PostgreSQL Database:', error);
                    this.isConnected = false;
                    return false;
                }

                if (isSchemaMismatch) {
                    logger.error('Failed to initialize PostgreSQL Database:', error);
                    this.isConnected = false;
                    return false;
                }

                logger.warn(`PostgreSQL connection attempt ${attempt} failed: ${error.message}`);
                const backoff = Math.round(baseDelay * Math.pow(multiplier, attempt - 1));
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }

        this.isConnected = false;
        return false;
    }

    async runStartupKeyMigration() {
        // Auditing is independent of AUTO_MIGRATE and never rewrites legacy data.
        await auditLegacyKeysOnStartup(this.pool);
    }

    isAvailable() {
        return this.isConnected && this.pool;
    }

    getLastFailure() {
        return {
            reason: this.lastFailureReason,
            message: this.lastFailureMessage
        };
    }

    async ensureMigrationLedger() {
        const migrationTable = assertAllowlistedIdentifier(
            pgConfig.migration.table,
            this.allowedMigrationIdentifiers,
            'PostgreSQL migration table identifier'
        );
        const safeMigrationTable = quoteIdentifier(migrationTable);

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS ${safeMigrationTable} (
                version INTEGER PRIMARY KEY,
                label VARCHAR(255) NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        return safeMigrationTable;
    }

    async getLatestSchemaVersion() {
        const safeMigrationTable = await this.ensureMigrationLedger();
        const result = await this.pool.query(
            `SELECT version, label, applied_at FROM ${safeMigrationTable} ORDER BY version DESC LIMIT 1`
        );

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    }

    async setSchemaVersion(version, label) {
        const safeMigrationTable = await this.ensureMigrationLedger();
        await this.pool.query(
            `INSERT INTO ${safeMigrationTable} (version, label)
             VALUES ($1, $2)
             ON CONFLICT (version)
             DO UPDATE SET label = EXCLUDED.label, applied_at = CURRENT_TIMESTAMP`,
            [version, label]
        );
    }

    async verifySchemaVersion() {
        const latest = await this.getLatestSchemaVersion();
        const expectedVersion = Number(pgConfig.migration.expectedVersion);

        if (!latest) {
            return {
                ok: false,
                expectedVersion,
                currentVersion: null,
                reason: 'MISSING_MIGRATION_VERSION'
            };
        }

        const currentVersion = Number(latest.version);
        const isValid = currentVersion === expectedVersion;

        return {
            ok: isValid,
            expectedVersion,
            currentVersion,
            label: latest.label,
            appliedAt: latest.applied_at,
            reason: isValid ? 'OK' : 'SCHEMA_VERSION_MISMATCH'
        };
    }

    async createTables() {
        for (const table of tableStatements) {
            try {
                await this.pool.query(table);
            } catch (error) {
                logger.error('Error creating table:', error);
                throw error;
            }
        }
        
        logger.debug('Database tables created/verified');
        
        await this.createIndexes();
        await this.createAuditTriggers();
    }

    async createIndexes() {
        for (const index of indexStatements) {
            try {
                await this.pool.query(index);
            } catch (error) {
                logger.warn('Error creating index:', error.message);
            }
        }
        
        logger.debug('Performance indexes created/verified');
    }

    async createAuditTriggers() {
        try {
            await this.pool.query(UPDATE_TIMESTAMP_FUNCTION);

            const triggers = triggerDefinitions;

            const allowedTriggerIdentifiers = new Set(triggers.map(trigger => trigger.name));

            for (const trigger of triggers) {
                try {
                    const safeTriggerIdentifier = assertAllowlistedIdentifier(
                        trigger.name,
                        allowedTriggerIdentifiers,
                        'Trigger identifier'
                    );
                    const safeTableIdentifier = assertAllowlistedIdentifier(
                        trigger.table,
                        this.allowedTableIdentifiers,
                        'Trigger table identifier'
                    );

                    await this.pool.query(
                        `DROP TRIGGER IF EXISTS ${quoteIdentifier(safeTriggerIdentifier)} ON ${quoteIdentifier(safeTableIdentifier)};`
                    );
                    await this.pool.query(
                        `CREATE TRIGGER ${quoteIdentifier(safeTriggerIdentifier)}
                         BEFORE UPDATE ON ${quoteIdentifier(safeTableIdentifier)}
                         FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();`
                    );
                } catch (error) {
                    logger.warn(`Error creating trigger ${trigger.name} on ${trigger.table}: ${error.message}`);
                }
            }
            
            logger.debug('Audit triggers created/verified');
        } catch (error) {
            logger.warn('Error creating audit triggers:', error.message);
        }
    }

    async _getTempValue(key, defaultValue = null) {
        const result = await this.pool.query(
            `SELECT value FROM ${pgConfig.tables.temp_data} WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
            [key],
        );
        return result.rows.length > 0 ? result.rows[0].value : defaultValue;
    }

    async _getWithLegacyFallback(canonicalKey, originalKey, defaultValue) {
        let value = await this._getTempValue(canonicalKey, defaultValue);
        if (value !== defaultValue) {
            return value;
        }

        const legacyKeys = new Set([
            ...(originalKey !== canonicalKey ? [originalKey] : []),
            ...getLegacyVariantsForCanonical(canonicalKey),
        ]);

        for (const legacyKey of legacyKeys) {
            value = await this._getTempValue(legacyKey, defaultValue);
            if (value !== defaultValue) {
                return value;
            }
        }

        return defaultValue;
    }

    async get(key, defaultValue = null) {
        // Guild config feeds read-modify-write paths. Never turn a failed query
        // into a missing row, even if the database reconnects before the write.
        const configKey = typeof key === 'string' ? parseKey(canonicalizeKey(key)) : null;
        if (configKey?.type === 'guild_config') {
            if (!this.isAvailable()) throw Object.assign(new Error('PostgreSQL guild configuration unavailable'), {code: 'CONFIG_DB_UNAVAILABLE'});
            const result = await this.pool.query(
                `SELECT config FROM ${pgConfig.tables.guilds} WHERE id = $1`,
                [configKey.guildId],
            );
            if (!result.rows.length) return defaultValue;
            const raw = result.rows[0].config;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw Object.assign(new Error('Stored guild configuration is not an object'), {code: 'CONFIG_DATA_INVALID'});
            }
            return raw;
        }
        try {
            if (!this.isAvailable()) {
                logger.warn('PostgreSQL not available, returning default value');
                return defaultValue;
            }

            const canonicalKey = canonicalizeKey(key);
            const parsedKey = parseKey(canonicalKey);

            if (parsedKey.type === 'temp' || isTempBackedType(parsedKey.type)) {
                return await this._getWithLegacyFallback(parsedKey.fullKey, key, defaultValue);
            }

            if (parsedKey.type === 'cache') {
                const result = await this.pool.query(
                    `SELECT value FROM ${pgConfig.tables.cache_data} WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                    [parsedKey.fullKey],
                );
                return result.rows.length > 0 ? result.rows[0].value : defaultValue;
            }

            const structuredValue = await this.getStructuredData(parsedKey, defaultValue);
            if (structuredValue !== defaultValue) {
                return structuredValue;
            }

            if (canonicalKey !== key) {
                const legacyParsed = parseKey(key);
                if (legacyParsed.fullKey !== parsedKey.fullKey) {
                    return await this.getStructuredData(legacyParsed, defaultValue);
                }
            }

            return structuredValue;
        } catch (error) {
            logger.error(`Error getting value for key ${key}:`, error);
            return defaultValue;
        }
    }

    async set(key, value, ttl = null) {
        // Replacements require the configuration service's snapshot transaction.
        // Deleting a guild row can also cascade into unrelated guild data.
        if (isProtocolOnlyKey(key)) return false;
        const warningKey=canonicalizeKey(key);
        if (typeof warningKey==='string' && (/^guild:[^:]+:warnings:[^:]+$/.test(warningKey) || /^guild:[^:]+:warning-sequence:[^:]+$/.test(warningKey))) return false;
        try {
            if (!this.isAvailable()) {
                logger.warn('PostgreSQL not available, cannot set value');
                return false;
            }

            const canonicalKey = canonicalizeKey(key);
            const parsedKey = parseKey(canonicalKey);
            const expiresAt = ttl ? new Date(Date.now() + ttl * 1000) : null;
            const jsonValue = JSON.stringify(value ?? null);

            if (parsedKey.type === 'temp' || isTempBackedType(parsedKey.type)) {
                await this.pool.query(
                    `INSERT INTO ${pgConfig.tables.temp_data} (key, value, expires_at)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
                    [parsedKey.fullKey, jsonValue, expiresAt],
                );
                return true;
            }

            if (parsedKey.type === 'cache') {
                await this.pool.query(
                    `INSERT INTO ${pgConfig.tables.cache_data} (key, value, expires_at)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (key) DO UPDATE SET value = $2, expires_at = $3`,
                    [parsedKey.fullKey, jsonValue, expiresAt],
                );
                return true;
            }

            return await this.setStructuredData(parsedKey, value, ttl);
        } catch (error) {
            logger.error(`Error setting value for key ${key}:`, error);
            return false;
        }
    }

    async delete(key) {
        if (isProtocolOnlyKey(key)) return false;
        const warningKey=canonicalizeKey(key);
        if (typeof warningKey==='string' && (/^guild:[^:]+:warnings:[^:]+$/.test(warningKey) || /^guild:[^:]+:warning-sequence:[^:]+$/.test(warningKey))) return false;
        try {
            if (!this.isAvailable()) {
                logger.warn('PostgreSQL not available, cannot delete key');
                return false;
            }

            const canonicalKey = canonicalizeKey(key);
            const parsedKey = parseKey(canonicalKey);
            let deleted = false;

            if (parsedKey.type === 'temp' || isTempBackedType(parsedKey.type)) {
                await this.pool.query(`DELETE FROM ${pgConfig.tables.temp_data} WHERE key = $1`, [parsedKey.fullKey]);
                deleted = true;
            } else if (parsedKey.type === 'cache') {
                await this.pool.query(`DELETE FROM ${pgConfig.tables.cache_data} WHERE key = $1`, [parsedKey.fullKey]);
                deleted = true;
            } else {
                deleted = await this.deleteStructuredData(parsedKey);
            }

            for (const legacyKey of getLegacyVariantsForCanonical(canonicalKey)) {
                await this.pool.query(`DELETE FROM ${pgConfig.tables.temp_data} WHERE key = $1`, [legacyKey]);
            }

            if (key !== canonicalKey) {
                await this.pool.query(`DELETE FROM ${pgConfig.tables.temp_data} WHERE key = $1`, [key]);
            }

            return deleted;
        } catch (error) {
            logger.error(`Error deleting key ${key}:`, error);
            return false;
        }
    }

    async list(prefix) {
        try {
            if (!this.isAvailable()) {
                logger.warn('PostgreSQL not available, returning empty list');
                return [];
            }

            const keys = new Set();
            const plan = getStructuredListPlan(prefix, pgConfig.tables);
            const tempPrefixes = plan.tempPrefixes ?? [prefix];

            for (const tempPrefix of tempPrefixes) {
                const tempResult = await this.pool.query(
                    `SELECT key FROM ${pgConfig.tables.temp_data} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                    [`${tempPrefix}%`],
                );
                for (const row of tempResult.rows) {
                    keys.add(canonicalizeKey(row.key));
                }
            }

            const cacheResult = await this.pool.query(
                `SELECT key FROM ${pgConfig.tables.cache_data} WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > NOW())`,
                [`${prefix}%`],
            );
            for (const row of cacheResult.rows) {
                keys.add(row.key);
            }

            for (const query of plan.queries) {
                const result = await this.pool.query(query.sql, query.params);
                for (const row of result.rows) {
                    keys.add(query.mapKey(row));
                }
            }

            for (const staticKey of plan.staticKeys ?? []) {
                if (!staticKey.startsWith(prefix)) continue;
                if (await this.exists(staticKey)) {
                    keys.add(staticKey);
                }
            }

            return [...keys];
        } catch (error) {
            logger.error(`Error listing keys with prefix ${prefix}:`, error);
            return [];
        }
    }

    async insertVerificationAudit(record) {
        try {
            if (!this.isAvailable()) {
                return false;
            }

            const {
                guildId,
                userId,
                action,
                source = null,
                moderatorId = null,
                metadata = {},
                createdAt = new Date()
            } = record;

            const timestamp = createdAt instanceof Date ? createdAt : new Date(createdAt);

            await this.pool.query(
                `INSERT INTO ${pgConfig.tables.verification_audit} (guild_id, user_id, action, source, moderator_id, metadata, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [guildId, userId, action, source, moderatorId, metadata, timestamp]
            );

            return true;
        } catch (error) {
            logger.error('Error inserting verification audit:', error);
            return false;
        }
    }

    async exists(key) {
        try {
            if (!this.isAvailable()) {
                return false;
            }

            const value = await this.get(key);
            return value !== null;
        } catch (error) {
            logger.error(`Error checking if key exists ${key}:`, error);
            return false;
        }
    }

    async increment(key, amount = 1) {
        if (isProtocolOnlyKey(key)) {
            throw Object.assign(new Error('Generic configuration mutation is disabled'), {code: 'CONFIG_WRITE_DISABLED'});
        }
        try {
            if (!this.isAvailable()) {
                return amount;
            }

            const currentValue = await this.get(key, 0);
            const newValue = (typeof currentValue === 'number' ? currentValue : 0) + amount;
            await this.set(key, newValue);
            return newValue;
        } catch (error) {
            logger.error(`Error incrementing key ${key}:`, error);
            return amount;
        }
    }

    async decrement(key, amount = 1) {
        if (isProtocolOnlyKey(key)) {
            throw Object.assign(new Error('Generic configuration mutation is disabled'), {code: 'CONFIG_WRITE_DISABLED'});
        }
        try {
            if (!this.isAvailable()) {
                return -amount;
            }

            const currentValue = await this.get(key, 0);
            const newValue = (typeof currentValue === 'number' ? currentValue : 0) - amount;
            await this.set(key, newValue);
            return newValue;
        } catch (error) {
            logger.error(`Error decrementing key ${key}:`, error);
            return -amount;
        }
    }

    async getStructuredData(parsedKey, defaultValue) {
        try {
            switch (parsedKey.type) {
                case 'guild_config':
                    const guildResult = await this.pool.query(
                        `SELECT config FROM ${pgConfig.tables.guilds} WHERE id = $1`,
                        [parsedKey.guildId]
                    );
                    return guildResult.rows.length > 0 ? guildResult.rows[0].config : defaultValue;
                
                case 'guild_birthdays':
                    const birthdayResult = await this.pool.query(
                        `SELECT user_id, month, day FROM ${pgConfig.tables.birthdays} WHERE guild_id = $1`,
                        [parsedKey.guildId]
                    );
                    const birthdays = {};
                    birthdayResult.rows.forEach(row => {
                        birthdays[row.user_id] = { month: row.month, day: row.day };
                    });
                    return birthdays;
                
                case 'guild_giveaways':
                    const giveawayResult = await this.pool.query(
                        `SELECT data FROM ${pgConfig.tables.giveaways} WHERE guild_id = $1`,
                        [parsedKey.guildId]
                    );
                    return giveawayResult.rows.map(row => row.data);
                
                case 'welcome_config':
                    const welcomeResult = await this.pool.query(
                        `SELECT config FROM ${pgConfig.tables.welcome_configs} WHERE guild_id = $1`,
                        [parsedKey.guildId]
                    );
                    return welcomeResult.rows.length > 0 ? welcomeResult.rows[0].config : defaultValue;
                
                case 'leveling_config':
                    const levelingConfigResult = await this.pool.query(
                        `SELECT config FROM ${pgConfig.tables.leveling_configs} WHERE guild_id = $1`,
                        [parsedKey.guildId]
                    );
                    return levelingConfigResult.rows.length > 0 ? levelingConfigResult.rows[0].config : defaultValue;
                
                case 'user_level': {
                    const userLevelResult = await this.pool.query(
                        `SELECT xp, level, total_xp, last_message, rank FROM ${pgConfig.tables.user_levels} WHERE guild_id = $1 AND user_id = $2`,
                        [parsedKey.guildId, parsedKey.userId]
                    );
                    if (userLevelResult.rows.length === 0) return defaultValue;
                    // Map snake_case columns to the camelCase shape consumers expect
                    const levelRow = userLevelResult.rows[0];
                    return {
                        xp: Number(levelRow.xp) || 0,
                        level: Number(levelRow.level) || 0,
                        totalXp: Number(levelRow.total_xp) || 0,
                        lastMessage: Number(levelRow.last_message) || 0,
                        rank: Number(levelRow.rank) || 0,
                    };
                }
                
                case 'economy': {
                    const economyResult = await this.pool.query(
                        `SELECT balance, bank, data FROM ${pgConfig.tables.economy} WHERE guild_id = $1 AND user_id = $2`,
                        [parsedKey.guildId, parsedKey.userId]
                    );
                    if (economyResult.rows.length === 0) return defaultValue;
                    const row = economyResult.rows[0];

                    if (row.data && typeof row.data === 'object' && Object.keys(row.data).length > 0) {
                        return row.data;
                    }
                    return { wallet: row.balance ?? 0, bank: row.bank ?? 0 };
                }
                
                case 'afk_status': {
                    const afkResult = await this.pool.query(
                        `SELECT reason, status_at, expires_at FROM ${pgConfig.tables.afk_status} WHERE guild_id = $1 AND user_id = $2`,
                        [parsedKey.guildId, parsedKey.userId],
                    );
                    if (afkResult.rows.length === 0) return defaultValue;
                    const row = afkResult.rows[0];
                    return {
                        reason: row.reason,
                        setAt: row.status_at,
                        expiresAt: row.expires_at,
                    };
                }
                
                case 'ticket':
                    const ticketResult = await this.pool.query(
                        `SELECT data FROM ${pgConfig.tables.tickets} WHERE guild_id = $1 AND channel_id = $2`,
                        [parsedKey.guildId, parsedKey.channelId]
                    );
                    return ticketResult.rows.length > 0 ? ticketResult.rows[0].data : defaultValue;
                
                case 'counters':
                    const counterResult = await this.pool.query(
                        `SELECT counters FROM ${pgConfig.tables.guilds} WHERE id = $1`,
                        [parsedKey.guildId]
                    );
                    return counterResult.rows.length > 0 ? counterResult.rows[0].counters : defaultValue;
                
                default:
                    return defaultValue;
            }
        } catch (error) {
            logger.error(`Error getting structured data for ${parsedKey.fullKey}:`, error);
            return defaultValue;
        }
    }

    async setStructuredData(parsedKey, value, ttl) {
        try {
            switch (parsedKey.type) {
                case 'guild_config':
                    return false; // Use the snapshot-aware guild configuration service.

                
                case 'guild_birthdays':
                    return false; // Per-member birthday transactions only.

                case 'guild_giveaways':
                    return false; // Never replace the full giveaway map.

                case 'welcome_config':
                    return false; // Use the transactional welcome configuration service.

                case 'leveling_config':
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.guildId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.leveling_configs} (guild_id, config, updated_at) 
                         VALUES ($1, $2, CURRENT_TIMESTAMP) 
                         ON CONFLICT (guild_id) DO UPDATE SET config = $2, updated_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, value]
                    );
                    return true;
                
                case 'user_level':
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.guildId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.users} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.userId]
                    );

                    const lastMessageValue = value?.lastMessage ?? value?.last_message;
                    const normalizedLastMessage = normalizeTimestampInput(lastMessageValue, new Date());
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.user_levels} (guild_id, user_id, xp, level, total_xp, last_message, rank, updated_at) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP) 
                         ON CONFLICT (guild_id, user_id) DO UPDATE SET 
                         xp = $3, level = $4, total_xp = $5, last_message = $6, rank = $7, updated_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.userId, value.xp || 0, value.level || 0, value.totalXp || 0, normalizedLastMessage, value.rank || 0]
                    );
                    return true;
                
                case 'economy':
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.guildId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.users} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.userId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.economy} (guild_id, user_id, balance, bank, data, updated_at) 
                         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) 
                         ON CONFLICT (guild_id, user_id) DO UPDATE SET 
                         balance = $3, bank = $4, data = $5, updated_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.userId, value.wallet ?? value.balance ?? 0, value.bank ?? 0, value]
                    );
                    return true;
                
                case 'afk_status':
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.guildId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.users} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.userId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.afk_status} (guild_id, user_id, reason, expires_at) 
                         VALUES ($1, $2, $3, $4) 
                         ON CONFLICT (guild_id, user_id) DO UPDATE SET 
                         reason = $3, expires_at = $4, status_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.userId, value.reason, (value.expiresAt ?? value.expires_at) ? new Date(value.expiresAt ?? value.expires_at) : null]
                    );
                    return true;
                
                case 'ticket':
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.guildId]
                    );
                    
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.tickets} (guild_id, channel_id, data, expires_at) 
                         VALUES ($1, $2, $3, $4) 
                         ON CONFLICT (channel_id) DO UPDATE SET 
                         data = $3, expires_at = $4, updated_at = CURRENT_TIMESTAMP`,
                        [parsedKey.guildId, parsedKey.channelId, value, ttl ? new Date(Date.now() + ttl * 1000) : null]
                    );
                    return true;
                
                case 'counters':
                    await this.pool.query(
                        `INSERT INTO ${pgConfig.tables.guilds} (id, created_at) 
                         VALUES ($1, CURRENT_TIMESTAMP) 
                         ON CONFLICT (id) DO NOTHING`,
                        [parsedKey.guildId]
                    );
                    
                    const columnCheck = await this.pool.query(`
                        SELECT column_name 
                        FROM information_schema.columns 
                        WHERE table_name = '${pgConfig.tables.guilds}' AND column_name = 'counters'
                    `);
                    
                    if (columnCheck.rows.length === 0) {
                        logger.warn('Counters column does not exist, attempting to add it...');
                        try {
                            await this.pool.query(`
                                ALTER TABLE ${pgConfig.tables.guilds} 
                                ADD COLUMN counters JSONB DEFAULT '[]'
                            `);
                            logger.info('Added counters column to guilds table');
                        } catch (alterError) {
                            logger.error('Failed to add counters column:', alterError);
                            throw new Error(`Counters column missing and could not be created: ${alterError.message}`);
                        }
                    }
                    
                    logger.debug('Saving counter data to PostgreSQL', { type: typeof value, isArray: Array.isArray(value) });

                    const normalizedCounters = Array.isArray(value) ? value : [];
                    const jsonString = JSON.stringify(normalizedCounters);

                    try {
                        await this.pool.query(
                            `INSERT INTO ${pgConfig.tables.guilds} (id, counters, updated_at) 
                             VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP) 
                             ON CONFLICT (id) DO UPDATE SET counters = $2::jsonb, updated_at = CURRENT_TIMESTAMP`,
                            [parsedKey.guildId, jsonString]
                        );
                    } catch (queryError) {
                        logger.error('PostgreSQL query error', { message: queryError.message, detail: queryError.detail, hint: queryError.hint });
                        throw queryError;
                    }
                    return true;
                
                default:
                    return false;
            }
        } catch (error) {
            logger.error(`Error setting structured data for ${parsedKey.fullKey}:`, error);
            return false;
        }
    }

    async deleteStructuredData(parsedKey) {
        try {
            switch (parsedKey.type) {
                case 'guild_config':
                    return false; // Never cascade-delete a guild via generic KV.

                
                case 'guild_birthdays':
                    return false; // Never delete the full birthday map.

                case 'guild_giveaways':
                    return false; // Deletion requires coordinated Discord handling.

                case 'welcome_config':
                    return false; // Generic deletion bypasses configuration safeguards.

                case 'leveling_config':
                    await this.pool.query(`DELETE FROM ${pgConfig.tables.leveling_configs} WHERE guild_id = $1`, [parsedKey.guildId]);
                    return true;
                
                case 'user_level':
                    await this.pool.query(`DELETE FROM ${pgConfig.tables.user_levels} WHERE guild_id = $1 AND user_id = $2`, [parsedKey.guildId, parsedKey.userId]);
                    return true;
                
                case 'economy':
                    await this.pool.query(`DELETE FROM ${pgConfig.tables.economy} WHERE guild_id = $1 AND user_id = $2`, [parsedKey.guildId, parsedKey.userId]);
                    return true;
                
                case 'afk_status':
                    await this.pool.query(`DELETE FROM ${pgConfig.tables.afk_status} WHERE guild_id = $1 AND user_id = $2`, [parsedKey.guildId, parsedKey.userId]);
                    return true;
                
                case 'ticket':
                    await this.pool.query(`DELETE FROM ${pgConfig.tables.tickets} WHERE guild_id = $1 AND channel_id = $2`, [parsedKey.guildId, parsedKey.channelId]);
                    return true;

                case 'counters':
                    await this.pool.query(
                        `UPDATE ${pgConfig.tables.guilds} SET counters = '[]'::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                        [parsedKey.guildId],
                    );
                    return true;
                
                default:
                    return false;
            }
        } catch (error) {
            logger.error(`Error deleting structured data for ${parsedKey.fullKey}:`, error);
            return false;
        }
    }

    async disconnect() {
        this.isConnected = false;
        try {
            if (this.pool) {
                await this.pool.end();
                logger.info('PostgreSQL connection closed');
            }
        } catch (error) {
            logger.error('Error closing PostgreSQL connection:', error);
        } finally {
            this.pool = null;
        }
    }

    async getInfo() {
        try {
            if (!this.isAvailable()) {
                return null;
            }

            const result = await this.pool.query('SELECT version()');
            return {
                version: result.rows[0].version,
                connected: this.isConnected,
                poolSize: this.pool.totalCount,
                idleCount: this.pool.idleCount,
                waitingCount: this.pool.waitingCount
            };
        } catch (error) {
            logger.error('Error getting PostgreSQL info:', error);
            return null;
        }
    }
}

const pgDb = new PostgreSQLDatabase();

export { PostgreSQLDatabase, pgDb };