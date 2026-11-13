import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import pg from 'pg';
import { assertAllowlistedIdentifier } from '../../utils/sqlIdentifiers.js';
import { EXPECTED_SCHEMA_LABEL, EXPECTED_SCHEMA_VERSION } from './schemaVersion.js';

const configuredTables = {
    guilds: 'guilds',
    users: 'users',
    guild_users: 'guild_users',
    birthdays: 'birthdays',
    giveaways: 'giveaways',
    tickets: 'ticket_data',
    afk_status: 'afk_status',
    welcome_configs: 'welcome_configs',
    leveling_configs: 'leveling_configs',
    user_levels: 'user_levels',
    economy: 'economy',
    invite_tracking: 'invite_tracking',
    application_roles: 'application_roles',
    verification_audit: 'verification_audit',
    temp_data: 'temp_data',
    cache_data: 'cache_data',
};

const allowedTableIdentifiers = new Set([
    'guilds',
    'users',
    'guild_users',
    'birthdays',
    'giveaways',
    'ticket_data',
    'afk_status',
    'welcome_configs',
    'leveling_configs',
    'user_levels',
    'economy',
    'invite_tracking',
    'application_roles',
    'verification_audit',
    'temp_data',
    'cache_data',
]);

const validatedTables = Object.fromEntries(
    Object.entries(configuredTables).map(([key, value]) => [
        key,
        assertAllowlistedIdentifier(value, allowedTableIdentifiers, `PostgreSQL table identifier (${key})`),
    ])
);

const DEFAULT_POSTGRES_URL = 'postgresql://localhost:5432/zentixbot';

// pg parses TLS parameters in connectionString after the `ssl` option and can
// silently replace it. Consume them here and pass a sanitized URL to pg so that
// certificate and hostname verification cannot be overridden by URL options.
function resolvePostgresTls() {
    const rawUrl = (process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();
    const input = (process.env.POSTGRES_SSL || '').trim().toLowerCase();
    if (input && !['true','false','1','0'].includes(input)) throw new Error('POSTGRES_SSL must be true or false.');
    const explicit = input ? ['true','1'].includes(input) : null;
    let url = rawUrl, mode = null, caPath = null;
    if (rawUrl && rawUrl !== DEFAULT_POSTGRES_URL && !/^(sqlite|file):/i.test(rawUrl)) {
        let parsed;
        try { parsed = new URL(rawUrl); } catch { throw new Error('Invalid PostgreSQL URL.'); }
        if (!['postgres:','postgresql:'].includes(parsed.protocol)) throw new Error('Invalid PostgreSQL URL scheme.');
        for (const name of ['sslmode','ssl','sslrootcert','sslcert','sslkey','uselibpqcompat']) {
            if (parsed.searchParams.getAll(name).length > 1) throw new Error('Duplicate PostgreSQL TLS parameter.');
        }
        if (parsed.searchParams.has('sslcert') || parsed.searchParams.has('sslkey') || parsed.searchParams.has('uselibpqcompat')) throw new Error('Unsupported PostgreSQL TLS URL options; configure trusted CA instead.');
        const sslParameter = parsed.searchParams.get('ssl');
        if (sslParameter !== null && !['true','1','false','0'].includes(sslParameter)) throw new Error('Unsafe PostgreSQL ssl URL parameter.');
        const urlSsl = sslParameter === null ? null : ['true','1'].includes(sslParameter);
        mode = parsed.searchParams.get('sslmode');
        if (mode !== null && !['disable','require','verify-ca','verify-full'].includes(mode)) throw new Error('Unsupported PostgreSQL sslmode; use verify-full or disable explicitly.');
        const modeSsl = mode === null ? null : mode !== 'disable';
        if (urlSsl !== null && modeSsl !== null && urlSsl !== modeSsl) throw new Error('Conflicting PostgreSQL TLS URL settings.');
        const requested = modeSsl ?? urlSsl;
        if (explicit !== null && requested !== null && explicit !== requested) throw new Error('Conflicting POSTGRES_SSL and URL TLS settings.');
        caPath = parsed.searchParams.get('sslrootcert');
        if (caPath !== null && !caPath) throw new Error('PostgreSQL CA path must not be empty.');
        for (const name of ['sslmode','ssl','sslrootcert']) parsed.searchParams.delete(name);
        if (requested !== null || caPath !== null) url = parsed.toString();
        mode = requested;
    }
    const caEnv = (process.env.POSTGRES_SSL_CA_FILE || '').trim();
    if (caPath && caEnv && caPath !== caEnv) throw new Error('Conflicting PostgreSQL CA paths.');
    caPath = caPath || caEnv || null;
    const enabled = explicit ?? mode ?? Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === 'production' || caPath);
    if (!enabled && caPath) throw new Error('PostgreSQL CA requires TLS.');
    if (!enabled) return {url,ssl:false};
    const ssl = {rejectUnauthorized:true};
    if (caPath) {
        try { ssl.ca = readFileSync(caPath,'utf8'); } catch { throw new Error('Unable to read PostgreSQL CA file.'); }
        if (!ssl.ca.trim()) throw new Error('PostgreSQL CA file is empty.');
    }
    return {url,ssl};
}
export function resolveSslConfig() { return resolvePostgresTls().ssl; }

