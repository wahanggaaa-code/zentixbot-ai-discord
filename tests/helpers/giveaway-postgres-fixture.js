import { randomBytes } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { PostgreSQLDatabase } from '../../src/utils/postgresDatabase.js';
import { createGiveawayApi } from '../../src/dashboard/giveawayApi.js';
import { createDashboardRouter } from '../../src/dashboard/router.js';
import { discordError, unknownChannel } from './fake-discord-guild.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSQLiteStore } from '../../src/services/storage/sqlite.js';
import { createSQLiteBotDatabase } from '../../src/services/storage/sqliteBotDatabase.js';

// `ZENTIX_TEST_BACKEND=sqlite` runs the same suite on a SQLite file (see tests/sqlite-feature-suites.test.js).
export const onSQLite = process.env.ZENTIX_TEST_BACKEND === 'sqlite';
export const pgEnabled = onSQLite || process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
export const guildId = '123456789012345678';
export const channelId = '423456789012345678';
export const voiceId = '433456789012345678';
export const botId = '523456789012345678';
export const adminId = '323456789012345678';
export const clientId = '456789012345678901';
export const strangerId = '623456789012345678';
export const entrant = (n) => String(700000000000000000n + BigInt(n));
export const unknownMessage = () => discordError(404, 10008, 'Unknown Message');
export const missingPermissions = () => discordError(403, 50013, 'Missing Permissions');
export const hasCode = (code) => (error) => error.code === code;

const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };

/** The PostgreSQL side of the fixture: an isolated schema, dropped after the test. */
async function postgresStorage(t) {
    const admin = new pg.Client(base);
    await admin.connect();
    const schema = `gw_manage_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
        CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY, config jsonb DEFAULT '{}');
        CREATE TABLE "${schema}".giveaways(
            id serial PRIMARY KEY, guild_id varchar(20), message_id varchar(20), data jsonb,
            ends_at timestamp, updated_at timestamp DEFAULT now(), UNIQUE(guild_id, message_id));
        CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY, value jsonb, expires_at timestamp);
        CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY, value jsonb, expires_at timestamp)`);
    const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 40 });
    t.after(async () => {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    });

    // Lets a test make a COMMIT succeed in the database while the caller sees an error.
    const realConnect = pool.connect.bind(pool);
    const lost = { commits: 0 };
    pool.connect = async (callback) => {
        if (callback) return realConnect(callback);
        const conn = await realConnect();
        if (lost.commits <= 0) return conn;
        const query = conn.query.bind(conn);
        const release = conn.release.bind(conn);
        const restore = () => {
            delete conn.query;
            delete conn.release;
        };
        conn.release = (...args) => {
            restore();
            return release(...args);
        };
        conn.query = async (...args) => {
            const result = await query(...args);
            if (args[0] === 'COMMIT' && lost.commits > 0) {
                lost.commits--;
                throw new Error('connection lost after commit');
            }
            return result;
        };
        return conn;
    };

    const backend = new PostgreSQLDatabase();
    backend.pool = pool;
    backend.isConnected = true;

    const rows = async () => (await pool.query(
        'SELECT message_id, data FROM giveaways WHERE guild_id=$1 ORDER BY id', [guildId],
    )).rows;
    const read = async (messageId) => (await pool.query(
        'SELECT data FROM giveaways WHERE guild_id=$1 AND message_id=$2', [guildId, messageId],
    )).rows[0]?.data ?? null;
    const ageDelivery = (messageId, ms = 10 * 60_000) => pool.query(
        `UPDATE giveaways SET data = jsonb_set(data, '{deliveryClaimedAt}', to_jsonb((data->>'deliveryClaimedAt')::bigint - $3::bigint))
         WHERE guild_id=$1 AND message_id=$2`,
        [guildId, messageId, ms],
    );
    return { connectionType: 'postgresql', pool, backend, lost, rows, read, ageDelivery };
}

/**
 * The SQLite side: a file in a temporary folder. All giveaways of the server are one row,
 * an object from message id to giveaway. `pool` and `lost` are PostgreSQL tools; the tests
 * that need them are PostgreSQL only.
 */
