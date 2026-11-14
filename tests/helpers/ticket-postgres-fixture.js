import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ChannelType, Collection } from 'discord.js';
import { PostgreSQLDatabase } from '../../src/utils/postgresDatabase.js';
import { db } from '../../src/utils/database/wrapper.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLiteStore } from '../../src/services/storage/sqlite.js';
import { createSQLiteBotDatabase } from '../../src/services/storage/sqliteBotDatabase.js';
import { observeSQLite } from './leveling-postgres-fixture.js';
import { discordError, unknownChannel } from './fake-discord-guild.js';

// `ZENTIX_TEST_BACKEND=sqlite` runs the same suite on a SQLite file (see tests/sqlite-feature-suites.test.js).
export const onSQLite = process.env.ZENTIX_TEST_BACKEND === 'sqlite';
export const pgEnabled = onSQLite || process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
export const guildId = '123456789012345678';
export const botId = '523456789012345678';
export const staffId = '323456789012345678';
export const otherStaffId = '333456789012345678';
export const transcriptChannelId = '443456789012345678';
export const member = (n) => String(700000000000000000n + BigInt(n));
export const unknownMessage = () => discordError(404, 10008, 'Unknown Message');
export const ticketCode = (code) => (error) => error?.context?.ticketCode === code;

const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };
const plainEmbed = (embed) => structuredClone(embed?.data ?? embed);
const plainRow = (row) => ({
    components: row.components.map((button) => {
        const data = button.data ?? button;
        return { customId: data.custom_id ?? data.customId, disabled: data.disabled === true, label: data.label };
    }),
});

/** The PostgreSQL side of the fixture: an isolated schema with the ticket tables, dropped after the test. */
async function postgresStorage(t, config) {
    const admin = new pg.Client(base);
    await admin.connect();
    const schema = `ticket_svc_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`
        CREATE TABLE "${schema}".guilds(
            id varchar(20) PRIMARY KEY, config jsonb DEFAULT '{}',
            created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());
        CREATE TABLE "${schema}".ticket_data(
            guild_id varchar(20) REFERENCES "${schema}".guilds(id), channel_id varchar(20) PRIMARY KEY,
            data jsonb NOT NULL, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now(),
            expires_at timestamp);
        CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz)`);
    await admin.query(`INSERT INTO "${schema}".guilds(id, config) VALUES ($1, $2)`, [guildId, JSON.stringify(config)]);
    const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}`, max: 20 });

    const control = { failQuery: null };
    const realQuery = pool.query.bind(pool);
    pool.query = (...args) => {
        if (control.failQuery?.(String(args[0]))) return Promise.reject(new Error('injected database failure'));
        return realQuery(...args);
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

    const record = async (channelId) => {
        const rows = await realQuery('SELECT data FROM ticket_data WHERE channel_id=$1', [channelId]);
        return rows.rows[0]?.data ?? null;
    };
    const records = async () => (await realQuery('SELECT data FROM ticket_data ORDER BY channel_id')).rows.map((r) => r.data);
    const insertRecord = (channelId, data) => realQuery(
        'INSERT INTO ticket_data(guild_id, channel_id, data) VALUES ($1,$2,$3)',
        [guildId, channelId, JSON.stringify(data)],
    );
    const setConfig = (next) => realQuery('UPDATE guilds SET config=$2 WHERE id=$1', [guildId, JSON.stringify(next)]);
    return { pool, control, record, records, insertRecord, setConfig };
}