export function resolvePostgresPoolConfig() {
    const {ssl,url} = resolvePostgresTls();
    const sharedOptions = {
        max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS) || 20,
        min: parseInt(process.env.POSTGRES_MIN_CONNECTIONS) || 2,
        idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT) || 30000,
        connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT) || 10000,
        application_name: 'zentixbot',
        statement_timeout: process.env.NODE_ENV === 'production' ? 30000 : 0,
        keepalives: 1,
        keepalives_idle: 30,
        ssl,
    };

    const config = url && url !== DEFAULT_POSTGRES_URL
        ? { connectionString: url, ...sharedOptions }
        : { host: process.env.POSTGRES_HOST || 'localhost', port: parseInt(process.env.POSTGRES_PORT) || 5432,
            database: process.env.POSTGRES_DB || 'zentixbot', user: process.env.POSTGRES_USER || 'postgres',
            password: (process.env.POSTGRES_PASSWORD || '').toString(), ...sharedOptions };
    if (ssl) {
        // node-postgres omits SNI for IP literals; on some Node versions this
        // otherwise makes TLS verify 'localhost' rather than the actual IP.
        const host = new pg.Client(config).host;
        if (typeof host !== 'string' || !host || host.startsWith('/')) throw new Error('TLS requires a PostgreSQL hostname or IP address.');
        config.ssl = {...ssl,checkServerIdentity: (_servername,certificate) => checkServerIdentity(host,certificate)};
    }
    return config;
}

export const pgConfig = {
    url: process.env.POSTGRES_URL || process.env.DATABASE_URL || DEFAULT_POSTGRES_URL,
    
    options: {
        
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB || 'zentixbot',
        user: process.env.POSTGRES_USER || 'postgres',
        password: (process.env.POSTGRES_PASSWORD || '').toString(),
        ssl: resolveSslConfig(),

        max: parseInt(process.env.POSTGRES_MAX_CONNECTIONS) || 20,
        min: parseInt(process.env.POSTGRES_MIN_CONNECTIONS) || 2,
        idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT) || 30000,
        connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT) || 10000,

        application_name: 'zentixbot',
        statement_timeout: process.env.NODE_ENV === 'production' ? 30000 : 0,
        keepalives: 1,
        keepalives_idle: 30,

        retries: parseInt(process.env.POSTGRES_RETRIES) || 3,
        backoffBase: parseInt(process.env.POSTGRES_BACKOFF_BASE) || 100,
        backoffMultiplier: parseInt(process.env.POSTGRES_BACKOFF_MULTIPLIER) || 2,
    },
    
    tables: validatedTables,
    
    defaultTTL: {
        userSession: 86400,
        
        temp: 3600,
        
        cache: 1800,
        
        guildConfig: null,
        
        economy: null,
        
        leveling: null,
        
        giveaway: null,
        
        ticket: 604800,
        
        afk: 86400,
        
        welcome: null,
        
        birthday: null,
    },
    
    features: {
        pooling: true,
        ssl: process.env.NODE_ENV === 'production',
        
        metrics: true,
        
        debug: process.env.NODE_ENV === 'development',
        
        autoCreateTables: true,
        
        autoMigrate: process.env.AUTO_MIGRATE !== 'false',
    },
    
    healthCheck: {
        enabled: true,
        
        interval: 30000,
        
        maxFailures: 3,
        
        query: 'SELECT 1',
    },
    
    migration: {
        enabled: true,
        
        table: 'schema_migrations',
        
        directory: 'database/migrations',
        
        rollbackOnFailure: false,

        expectedVersion: EXPECTED_SCHEMA_VERSION,

        expectedLabel: EXPECTED_SCHEMA_LABEL,
    }
};

export default pgConfig;