async function sqliteStorage(t) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-giveaway-sqlite-'));
    const file = join(dir, 'data.db');
    const sqlite = await openSQLiteStore({ path: file });
    const backend = createSQLiteBotDatabase(sqlite);
    // Tests switch the database off with `isConnected = false`, as they do on PostgreSQL.
    const available = backend.isAvailable.bind(backend);
    backend.isConnected = true;
    backend.isAvailable = () => backend.isConnected !== false && available();
    const raw = new DatabaseSync(file);
    t.after(() => {
        raw.close();
        if (sqlite.isOpen()) sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const key = `guild:${guildId}:giveaways`;
    const map = () => {
        const row = raw.prepare('SELECT value FROM zentix_bot_kv WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : {};
    };
    const rows = async () => Object.entries(map()).map(([message_id, data]) => ({ message_id, data }));
    const read = async (messageId) => map()[messageId] ?? null;
    const ageDelivery = async (messageId, ms = 10 * 60_000) => {
        const all = map();
        all[messageId].deliveryClaimedAt -= ms;
        raw.prepare('UPDATE zentix_bot_kv SET value=? WHERE key=?').run(JSON.stringify(all), key);
    };
    const store = (all) => raw.prepare('UPDATE zentix_bot_kv SET value=? WHERE key=?').run(JSON.stringify(all), key);
    const change = (messageId, edit) => { const all = map(); edit(all[messageId]); store(all); };
    const realEnd = new Map();
    // The statements the suite uses to arrange stored data, done to the one row SQLite keeps.
    const statements = {
        // A write the database refuses.
        "ALTER TABLE giveaways ADD CONSTRAINT refuse CHECK (data->>'prize' <> 'Blocked')": () => raw.exec(`
            CREATE TRIGGER refuse_insert BEFORE INSERT ON zentix_bot_kv WHEN NEW.value LIKE '%"prize":"Blocked"%' BEGIN SELECT RAISE(ABORT, 'refused'); END;
            CREATE TRIGGER refuse_update BEFORE UPDATE ON zentix_bot_kv WHEN NEW.value LIKE '%"prize":"Blocked"%' BEGIN SELECT RAISE(ABORT, 'refused'); END;`),
        // The giveaway looks overdue, and later gets its real end back.
        "UPDATE giveaways SET ends_at = now() - interval '1 day' WHERE message_id=$1": ([messageId]) => change(messageId, (data) => {
            realEnd.set(messageId, data.endsAt);
            const past = Date.now() - 86_400_000;
            data.endsAt = typeof data.endsAt === 'number' ? past : new Date(past).toISOString();
        }),
        "UPDATE giveaways SET ends_at = to_timestamp((data->>'endsAt')::double precision/1000) AT TIME ZONE 'UTC' WHERE message_id=$1": ([messageId]) => change(messageId, (data) => { data.endsAt = realEnd.get(messageId); }),
        "UPDATE giveaways SET data = (data - 'deliveryClaimedAt') || '{\"endedAt\":\"2020-01-01T00:00:00.000Z\"}' WHERE message_id=$1": ([messageId]) => change(messageId, (data) => {
            delete data.deliveryClaimedAt;
            data.endedAt = '2020-01-01T00:00:00.000Z';
        }),
    };
    const pool = {
        async query(sql, params = []) {
            const run = statements[String(sql).replace(/\s+/g, ' ').trim()];
            if (!run) throw Object.assign(new Error(`this statement is not available on the SQLite fixture: ${sql}`), { code: 'SQLITE_FIXTURE_SQL' });
            run(params);
            return { rows: [] };
        },
    };
    return { connectionType: 'sqlite', pool, backend, lost: { commits: 0 }, rows, read, ageDelivery, sqlite, raw };
}

/**
 * PostgreSQL schema, a fake Discord text channel that keeps its messages, and
 * the giveaway API mounted twice: with test auth headers, and behind the real
 * dashboard router.
 *
 * `hooks` are awaited before the matching Discord call takes effect, so a
 * test can make it fail or do something at that exact moment:
 *   hooks.send(payload)  hooks.afterSend(message)  hooks.fetch(id)
 *   hooks.edit(message)  hooks.delete(message)     hooks.afterDelete(message)
 *   hooks.channelFetch(id)
 */
export async function createGiveawayFixture(t) {
    const storage = onSQLite ? await sqliteStorage(t) : await postgresStorage(t);
    const { pool, backend, lost, rows, read, ageDelivery } = storage;

    // ---- Discord ----------------------------------------------------------
    const hooks = {};
    const messages = new Map();
    const log = [];
    let nextId = 800000000000000000n;
    const addMessage = (payload, authorId = botId) => {
        const id = String(++nextId);
        const message = {
            id,
            author: { id: authorId },
            payload,
            edit: async (next) => {
                await hooks.edit?.(message, next);
                if (!messages.has(id)) throw unknownMessage();
                message.payload = next;
                log.push(['edit', id]);
                return message;
            },
            delete: async () => {
                await hooks.delete?.(message);
                if (!messages.has(id)) throw unknownMessage();
                messages.delete(id);
                log.push(['delete', id]);
                await hooks.afterDelete?.(message);
            },
        };
        messages.set(id, message);
        return message;
    };
    const permissions = { allowed: true };
    const channel = {
        id: channelId,
        guildId,
        name: 'giveaways',
        type: ChannelType.GuildText,
        rawPosition: 1,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => permissions.allowed }),
        send: async (payload) => {
            await hooks.send?.(payload);
            const message = addMessage(payload);
            log.push(['send', message.id]);
            await hooks.afterSend?.(message);
            return message;
        },
        messages: {
            fetch: async (id) => {
                await hooks.fetch?.(id);
                const message = messages.get(id);
                if (!message) throw unknownMessage();
                return message;
            },
        },
    };
    const voice = {
        id: voiceId,
        guildId,
        name: 'Lounge',
        type: ChannelType.GuildVoice,
        rawPosition: 2,
        permissionsFor: () => ({ has: () => true }),
    };
    const channels = new Map([[channelId, channel], [voiceId, voice]]);
    const guild = {
        id: guildId,
        name: 'Home',
        ownerId: '999999999999999999',
        channels: {
            cache: channels,
            fetch: async (id) => {
                await hooks.channelFetch?.(id);
                const found = channels.get(id);
                if (!found) throw unknownChannel();
                return found;
            },
        },
        members: {
            me: { id: botId },
            fetch: async () => ({ id: adminId, permissions: { has: (p) => p === PermissionFlagsBits.Administrator } }),
        },
    };
    const client = {
        homeGuildId: guildId,
        isReady: () => true,
        user: { id: botId },
        guilds: { cache: new Map([[guildId, guild]]) },
        db: {
            db: backend,
            getStatus: () => ({ connectionType: storage.connectionType, isDegraded: false }),
            isAvailable: () => Boolean(backend.isAvailable()),
            get: (...args) => backend.get(...args),
            set: (...args) => backend.set(...args),
            delete: (...args) => backend.delete(...args),
        },
    };

    // ---- HTTP -------------------------------------------------------------
    const audits = [];
    const audit = async (...args) => {
        audits.push(args.slice(1));
    };
    const auth = (req, res, next) => {
        if (req.get('x-auth') !== 'yes') return res.sendStatus(401);
        req.guild = guild;
        req.session = { user: { id: adminId } };
        next();
    };
    const csrf = (req, res, next) => (req.get('x-csrf') === 'yes' ? next() : res.sendStatus(403));
    const app = express();
    app.use('/test', createGiveawayApi(client, { auth, csrf, audit }));
    const oauth = async (url) => ({
        ok: true,
        json: async () => (String(url).endsWith('/token')
            ? { access_token: 'mock', expires_in: 3600 }
            : { id: adminId, username: 'tester' }),
    });
    app.use('/dashboard', createDashboardRouter(client, {
        fetchImpl: oauth,
        env: { CLIENT_ID: clientId, DISCORD_CLIENT_SECRET: 'fake', DASHBOARD_URL: 'http://localhost:9999' },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const call = async (path, method = 'GET', body, headers = {}) => {
        const response = await fetch(`${baseUrl}/test/giveaway/${path}`, {
            method,
            headers: { 'x-auth': 'yes', 'x-csrf': 'yes', 'content-type': 'application/json', ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch { /* sendStatus replies are not JSON */ }
        return { status: response.status, body: json, headers: response.headers };
    };

    // ---- Shortcuts --------------------------------------------------------
    const prepare = async (messageId) => (await call(`prepare?messageId=${messageId}`)).body;
    /** Prepare, then act with the fresh revision: what the page does after the confirm dialog. */
    const act = async (messageId, action) => {
        const fresh = await prepare(messageId);
        return call('action', 'POST', { messageId, action, revision: fresh.revision, confirmed: true });
    };
    const sent = () => log.filter(([kind]) => kind === 'send').map(([, id]) => id);

    return {
        pool, backend, client, guild, channel, channels, messages, hooks, log, lost, permissions,
        audits, baseUrl, call, rows, read, prepare, act, ageDelivery, sent, addMessage,
    };
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
