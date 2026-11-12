import { pgDb } from '../postgresDatabase.js';
import { logger } from '../logger.js';
import { validateGuildConfigOrThrow } from '../schemas.js';

class DatabaseWrapper {
    constructor() {
        this.initialized = false;
        this.db = null;
        this.useFallback = false;
        this.connectionType = 'none';
        this.degradedModeWarningShown = false;
        this.degradedReason = null;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }

        // Never interpret a SQLite deployment request as permission to fall back to RAM.
        // SQLite integration is still incomplete, so abort before connecting to anything.
        const sqliteRequested = ['DATABASE_ENGINE','DATABASE_DRIVER','DB_TYPE'].some(key => process.env[key]?.trim().toLowerCase() === 'sqlite') || /^(sqlite|file):/i.test((process.env.DATABASE_URL || '').trim()) || Boolean(process.env.DATABASE_PATH?.trim());
        if (sqliteRequested) {
            const error = new Error('SQLite deployment is not yet supported; startup aborted without fallback.');
            error.code = 'SQLITE_INCOMPLETE';
            throw error;
        }

        let connected = false;
        let connectionError = null;
        try {
            logger.info('Attempting to connect to PostgreSQL...');
            connected = await pgDb.connect();
        } catch (error) {
            connectionError = error;
            logger.warn('PostgreSQL connection failed.');
        }
        if (!connected || !pgDb.isAvailable()) {
            const failureCode = connectionError ? connectionError.code : pgDb.getLastFailure?.()?.reason;
            if (failureCode === 'SCHEMA_VERSION_MISMATCH') {
                throw Object.assign(new Error('PostgreSQL schema version mismatch. Run the appropriate migration before startup.'), {code: 'SCHEMA_VERSION_MISMATCH'});
            }
            throw Object.assign(new Error('PostgreSQL unavailable. Startup aborted; no in-memory fallback is used.'), {code: 'POSTGRES_UNAVAILABLE'});
        }
        this.db = pgDb;
        this.useFallback = false;
        this.connectionType = 'postgresql';
        this.degradedReason = null;
        this.initialized = true;
        logger.info('PostgreSQL Database initialized - using persistent database');
    }

    async set(key, value, ttl = null) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Writing to memory: ${key}`);
        }

        if (typeof key === 'string' && /^guild:[^:]+:config$/.test(key)) {
            const guildId = key.split(':')[1];
            validateGuildConfigOrThrow(value, {
                guildId,
                errorCode: 'VALIDATION_FAILED',
            });
        }

        return this.db.set(key, value, ttl);
    }

    async get(key, defaultValue = null) {
        return this.db.get(key, defaultValue);
    }

    async delete(key) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Deleting from memory: ${key}`);
        }
        return this.db.delete(key);
    }

    async list(prefix) {
        return this.db.list(prefix);
    }

    async exists(key) {
        if (this.db.exists) {
            return this.db.exists(key);
        }
        const value = await this.db.get(key);
        return value !== null;
    }

    async increment(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Incrementing in memory: ${key}`);
        }
        if (this.db.increment) {
            return this.db.increment(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current + amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    async decrement(key, amount = 1) {
        if (this.useFallback) {
            logger.debug(`[DEGRADED] Decrementing in memory: ${key}`);
        }
        if (this.db.decrement) {
            return this.db.decrement(key, amount);
        }
        const current = await this.db.get(key, 0);
        const newValue = current - amount;
        await this.db.set(key, newValue);
        return newValue;
    }

    isDegraded() {
        return this.useFallback;
    }

    isAvailable() {
        return Boolean(this.db && !this.useFallback && (typeof this.db.isAvailable !== 'function' || this.db.isAvailable()));
    }

    getStatus() {
        return {
            initialized: this.initialized,
            connectionType: this.connectionType,
            isDegraded: this.useFallback,
            isAvailable: this.isAvailable(),
            degradedReason: this.degradedReason,
        };
    }

    getConnectionType() {
        return this.connectionType;
    }
}

export const db = new DatabaseWrapper();

export async function initializeDatabase() {
    try {
        logger.info('Initializing persistent database (PostgreSQL)...');
        await db.initialize();
        logger.info('Database initialized');
        return { db };
    } catch (error) {
        logger.error('Database initialization failed:', error.message);
        throw error;
    }
}

export async function getFromDb(key, defaultValue = null) {
    try {
        const value = await db.get(key);
        return value === null ? defaultValue : value;
    } catch (error) {
        logger.error(`Error getting value for key ${key}:`, error);
        return defaultValue;
    }
}

export async function setInDb(key, value, ttl = null) {
    try {
        return await db.set(key, value, ttl) === true;
    } catch (error) {
        logger.error(`Error setting value for key ${key}:`, error);
        return false;
    }
}

export async function deleteFromDb(key) {
    try {
        return await db.delete(key) === true;
    } catch (error) {
        logger.error(`Error deleting key ${key}:`, error);
        return false;
    }
}