/** The SQLite side: a file in a temporary folder, one row per ticket and one for the settings. */
async function sqliteStorage(t, config) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-ticket-sqlite-'));
    const sqlite = await openSQLiteStore({ path: join(dir, 'data.db') });
    const configKey = `guild:${guildId}:config`;
    const ticketKey = (channelId) => `guild:${guildId}:ticket:${channelId}`;
    sqlite.transaction((tx) => tx.botSet(configKey, config));

    const control = { failQuery: null };
    const previous = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType };
    Object.assign(db, { db: createSQLiteBotDatabase(observeSQLite(sqlite, control).store), initialized: true, useFallback: false, connectionType: 'sqlite' });
    t.after(() => {
        Object.assign(db, previous);
        sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const record = async (channelId) => sqlite.botGet(ticketKey(channelId));
    const records = async () => sqlite.botRows(`guild:${guildId}:ticket:`)
        .filter((row) => /:ticket:\d+$/.test(row.key))
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map((row) => row.value);
    const insertRecord = async (channelId, data) => { sqlite.transaction((tx) => tx.botSet(ticketKey(channelId), data)); };
    const setConfig = async (next) => { sqlite.transaction((tx) => tx.botSet(configKey, next)); };
    const pool = {
        async query(sql, params = []) {
            if (sql === 'DELETE FROM ticket_data WHERE channel_id=$1') {
                sqlite.transaction((tx) => tx.botDelete(ticketKey(params[0])));
                return { rows: [] };
            }
            throw Object.assign(new Error(`this statement is not available on the SQLite fixture: ${sql}`), { code: 'SQLITE_FIXTURE_SQL' });
        },
    };
    return { pool, control, record, records, insertRecord, setConfig };
}

/**
 * A PostgreSQL schema with the ticket tables and an in-memory Discord guild
 * that keeps channels, messages, permission overwrites and direct messages.
 *
 * `hooks` are awaited before the matching Discord call takes effect:
 *   hooks.createChannel(options)  hooks.send(channel, payload)
 *   hooks.deleteChannel(channel)  hooks.dm(userId, payload)
 *   hooks.fetchChannel(id)        hooks.transcript(payload)
 * `failQuery` is a function (sql) => boolean; a matching query is rejected once per `true`.
 */
export async function createTicketFixture(t, config = {}) {
    const { pool, control, record, records, insertRecord, setConfig } = onSQLite ? await sqliteStorage(t, config) : await postgresStorage(t, config);

    // ---- Discord ------------------------------------------------------------
    const hooks = {};
    const log = [];
    const dms = [];
    const transcripts = [];
    const channels = new Collection();
    let nextId = 800000000000000000n;
    const newId = () => String(++nextId);

    const users = new Map();
    const userOf = (id) => {
        if (!users.has(id)) {
            users.set(id, {
                id,
                tag: `user${id.slice(-3)}`,
                username: `user${id.slice(-3)}`,
                toString: () => `<@${id}>`,
                send: async (payload) => {
                    await hooks.dm?.(id, payload);
                    dms.push({ userId: id, payload });
                },
            });
        }
        return users.get(id);
    };

    const client = {
        db,
        user: { id: botId },
        guilds: { cache: new Map(), fetch: async () => guild },
        users: { fetch: async (id) => userOf(id) },
        channels: {
            fetch: async (id) => {
                if (id === transcriptChannelId && transcriptChannel.exists) return transcriptChannel;
                const channel = channels.get(id);
                if (!channel) throw unknownChannel();
                return channel;
            },
        },
    };
    const transcriptChannel = {
        id: transcriptChannelId,
        exists: true,
        isSendable: () => true,
        send: async (payload) => {
            await hooks.transcript?.(payload);
            transcripts.push(payload);
            log.push(['transcript']);
        },
    };

    function addChannel({ name, type = ChannelType.GuildText, parentId = null, overwrites = [], id = newId() }) {
        const messages = [];
        const overwriteCache = new Collection();
        const setOverwrite = (targetId, change) => {
            const entry = overwriteCache.get(targetId) ?? {
                id: targetId,
                changes: [],
                edit: async (next) => setOverwrite(targetId, next),
            };
            entry.changes.push(change);
            overwriteCache.set(targetId, entry);
            return entry;
        };
        for (const overwrite of overwrites) setOverwrite(overwrite.id, { allow: overwrite.allow, deny: overwrite.deny });

        const addMessage = (payload, author = { id: botId, tag: 'ZentixBot' }) => {
            const message = {
                id: newId(),
                author,
                createdTimestamp: Date.now() + messages.length,
                content: payload.content ?? '',
                embeds: (payload.embeds ?? []).map(plainEmbed),
                components: (payload.components ?? []).map(plainRow),
                files: payload.files ?? [],
                pinned: false,
                edit: async (next) => {
                    if (!messages.includes(message)) throw unknownMessage();
                    if (next.embeds) message.embeds = next.embeds.map(plainEmbed);
                    if (next.components) message.components = next.components.map(plainRow);
                    log.push(['edit', channel.id, message.id]);
                    return message;
                },
                pin: async () => {
                    message.pinned = true;
                },
            };
            messages.push(message);
            return message;
        };

        const channel = {
            id,
            name,
            type,
            parentId,
            client,
            guild,
            messageList: messages,
            addMessage,
            toString: () => `<#${id}>`,
            permissionOverwrites: {
                cache: overwriteCache,
                create: async (target, change) => setOverwrite(target.id, change),
            },
            messages: {
                fetch: async (query) => {
                    if (typeof query === 'string') {
                        const found = messages.find((m) => m.id === query);
                        if (!found) throw unknownMessage();
                        return found;
                    }
                    // Like Discord: newest first, one page of at most `limit` messages.
                    const limit = query?.limit ?? 50;
                    let page = [...messages].reverse();
                    if (query?.before) page = page.slice(page.findIndex((m) => m.id === query.before) + 1);
                    return new Collection(page.slice(0, limit).map((m) => [m.id, m]));
                },
            },
            send: async (payload) => {
                await hooks.send?.(channel, payload);
                if (!channels.has(id)) throw unknownChannel();
                const message = addMessage(payload);
                log.push(['send', id, message.embeds[0]?.title ?? null]);
                return message;
            },
            delete: async () => {
                await hooks.deleteChannel?.(channel);
                if (!channels.has(id)) throw unknownChannel();
                channels.delete(id);
                log.push(['deleteChannel', id]);
            },
            setName: async (next) => {
                channel.name = next;
            },
            setParent: async (next) => {
                channel.parentId = next;
            },
        };
        channels.set(id, channel);
        return channel;
    }

    const guild = {
        id: guildId,
        name: 'Home',
        client,
        channels: {
            cache: channels,
            create: async (options) => {
                await hooks.createChannel?.(options);
                const channel = addChannel({
                    name: options.name,
                    type: options.type,
                    parentId: options.parent ?? null,
                    overwrites: options.permissionOverwrites ?? [],
                });
                log.push(['createChannel', channel.id, options.type]);
                return channel;
            },
            fetch: async (id) => {
                await hooks.fetchChannel?.(id);
                const channel = channels.get(id);
                if (!channel) throw unknownChannel();
                return channel;
            },
        },
        members: {
            me: { id: botId },
            fetch: async (id) => ({ id, user: userOf(id) }),
        },
    };
    client.guilds.cache.set(guildId, guild);

    const memberOf = (id, { manageChannels = false } = {}) => ({
        id,
        user: userOf(id),
        username: userOf(id).username,
        toString: () => `<@${id}>`,
        permissions: { has: () => manageChannels },
    });
    const textChannels = () => [...channels.values()].filter((c) => c.type === ChannelType.GuildText);

    return {
        pool, client, guild, channels, hooks, control, log, dms, transcripts, transcriptChannel,
        addChannel, userOf, memberOf, record, records, insertRecord, setConfig, textChannels, newId,
    };
}
