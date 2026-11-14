import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { PostgreSQLDatabase } from '../../src/utils/postgresDatabase.js';
import { db } from '../../src/utils/database/wrapper.js';
import { tableStatements } from '../../src/utils/database/schema.js';
import { discordError } from './fake-discord-guild.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLiteStore } from '../../src/services/storage/sqlite.js';
import { createSQLiteBotDatabase } from '../../src/services/storage/sqliteBotDatabase.js';

// node:sqlite exists from Node 22.5 on. On an older Node the PostgreSQL side of this fixture
// still has to load, so the module is looked up here instead of being imported at the top.
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));

// `ZENTIX_TEST_BACKEND=sqlite` runs a whole PostgreSQL feature suite on SQLite instead
// (see tests/sqlite-feature-suites.test.js); no PostgreSQL server is needed then.
const defaultBackend = process.env.ZENTIX_TEST_BACKEND === 'sqlite' ? 'sqlite' : 'postgresql';
export const pgEnabled = defaultBackend === 'sqlite' || process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';

// ---- where the two databases differ, for the suites that run on both -------------------------
export const onSQLite = defaultBackend === 'sqlite';

/**
 * A generic `set` or `delete` on a row that has its own store is refused:
 * with `false` on PostgreSQL, with a `..._DISABLED` error on SQLite.
 */
export async function isRefused(write) {
    try {
        return (await write) === false;
    } catch (error) {
        if (/_DISABLED$/.test(error?.code ?? '')) return true;
        throw error;
    }
}

/**
 * What the bot says after a COMMIT that failed. PostgreSQL cannot tell whether the change was
 * stored and must say so. SQLite rolls the change back, so there the plain failure is the truth
 * and "it may have been saved" would be wrong.
 */
export function assertCommitFailureSaid(text, uncertain, failed = /could not|Nothing was changed|unavailable/i) {
    if (!onSQLite) return assert.match(text, uncertain);
    assert.doesNotMatch(text, uncertain);
    assert.match(text, failed);
}
export const guildId = '123456789012345678';
export const botId = '523456789012345678';
export const adminId = '323456789012345678';
export const channelId = '443456789012345678';
export const member = (n) => String(700000000000000000n + BigInt(n));
export const role = (n) => String(600000000000000000n + BigInt(n));
export const unknownMember = () => discordError(404, 10007, 'Unknown Member');
export const unknownRole = () => discordError(404, 10011, 'Unknown Role');
export const missingPermissions = () => discordError(403, 50013, 'Missing Permissions');

const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };

/**
 * The real bot tables in a disposable PostgreSQL schema, and an in-memory
 * Discord guild that keeps roles, members and every role that was given.
 *
 * `hooks` run before the matching Discord call takes effect and may throw:
 *   hooks.addRole(member, role, reason)   hooks.fetchMember(userId)
 *   hooks.fetchRole(roleId)
 * `control.failQuery`  (sql) => boolean: a matching query is rejected.
 * `control.delayQuery` (sql, params) => milliseconds: a matching query starts later.
 */
/** The in-memory Discord guild both backends share. */
function fakeDiscord() {
    // ---- Discord ------------------------------------------------------------
    const hooks = {};
    const given = [];
    const roles = new Collection();
    const members = new Collection();
    const channels = new Collection();

    /** `permissions` is a list of PermissionFlagsBits names. Higher position = higher role. */
    function addRole(id, { name = `role-${id.slice(-3)}`, position = 1, permissions = [], managed = false } = {}) {
        const entry = {
            id,
            name,
            position,
            managed,
            permissions: new PermissionsBitField(permissions.map((flag) => PermissionFlagsBits[flag])),
            comparePositionTo: (other) => entry.position - other.position,
            toString: () => `<@&${id}>`,
        };
        roles.set(id, entry);
        return entry;
    }

    addRole(guildId, { name: '@everyone', position: 0 });
    const botRole = addRole(role(900), { name: 'ZentixBot', position: 50, permissions: ['ManageRoles'], managed: true });
    const me = {
        id: botId,
        permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles]),
        roles: { highest: botRole },
    };

    function addMember(id, roleIds = []) {
        const cache = new Collection(roleIds.map((roleId) => [roleId, roles.get(roleId) ?? { id: roleId }]));
        const entry = {
            id,
            user: { id, tag: `user${id.slice(-3)}`, username: `user${id.slice(-3)}` },
            toString: () => `<@${id}>`,
            roles: {
                cache,
                add: async (target, reason) => {
                    await hooks.addRole?.(entry, target, reason);
                    cache.set(target.id, target);
                    given.push({ userId: id, roleId: target.id, reason });
                    return entry;
                },
            },
        };
        members.set(id, entry);
        return entry;
    }

    channels.set(channelId, { id: channelId, name: 'level-up', type: ChannelType.GuildText });

    const guild = {
        id: guildId,
        name: 'Home',
        ownerId: adminId,
        systemChannel: null,
        channels: { cache: channels },
        roles: {
            cache: roles,
            fetch: async (id) => {
                await hooks.fetchRole?.(id);
                const found = roles.get(id);
                if (!found) throw unknownRole();
                return found;
            },
        },
        members: {
            me,
            cache: members,
            fetch: async (query) => {
                const id = typeof query === 'string' ? query : query?.user;
                await hooks.fetchMember?.(id);
                const found = members.get(id);
                if (!found) throw unknownMember();
                return found;
            },
        },
    };

    const client = {
        db,
        homeGuildId: guildId,
        user: { id: botId },
        guilds: { cache: new Map([[guildId, guild]]) },
    };

    return { hooks, given, roles, members, channels, addRole, botRole, me, addMember, guild, client };
}

