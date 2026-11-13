import { randomBytes } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { PostgreSQLDatabase } from '../../src/utils/postgresDatabase.js';
import { db } from '../../src/utils/database/wrapper.js';
import { tableStatements } from '../../src/utils/database/schema.js';
import { discordError } from './fake-discord-guild.js';

export const pgEnabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
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
export async function createLevelingFixture(t, leveling = {}) {
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

    return {
        client, guild, hooks, control, given, roles, members, me, botRole,
        addRole, addMember, setLevel, readLevel, readLeveling, patchLeveling, startApi,
        rolesOf: (userId) => [...members.get(userId).roles.cache.keys()].sort(),
    };
}
