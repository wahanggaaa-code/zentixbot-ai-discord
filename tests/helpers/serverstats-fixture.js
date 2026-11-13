import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { createLevelingFixture, guildId, adminId, botId } from './leveling-postgres-fixture.js';
import { discordError, unknownChannel } from './fake-discord-guild.js';
import { counterRefresher } from '../../src/services/serverStats/refresh.js';

export { guildId, adminId, botId };
export const missingPermissions = () => discordError(403, 50013, 'Missing Permissions');
export const categoryId = '810000000000000001';

/**
 * The PostgreSQL fixture plus the Discord parts server stats use: channels that
 * can be created, renamed, fetched and deleted, a member list with bots, and
 * the bot's permissions per channel.
 *
 * `hooks` run before the Discord call takes effect and may throw or wait:
 *   hooks.createChannel(options)   hooks.rename(channel, name)
 *   hooks.deleteChannel(channel)   hooks.fetchChannel(id)   hooks.fetchMembers()
 * `calls` records what was asked of Discord.
 * Text channels get their name changed the way this fake assumes Discord does
 * it (lower case, spaces to dashes); the real rules were not checked.
 */
export async function createServerStatsFixture(t, { humans = 3, bots = 1 } = {}) {
    const fx = await createLevelingFixture(t);
    // Channel ids repeat from test to test; what the bot's refresher remembers about them must not.
    counterRefresher.reset();
    t.after(() => counterRefresher.reset());
    const { guild, hooks } = fx;
    const channels = guild.channels.cache;
    const calls = { create: [], rename: [], delete: [], fetchMembers: 0, fetchChannel: [] };
    let nextChannel = 820000000000000000n;

    const botPermissions = new Map();
    /** Permissions of the bot in a channel (default: everything). */
    const setBotPermissions = (channelId, flags) => botPermissions.set(channelId, new PermissionsBitField(flags.map((flag) => PermissionFlagsBits[flag])));
    const everything = new PermissionsBitField(PermissionsBitField.All);

    function makeChannel({ id = String(nextChannel++), name, type, parentId = null }) {
        const channel = {
            id,
            guild,
            type,
            parentId,
            name: type === ChannelType.GuildText ? textName(name) : name,
            toString: () => `<#${id}>`,
            permissionsFor: () => botPermissions.get(id) ?? botPermissions.get(parentId) ?? everything,
            async setName(next, reason) {
                calls.rename.push({ id, name: next, reason });
                await hooks.rename?.(channel, next);
                channel.name = type === ChannelType.GuildText ? textName(next) : next;
                return channel;
            },
            async delete(reason) {
                calls.delete.push({ id, reason });
                await hooks.deleteChannel?.(channel);
                if (!channels.has(id)) throw unknownChannel();
                channels.delete(id);
                await fx.onChannelDelete?.(channel);
                return channel;
            },
        };
        channels.set(id, channel);
        return channel;
    }

    const category = makeChannel({ id: categoryId, name: 'Stats', type: ChannelType.GuildCategory });

    guild.channels.create = async (options) => {
        calls.create.push(options);
        await hooks.createChannel?.(options);
        return makeChannel({ name: options.name, type: options.type, parentId: options.parent ?? null });
    };
    guild.channels.fetch = async (id) => {
        calls.fetchChannel.push(id);
        await hooks.fetchChannel?.(id);
        const found = channels.get(id);
        if (!found) throw unknownChannel();
        return found;
    };

    // ---- members ------------------------------------------------------------
    const people = new Collection();
    const addPerson = (id, bot = false) => {
        people.set(id, { id, user: { id, bot, tag: `user${id.slice(-3)}` } });
        guild.memberCount = people.size;
    };
    const removePerson = (id) => {
        people.delete(id);
        guild.memberCount = people.size;
    };
    for (let n = 0; n < humans; n++) addPerson(String(710000000000000000n + BigInt(n)));
    for (let n = 0; n < bots; n++) addPerson(String(720000000000000000n + BigInt(n)), true);

    guild.members.cache = people;
    const fetchOne = guild.members.fetch;
    guild.members.fetch = async (query) => {
        // No user in the query: the whole member list, as discord.js does.
        if (typeof query === 'string' || query?.user) return fetchOne(query);
        calls.fetchOptions = query;
        calls.fetchMembers += 1;
        await hooks.fetchMembers?.();
        return people;
    };
    guild.members.me.permissionsIn = (channel) => channel.permissionsFor();
    guild.members.me.permissions = everything;

    const admin = {
        id: adminId,
        user: { id: adminId, tag: 'admin#0001', username: 'admin' },
        permissions: new PermissionsBitField([PermissionFlagsBits.ManageChannels]),
    };

    /** A slash command or button interaction that records every reply. */
    function interaction(options = {}, { member = admin, customId = null } = {}) {
        const replies = [];
        const it = {
            id: '910000000000000001',
            user: { ...member.user, displayAvatarURL: () => 'https://example.invalid/a.png' },
            member,
            guild,
            guildId,
            customId,
            client: fx.client,
            deferred: false,
            replied: false,
            createdTimestamp: Date.now(),
            inGuild: () => true,
            isChatInputCommand: () => customId === null,
            isButton: () => customId !== null,
            options: {
                getString: (name) => options[name] ?? null,
                getChannel: (name) => options[name] ?? null,
                getSubcommand: () => options.subcommand ?? null,
            },
            deferReply: async () => { it.deferred = true; },
            deferUpdate: async () => { it.deferred = true; },
            editReply: async (payload) => { replies.push(payload); },
            reply: async (payload) => { replies.push(payload); it.replied = true; },
            followUp: async (payload) => { replies.push(payload); },
        };
        const text = () => replies.flatMap((payload) => payload.embeds ?? []).map((embed) => embed?.data ?? embed).map((embed) => [
            embed.title, embed.description, ...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`), embed.footer?.text,
        ].join('\n')).join('\n');
        const buttons = () => replies.flatMap((payload) => payload.components ?? [])
            .flatMap((row) => row.components ?? []).map((button) => button.data?.custom_id ?? button.customId);
        return { it, text, buttons, replies };
    }

    const stored = async () => (await fx.query('SELECT counters FROM guilds WHERE id = $1', [guildId])).rows[0]?.counters;
    const store = (value) => fx.query('UPDATE guilds SET counters = $2::jsonb WHERE id = $1', [guildId, JSON.stringify(value)]);

    return {
        ...fx, calls, category, admin, channels, makeChannel, setBotPermissions,
        addPerson, removePerson, interaction, stored, store,
    };
}

function textName(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