function apiStarter(t, client, guild) {
    /** Dashboard routes behind a stand-in for the real session and CSRF checks. */
    async function startApi(routers) {
        const app = express();
        const auth = (req, res, next) => {
            req.guild = guild;
            req.member = { id: adminId, user: { id: adminId } };
            next();
        };
        const csrf = (req, res, next) => (req.get('x-csrf') === 'yes' ? next() : res.status(403).json({ error: 'csrf' }));
        for (const create of routers) app.use('/api', create(client, { auth, csrf }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        t.after(() => new Promise((resolve) => server.close(resolve)));
        const origin = `http://127.0.0.1:${server.address().port}/api`;
        return async (path, method = 'GET', body, { csrf: sendCsrf = true } = {}) => {
            const headers = {};
            if (sendCsrf) headers['x-csrf'] = 'yes';
            if (body !== undefined) headers['content-type'] = 'application/json';
            const response = await fetch(origin + path, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, body: await response.json().catch(() => null) };
        };
    }
    return startApi;
}

/**
 * A SQLite store that obeys `control` as the PostgreSQL fixtures do: every access of the bot to
 * the file is announced as the statement PostgreSQL would run for it, so the same `failQuery`
 * tests can make it fail. `delayQuery` is called (tests count with it), but SQLite work is
 * synchronous and never waits.
 *
 * @returns {{ store: object, guildWrites: () => number }}
 */
export function observeSQLite(sqlite, control) {
    let guildWrites = 0; // stands in for guilds.updated_at: it changes exactly when the guild row is written
    const announce = (sql, params = []) => {
        if (control.failQuery?.(sql)) throw new Error('injected database failure');
        control.delayQuery?.(sql, params);
    };
    const table = (key) => {
        const text = String(key);
        if (/^guild:\d+:config$/.test(text)) return { read: 'SELECT config FROM guilds WHERE id = $1', write: 'UPDATE guilds SET config = $2::jsonb WHERE id = $1', remove: 'DELETE FROM guilds WHERE id = $1' };
        if (/^guild:\d+:counters$/.test(text)) return { read: 'SELECT counters FROM guilds WHERE id = $1', write: 'UPDATE guilds SET counters = $2::jsonb WHERE id = $1', remove: 'UPDATE guilds SET counters = NULL WHERE id = $1' };
        if (/leveling:users:/.test(text)) return { read: 'SELECT xp, level, total_xp, last_message, rank FROM user_levels WHERE guild_id = $1 AND user_id = $2', write: 'UPDATE user_levels SET xp = $3, level = $4, total_xp = $5 WHERE guild_id = $1 AND user_id = $2', remove: 'DELETE FROM user_levels WHERE guild_id = $1 AND user_id = $2' };
        if (/^guild:\d+:ticket:\d+$/.test(text)) return { read: 'SELECT data FROM ticket_data WHERE guild_id = $1 AND channel_id = $2', write: 'INSERT INTO ticket_data (guild_id, channel_id, data) VALUES ($1, $2, $3::jsonb)', remove: 'DELETE FROM ticket_data WHERE channel_id = $1' };
        if (/reaction_roles:/.test(text)) return { read: 'SELECT key, value FROM temp_data WHERE key = ANY($1)', write: 'INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', remove: 'DELETE FROM temp_data WHERE key = $1' };
        return { read: 'SELECT value FROM temp_data WHERE key = $1', write: 'INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', remove: 'DELETE FROM temp_data WHERE key = $1' };
    };
    const READS = new Set(['botGet', 'botGetRaw', 'hasRawKey', 'hasRawAIKey', 'get']);
    const LISTS = new Set(['botRows', 'botList', 'botTickets', 'ticketKeysRaw']);
    const WRITES = new Set(['botSet', 'set']);
    const DELETES = new Set(['botDelete']);
    const observed = (target, locked) => new Proxy(target, {
        get(real, name) {
            const value = real[name];
            if (typeof value !== 'function') return value;
            if (name === 'transaction' && !locked) {
                return (work) => real.transaction((tx) => {
                    announce('BEGIN');
                    const result = work(observed(tx, true));
                    announce('COMMIT');
                    return result;
                });
            }
            const lock = locked ? ' FOR UPDATE' : '';
            // As on PostgreSQL: the read-only helpers select "balance, bank, data" with spaces, a transaction does not.
            if (name === 'getAccount') return (...ids) => { announce(locked ? 'SELECT balance,bank,data FROM economy WHERE guild_id=$1 AND user_id=$2 FOR UPDATE' : 'SELECT balance, bank, data FROM economy WHERE guild_id = $1 AND user_id = $2', ids); return value.apply(real, ids); };
            if (name === 'setAccount') return (...args) => { announce('UPDATE economy SET balance=$3,bank=$4,data=$5::jsonb WHERE guild_id=$1 AND user_id=$2', args); return value.apply(real, args); };
            if (name === 'accountKeys') return (...args) => { announce(`SELECT user_id, balance, bank, data FROM economy WHERE guild_id = $1${lock}`, args); return value.apply(real, args); };
            if (name === 'botLevels') return (...args) => { announce(`SELECT user_id FROM user_levels WHERE guild_id = $1 AND level >= $2${lock}`, args); return value.apply(real, args); };
            if (READS.has(name)) return (key, ...rest) => { announce(table(key).read + lock, [key]); return value.call(real, key, ...rest); };
            if (LISTS.has(name)) return (prefix, ...rest) => { announce(`SELECT key, value FROM temp_data WHERE key LIKE $1${lock}`, [prefix]); return value.call(real, prefix, ...rest); };
            if (WRITES.has(name)) return (key, ...rest) => { announce(table(key).write, [key]); const done = value.call(real, key, ...rest); if (/^guild:\d+:(config|counters)$/.test(String(key))) guildWrites += 1; return done; };
            if (DELETES.has(name)) return (key, ...rest) => { announce(table(key).remove, [key]); return value.call(real, key, ...rest); };
            return value.bind(real);
        },
    });
    return { store: observed(sqlite, false), guildWrites: () => guildWrites };
}

/**
 * The same fixture on a SQLite file in a temporary directory. `query` answers the statements
 * the tests use to arrange and inspect stored data; `control.failQuery` works as on PostgreSQL.
 */
async function createSQLiteFixture(t, leveling = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-fixture-sqlite-'));
    const sqlite = await openSQLiteStore({ path: join(dir, 'data.db') });
    const config = { leveling: { enabled: true, configured: true, announceLevelUp: false, roleRewards: {}, ...leveling } };
    const configKey = `guild:${guildId}:config`;
    sqlite.transaction((tx) => tx.botSet(configKey, config));

    const control = { failQuery: null, delayQuery: null };
    const observing = observeSQLite(sqlite, control);

    const previous = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType };
    const adapter = createSQLiteBotDatabase(observing.store);
    // Tests switch the database off with `isConnected = false`, as they do on PostgreSQL.
    const available = adapter.isAvailable.bind(adapter);
    adapter.isConnected = true;
    adapter.isAvailable = () => adapter.isConnected !== false && available();
    Object.assign(db, { db: adapter, initialized: true, useFallback: false, connectionType: 'sqlite' });
    // A PostgreSQL connection keeps the process alive while a test waits on unreferenced timers; so does this.
    const alive = setInterval(() => {}, 1000);
    t.after(() => {
        clearInterval(alive);
        Object.assign(db, previous);
        sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const { hooks, given, roles, members, addRole, botRole, me, addMember, guild, client } = fakeDiscord();
    const levelKey = (userId) => `guild:${guildId}:leveling:users:${userId}`;
    const put = (key, value) => { sqlite.transaction((tx) => tx.botSet(key, value)); return { rows: [], rowCount: 1 }; };
    const one = (name, value) => ({ rows: value === null ? [] : [{ [name]: value }], rowCount: value === null ? 0 : 1 });
    /** Rows whose key matches a LIKE pattern, read straight from the file. */
    function rowsLike(pattern) {
        const file = new DatabaseSync(join(dir, 'data.db'), { readOnly: true });
        try {
            return file.prepare("SELECT key, value FROM zentix_bot_kv WHERE key LIKE ? ESCAPE '\\' AND expires_at IS NULL ORDER BY key").all(pattern)
                .map((row) => ({ key: row.key, value: JSON.parse(row.value) }))
                .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        } finally {
            file.close();
        }
    }
    /**
     * The few statements the feature tests use to arrange and inspect stored data, answered from
     * the SQLite file. Anything else is refused, so a test cannot pass on a statement that did nothing.
     */
    async function query(sql, params = []) {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (text === 'SELECT value FROM temp_data WHERE key = $1') return one('value', sqlite.botGet(params[0]));
        if (/^SELECT key(, value)? FROM temp_data WHERE key LIKE \$1( ORDER BY key)?$/.test(text)) {
            const rows = rowsLike(params[0]);
            return { rows: text.startsWith('SELECT key,') ? rows.map(({ key, value }) => ({ key, value })) : rows.map(({ key }) => ({ key })), rowCount: rows.length };
        }
        if (/^INSERT INTO temp_data \(key, value\) VALUES \(\$1, \$2::jsonb\)( ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value)?$/.test(text)) return put(params[0], JSON.parse(params[1]));
        if (text === 'UPDATE temp_data SET value = $2::jsonb WHERE key = $1') return put(params[0], JSON.parse(params[1]));
        if (text === 'SELECT config FROM guilds WHERE id = $1') return one('config', sqlite.botGet(`guild:${params[0]}:config`));
        // The column defaults to an empty list.
        if (text === 'SELECT counters FROM guilds WHERE id = $1') return one('counters', sqlite.botGet(`guild:${params[0]}:counters`) ?? []);
        if (text === 'SELECT updated_at FROM guilds WHERE id = $1') return one('updated_at', new Date(observing.guildWrites()));
        if (text === 'UPDATE guilds SET counters = $2::jsonb WHERE id = $1') return put(`guild:${params[0]}:counters`, JSON.parse(params[1]));
        if (text === 'INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING') return { rows: [], rowCount: 0 }; // SQLite keeps no user table
        if (text.startsWith('INSERT INTO economy(guild_id, user_id, balance, bank, data) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (guild_id, user_id) DO UPDATE')) {
            sqlite.transaction((tx) => tx.setAccount(params[0], params[1], JSON.parse(params[4])));
            return { rows: [], rowCount: 1 };
        }
        if (text === 'SELECT balance, bank, data FROM economy WHERE guild_id = $1 AND user_id = $2') {
            const data = sqlite.getAccount(params[0], params[1]);
            return data === null ? { rows: [], rowCount: 0 } : { rows: [{ balance: data.wallet, bank: data.bank, data }], rowCount: 1 };
        }
        if (text === 'UPDATE guilds SET config = $2::jsonb WHERE id = $1') return put(`guild:${params[0]}:config`, JSON.parse(params[1]));
        if (text === 'UPDATE guilds SET config = config || $2::jsonb WHERE id = $1'
            || text === 'INSERT INTO guilds (id, config) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET config = guilds.config || EXCLUDED.config') {
            return put(`guild:${params[0]}:config`, { ...(sqlite.botGet(`guild:${params[0]}:config`) ?? {}), ...JSON.parse(params[1]) });
        }
        throw Object.assign(new Error(`this statement is not available on the SQLite fixture: ${text}`), { code: 'SQLITE_FIXTURE_SQL' });
    }
    return {
        backend: 'sqlite', sqlite,
        client, guild, hooks, control, given, roles, members, me, botRole,
        addRole, addMember,
        setLevel: async (userId, level, extra = {}) => { sqlite.transaction((tx) => tx.botSet(levelKey(userId), { xp: extra.xp ?? 0, level, totalXp: extra.totalXp ?? 0, lastMessage: extra.lastMessage ?? 0 })); },
        readLevel: async (userId) => {
            const row = sqlite.botGet(levelKey(userId));
            return row ? { xp: Number(row.xp), level: Number(row.level), totalXp: Number(row.totalXp) } : null;
        },
        readLeveling: async () => sqlite.botGet(configKey).leveling,
        patchLeveling: async (patch) => { sqlite.transaction((tx) => { const current = tx.botGet(configKey); tx.botSet(configKey, { ...current, leveling: { ...current.leveling, ...patch } }); }); },
        startApi: apiStarter(t, client, guild),
        query,
        putRow: async (key, value) => { sqlite.transaction((tx) => tx.botSet(key, value)); },
        getRow: async (key) => sqlite.botGet(key),
        rolesOf: (userId) => [...members.get(userId).roles.cache.keys()].sort(),
    };
}

export async function createLevelingFixture(t, leveling = {}, { backend: backendName = defaultBackend } = {}) {
    if (backendName === 'sqlite') return createSQLiteFixture(t, leveling);
    const admin = new pg.Client(base);
    await admin.connect();
    const schema = `level_svc_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const statement of tableStatements) await admin.query(statement);

    const config = { leveling: { enabled: true, configured: true, announceLevelUp: false, roleRewards: {}, ...leveling } };
    await admin.query('INSERT INTO guilds(id, config) VALUES ($1, $2)', [guildId, JSON.stringify(config)]);

    const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 20 });
    const control = { failQuery: null, delayQuery: null };
    const realQuery = pool.query.bind(pool);
    const realConnect = pool.connect.bind(pool);
    const controlled = (run) => async (...args) => {
        const sql = String(args[0]?.text ?? args[0]);
        if (control.failQuery?.(sql)) throw new Error('injected database failure');
        const wait = control.delayQuery?.(sql, args[1] ?? args[0]?.values ?? []);
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        return run(...args);
    };
    pool.query = controlled(realQuery);
    // Transactions get a stand-in connection so their statements obey `control` too.
    // pg itself calls connect(callback) inside pool.query; that path stays untouched.
    pool.connect = (callback) => {
        if (callback) return realConnect(callback);
        return realConnect().then((conn) => ({
            query: controlled((...args) => conn.query(...args)),
            release: (...args) => conn.release(...args),
        }));
    };

    const backend = new PostgreSQLDatabase();
    backend.pool = pool;
    backend.isConnected = true;
    const previous = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType };
    Object.assign(db, { db: backend, initialized: true, useFallback: false, connectionType: 'postgresql' });

    t.after(async () => {
        Object.assign(db, previous);
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    const { hooks, given, roles, members, addRole, botRole, me, addMember, guild, client } = fakeDiscord();

    // ---- stored data --------------------------------------------------------
    async function setLevel(userId, level, extra = {}) {
        await realQuery('INSERT INTO users(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
        await realQuery(
            `INSERT INTO user_levels(guild_id, user_id, xp, level, total_xp, last_message)
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0)::timestamp)
             ON CONFLICT (guild_id, user_id) DO UPDATE
             SET xp = EXCLUDED.xp, level = EXCLUDED.level, total_xp = EXCLUDED.total_xp, last_message = EXCLUDED.last_message`,
            [guildId, userId, extra.xp ?? 0, level, extra.totalXp ?? 0, extra.lastMessage ?? 0],
        );
    }
    async function readLevel(userId) {
        const result = await realQuery('SELECT xp, level, total_xp FROM user_levels WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
        const row = result.rows[0];
        return row ? { xp: Number(row.xp), level: Number(row.level), totalXp: Number(row.total_xp) } : null;
    }
    async function readLeveling() {
        const result = await realQuery('SELECT config FROM guilds WHERE id = $1', [guildId]);
        return result.rows[0].config.leveling;
    }
    async function patchLeveling(patch) {
        const current = await readLeveling();
        const next = { ...(await realQuery('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config, leveling: { ...current, ...patch } };
        await realQuery('UPDATE guilds SET config = $2::jsonb WHERE id = $1', [guildId, JSON.stringify(next)]);
    }

    const startApi = apiStarter(t, client, guild);

    return {
        client, guild, hooks, control, given, roles, members, me, botRole,
        addRole, addMember, setLevel, readLevel, readLeveling, patchLeveling, startApi,
        backend: 'postgresql',
        // Direct SQL that ignores `control`, for arranging and inspecting stored data.
        query: realQuery,
        // One row of the key and value table, the same call on both backends.
        putRow: (key, value) => realQuery('INSERT INTO temp_data (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]),
        getRow: async (key) => (await realQuery('SELECT value FROM temp_data WHERE key = $1', [key])).rows[0]?.value ?? null,
        rolesOf: (userId) => [...members.get(userId).roles.cache.keys()].sort(),
    };
}
