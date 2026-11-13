import { ChannelType, Collection, OverwriteType, PermissionsBitField } from 'discord.js';

/**
 * Minimal in-memory Discord guild for Join to Create tests: voice channels,
 * members with voice state, permission overwrites and injectable failures.
 * It imitates only what the runtime uses.
 */

export const discordError = (status, code, message = 'Discord error') => Object.assign(new Error(message), { status, code, name: 'DiscordAPIError' });
export const unknownChannel = () => discordError(404, 10003, 'Unknown Channel');

export function createFakeGuild({ id, botId = '900000000000000001', maximumBitrate = 96000 } = {}) {
    let nextId = 500000000000000000n;
    const channels = new Collection();
    const members = new Collection();
    const calls = { create: [], delete: [], move: [], overwriteEdit: [], overwriteDelete: [], rename: [], fetchAll: 0, fetchOne: [], dm: [] };
    /** Replace any of these to inject failures. */
    const hooks = {
        create: null,          // async (options, makeChannel) => channel
        delete: null,          // async (channel, remove) => void
        move: null,            // async (member, channel, apply) => void
        fetchAll: null,        // async () => Collection
        rename: null,          // async (channel, name) => void
        onVoiceChange: null,   // (oldState, newState) => void   (gateway echo of bot-initiated moves)
    };

    const guild = {
        id,
        name: 'Home',
        maximumBitrate,
        members: { me: { id: botId }, cache: members },
        channels: {
            cache: channels,
            async fetch(channelId, options) {
                if (channelId === undefined) {
                    calls.fetchAll += 1;
                    if (hooks.fetchAll) return hooks.fetchAll();
                    return channels.clone();
                }
                calls.fetchOne.push(channelId);
                const channel = channels.get(channelId);
                if (!channel) throw unknownChannel();
                return channel;
            },
            async create(options) {
                calls.create.push(options);
                const make = () => addChannel({
                    type: options.type,
                    name: options.name,
                    parentId: options.parent ?? null,
                    userLimit: options.userLimit ?? 0,
                    bitrate: options.bitrate,
                    overwrites: options.permissionOverwrites ?? [],
                });
                return hooks.create ? hooks.create(options, make) : make();
            },
        },
    };

    function addChannel({ type = ChannelType.GuildVoice, name = 'channel', parentId = null, overwrites = [], createdTimestamp = Date.now(), channelId, userLimit = 0, bitrate = 64000 } = {}) {
        const channel = {
            id: channelId ?? String(nextId++),
            type,
            name,
            parentId,
            userLimit,
            bitrate,
            guild,
            guildId: id,
            createdTimestamp,
            get parent() { return parentId ? channels.get(parentId) ?? null : null; },
            get members() { return members.filter((member) => member.voice.channelId === channel.id); },
            permissionsFor: () => ({ has: () => channel.botHasPermissions !== false }),
            permissionOverwrites: {
                cache: new Collection(),
                async edit(target, permissions, options) {
                    const targetId = typeof target === 'string' ? target : target.id;
                    calls.overwriteEdit.push({ channelId: channel.id, targetId, permissions, options });
                    channel.permissionOverwrites.cache.set(targetId, { id: targetId, type: OverwriteType.Member, allow: new PermissionsBitField(), deny: new PermissionsBitField(), edited: permissions });
                },
                async delete(target, reason) {
                    const targetId = typeof target === 'string' ? target : target.id;
                    calls.overwriteDelete.push({ channelId: channel.id, targetId, reason });
                    channel.permissionOverwrites.cache.delete(targetId);
                },
            },
            async delete(reason) {
                calls.delete.push({ channelId: channel.id, reason });
                const remove = () => {
                    if (!channels.has(channel.id)) throw unknownChannel();
                    channels.delete(channel.id);
                    for (const member of channel.members.values()) member.voice.channelId = null;
                };
                return hooks.delete ? hooks.delete(channel, remove) : remove();
            },
            async setName(name, reason) {
                calls.rename.push({ channelId: channel.id, name, reason });
                if (hooks.rename) return hooks.rename(channel, name);
                channel.name = name;
                return channel;
            },
        };
        for (const overwrite of overwrites) {
            channel.permissionOverwrites.cache.set(overwrite.id, {
                id: overwrite.id,
                type: overwrite.type ?? OverwriteType.Role,
                allow: new PermissionsBitField(overwrite.allow ?? 0n),
                deny: new PermissionsBitField(overwrite.deny ?? 0n),
            });
        }
        channels.set(channel.id, channel);
        return channel;
    }

    function addMember(memberId, { bot = false, username = `user${memberId.slice(-3)}`, displayName } = {}) {
        const member = {
            id: memberId,
            user: { id: memberId, bot, username, tag: `${username}#0001` },
            displayName: displayName ?? username,
            guild,
            async send(payload) { calls.dm.push({ memberId, payload }); },
            voice: {
                channelId: null,
                get channel() { return member.voice.channelId ? channels.get(member.voice.channelId) ?? null : null; },
                async setChannel(channel, reason) {
                    calls.move.push({ memberId, channelId: channel.id, reason });
                    const apply = () => {
                        if (!channels.has(channel.id)) throw unknownChannel();
                        if (member.voice.channelId === null) throw discordError(400, 40032, 'Target user is not connected to voice.');
                        const states = voiceStates(member, channel.id);
                        hooks.onVoiceChange?.(states.oldState, states.newState);
                    };
                    return hooks.move ? hooks.move(member, channel, apply) : apply();
                },
            },
        };
        members.set(memberId, member);
        return member;
    }

    /** Apply a voice change and return the (oldState, newState) pair the gateway would emit. */
    function voiceStates(member, channelId) {
        const oldState = { channelId: member.voice.channelId, guild, member };
        member.voice.channelId = channelId;
        return { oldState, newState: { channelId, guild, member } };
    }

    return { guild, channels, members, calls, hooks, addChannel, addMember, voiceStates };
}
