import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { logger } from '../utils/logger.js';
import { formatChannelName } from '../utils/joinToCreateTemplate.js';
import {
    readJoinToCreateState,
    setupJoinToCreate,
    updateJoinToCreate,
    removeJoinToCreateTrigger,
    transferJoinToCreateOwner,
    unregisterJoinToCreateChannelIfPresent,
    reserveJoinToCreate,
    completeJoinToCreate,
    cancelJoinToCreatePending,
} from './storage/postgresJoinToCreateTransactions.js';

/**
 * Join to Create runtime: the only place where Discord effects and stored
 * state are combined.
 *
 * Rules that keep Discord and PostgreSQL from drifting apart:
 *  - Every operation for a guild runs one at a time through runExclusive().
 *  - Create: reserve in the database first, then ask Discord, then register.
 *  - Delete: delete in Discord first, then drop the record. A record without a
 *    channel is harmless and is cleaned up later; a channel without a record
 *    would never be cleaned up.
 *  - An interrupted create leaves a reservation behind. settlePending() looks
 *    for the channel in Discord, adopts or removes it, then releases the
 *    reservation. Nothing is ever created twice for one reservation.
 *
 * Discord and PostgreSQL are still two systems: these rules bound the damage
 * of a crash or lost response, they cannot make the pair atomic.
 */

/** Mutable so tests can shorten the waits. */
export const joinToCreateTiming = {
    /** Age after which a reservation is treated as interrupted rather than in flight. */
    pendingStaleMs: 20_000,
    /** How long to wait for Discord to answer a channel create. */
    createTimeoutMs: 20_000,
    /** How long to wait for other Discord calls (move, delete, fetch, overwrite). */
    discordTimeoutMs: 15_000,
    /** Minimum time between two creates for the same member. */
    cooldownMs: 2_000,
};

const UNKNOWN_CHANNEL = 10003;
const MAX_QUEUED_OPERATIONS = 200;
const MAX_TRACKED_COOLDOWNS = 10_000;
/** Tolerated difference between this host's clock and Discord's channel timestamps. */
const CLOCK_SKEW_MS = 10_000;
/** How long after a reservation Discord may still have produced its channel. */
const CREATE_WINDOW_MS = 120_000;
const FALLBACK_CHANNEL_NAME = 'Voice Room';
const MIN_BITRATE = 8_000;
const OWNER_PERMISSIONS = [
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.PrioritySpeaker,
    PermissionFlagsBits.MoveMembers,
];
const OWNER_OVERWRITE = { Connect: true, Speak: true, PrioritySpeaker: true, MoveMembers: true };
const REQUIRED_BOT_PERMISSIONS = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Connect];

const queues = new Map();
const cooldowns = new Map();

const fail = (code, message) => Object.assign(new Error(message), { code });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUnknownChannel = (error) => error?.code === UNKNOWN_CHANNEL;
/** Discord answered and refused: nothing was created. 5xx, timeouts and network errors are NOT definite. */
const isDefiniteRejection = (error) =>
    error?.name === 'RateLimitError'
    || (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408);
const humansIn = (channel) => channel?.members?.filter?.((member) => !member.user?.bot) ?? new Map();
const describeError = (error) => `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? error}`;

class DiscordTimeoutError extends Error {
    constructor() {
        super('Discord did not answer in time');
        this.code = 'JTC_DISCORD_TIMEOUT';
    }
}

/** Reject after `ms`; the underlying request is NOT cancelled and may still finish. */
function withTimeout(promise, ms = joinToCreateTiming.discordTimeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DiscordTimeoutError()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run tasks for one guild strictly one after another (in this process).
 * A failing task does not block the next one.
 */
export function runExclusive(guildId, task) {
    let entry = queues.get(guildId);
    if (!entry) {
        entry = { tail: Promise.resolve(), size: 0 };
        queues.set(guildId, entry);
    }
    entry.size += 1;
    const run = entry.tail.then(task);
    entry.tail = run.then(() => {}, () => {}).finally(() => {
        entry.size -= 1;
    });
    return run;
}

const queueLength = (guildId) => queues.get(guildId)?.size ?? 0;

/**
 * Queue a task that starts from a settled state: an interrupted create is
 * resolved first. While that create may still be in flight the task either
 * waits (`waitForPending`: Discord events, which are not delivered twice) or
 * fails with JTC_PENDING (commands, where the administrator can retry).
 */
function exclusive(client, guildId, task, { waitForPending = false } = {}) {
    return runExclusive(guildId, async () => {
        const guild = client.guilds?.cache?.get(guildId) ?? null;
        let state = await readJoinToCreateState(client, guildId);
        if (state.pending.length) state = await settlePending(client, guild, state, { wait: waitForPending });
        return task(state, guild);
    });
}

// ---------------------------------------------------------------------------
// Interrupted creates
// ---------------------------------------------------------------------------

/** True when `channel` looks like the product of the interrupted create `pending`. */
function matchesInterruptedCreate(channel, pending, state, triggerChannel) {
    return channel?.type === ChannelType.GuildVoice
        && !Object.hasOwn(state.temporaryChannels, channel.id)
        && !state.triggerChannels.includes(channel.id)
        && channel.createdTimestamp >= pending.createdAt - CLOCK_SKEW_MS
        && channel.createdTimestamp <= pending.createdAt + CREATE_WINDOW_MS
        && channel.permissionOverwrites?.cache?.get(pending.ownerId)?.type === OverwriteType.Member
        && (!triggerChannel || channel.parentId === triggerChannel.parentId);
}

/**
 * Resolve the single open reservation. Returns the fresh state.
 *
 * - Too recent (and not forced): throws JTC_PENDING; the create may be in flight.
 * - Channel found (recorded ID, or exactly one channel matching the create):
 *   register it, then delete it if nobody is inside.
 * - No channel found: release the reservation.
 * - Discord cannot be asked: throws; the reservation stays for a later attempt.
 */
async function settlePending(client, guild, state, { wait = false, force = false } = {}) {
    const pending = state.pending[0];
    if (!pending) return state;
    if (!guild) throw fail('JTC_PENDING', 'A channel create is pending and the guild is not available');

    if (!force) {
        const remaining = joinToCreateTiming.pendingStaleMs - (Date.now() - pending.createdAt);
        if (remaining > 0) {
            if (!wait) throw fail('JTC_PENDING', 'A channel create is in progress');
            await sleep(remaining);
        }
    }

    let channel = null;
    if (pending.stage === 'created') {
        try {
            const found = await withTimeout(guild.channels.fetch(pending.channelId, { force: true }));
            if (found?.type === ChannelType.GuildVoice) channel = found;
        } catch (error) {
            if (!isUnknownChannel(error)) throw error;
        }
    } else {
        const all = await withTimeout(guild.channels.fetch());
        const triggerChannel = all.get(pending.triggerId) ?? null;
        const candidates = all.filter((candidate) => matchesInterruptedCreate(candidate, pending, state, triggerChannel));
        if (candidates.size === 1) {
            channel = candidates.first();
        } else if (candidates.size > 1) {
            logger.warn(`Join to Create: ${candidates.size} channels match an interrupted create in guild ${guild.id}; none was touched. Review manually: ${[...candidates.keys()].join(', ')}`);
        }
    }

    if (channel) {
        let adopted = false;
        try {
            await completeJoinToCreate(client, guild.id, pending.ownerId, pending.triggerId, pending.token, channel.id);
            adopted = true;
        } catch (error) {
            if (!['JTC_STALE', 'JTC_CONFLICT'].includes(error.code)) throw error;
        }
        if (adopted) {
            logger.warn(`Join to Create: recovered channel ${channel.id} from an interrupted create in guild ${guild.id}`);
            if (humansIn(channel).size === 0) await removeTemporaryChannel(client, guild, channel, 'Join to Create: empty after interrupted create');
            return readJoinToCreateState(client, guild.id);
        }
        // Ours, but it can no longer be registered (trigger removed meanwhile).
        if (humansIn(channel).size === 0) {
            await withTimeout(channel.delete('Join to Create: interrupted create')).catch((error) => {
                if (!isUnknownChannel(error)) logger.warn(`Join to Create: could not delete channel ${channel.id} left by an interrupted create (${describeError(error)})`);
            });
        } else {
            logger.warn(`Join to Create: channel ${channel.id} from an interrupted create is in use and is no longer managed by the bot`);
        }
    }

    await cancelJoinToCreatePending(client, guild.id, pending.token);
    logger.warn(`Join to Create: released an interrupted create reservation in guild ${guild.id}${channel ? '' : ' (no matching channel found)'}`);
    return readJoinToCreateState(client, guild.id);
}

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

function buildChannelName(template, member, guild, triggerChannel) {
    try {
        const name = formatChannelName(template, {
            username: member.user?.username,
            userTag: member.user?.tag,
            displayName: member.displayName,
            guildName: guild.name,
            channelName: triggerChannel?.name,
        });
        return name.trim().slice(0, 100) || FALLBACK_CHANNEL_NAME;
    } catch {
        return FALLBACK_CHANNEL_NAME;
    }
}

/**
 * New channels mirror the trigger's category (what Discord does by default)
 * and add the owner. They never grant more than the category does.
 */
function buildOverwrites(triggerChannel, ownerId) {
    const inherited = [...(triggerChannel.parent?.permissionOverwrites?.cache?.values?.() ?? [])];
    const overwrites = inherited
        .filter((overwrite) => overwrite.id !== ownerId)
        .map((overwrite) => ({ id: overwrite.id, type: overwrite.type, allow: overwrite.allow, deny: overwrite.deny }));
    const own = inherited.find((overwrite) => overwrite.id === ownerId);
    overwrites.push({
        id: ownerId,
        type: OverwriteType.Member,
        allow: new PermissionsBitField(own?.allow ?? 0n).add(OWNER_PERMISSIONS),
        deny: new PermissionsBitField(own?.deny ?? 0n).remove(OWNER_PERMISSIONS),
    });
    return overwrites;
}

/** Fetch a channel that is missing from the cache. null = Discord says it does not exist. */
async function resolveChannel(guild, channelId) {
    const cached = guild.channels.cache.get(channelId);
    if (cached) return cached;
    try {
        return await withTimeout(guild.channels.fetch(channelId, { force: true }));
    } catch (error) {
        if (isUnknownChannel(error)) return null;
        throw error;
    }
}

/** Delete in Discord first; drop the record only once the channel is certainly gone. */
async function removeTemporaryChannel(client, guild, channel, reason) {
    try {
        await withTimeout(channel.delete(reason));
    } catch (error) {
        if (!isUnknownChannel(error)) {
            logger.warn(`Join to Create: could not delete temporary channel ${channel.id}; its record is kept (${describeError(error)})`);
            return false;
        }
    }
    await unregisterJoinToCreateChannelIfPresent(client, guild.id, channel.id);
    logger.info(`Join to Create: removed temporary channel ${channel.id} in guild ${guild.id}`);
    return true;
}

async function transferOwnership(client, guild, channel, info, humans, state) {
    for (const candidate of humans.values()) {
        if (candidate.id === info.ownerId) continue;
        try {
            await transferJoinToCreateOwner(client, guild.id, channel.id, info.ownerId, candidate.id);
        } catch (error) {
            if (error.code === 'JTC_CONFLICT') continue; // candidate already owns another channel
            if (error.code === 'JTC_STALE') return null;
            throw error;
        }

        await withTimeout(channel.permissionOverwrites.edit(candidate, OWNER_OVERWRITE, { reason: 'Join to Create: new channel owner' }))
            .catch((error) => logger.warn(`Join to Create: could not grant owner permissions in ${channel.id} (${describeError(error)})`));
        await withTimeout(channel.permissionOverwrites.delete(info.ownerId, 'Join to Create: previous channel owner left'))
            .catch((error) => logger.debug(`Join to Create: could not remove previous owner overwrite in ${channel.id} (${describeError(error)})`));

        // Discord allows two renames per ten minutes per channel and discord.js
        // waits for that limit; never hold the guild queue for it.
        const options = state.channelOptions?.[info.triggerChannelId] ?? {};
        const name = buildChannelName(options.nameTemplate ?? state.channelNameTemplate, candidate, guild, guild.channels.cache.get(info.triggerChannelId));
        Promise.resolve()
            .then(() => channel.setName(name, 'Join to Create: new channel owner'))
            .catch((error) => logger.debug(`Join to Create: could not rename ${channel.id} (${describeError(error)})`));

        logger.info(`Join to Create: transferred channel ${channel.id} in guild ${guild.id} to a new owner`);
        return candidate.id;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Voice events
// ---------------------------------------------------------------------------

function onCooldown(guildId, userId) {
    const now = Date.now();
    const key = `${guildId}:${userId}`;
    const last = cooldowns.get(key);
    if (last !== undefined && now - last < joinToCreateTiming.cooldownMs) return true;
    if (cooldowns.size >= MAX_TRACKED_COOLDOWNS) {
        for (const [entry, timestamp] of cooldowns) {
            if (now - timestamp >= joinToCreateTiming.cooldownMs) cooldowns.delete(entry);
        }
        if (cooldowns.size >= MAX_TRACKED_COOLDOWNS) cooldowns.clear();
    }
    cooldowns.set(key, now);
    return false;
}

async function createForMember(client, guild, member, triggerChannel) {
    const me = guild.members.me;
    const permissions = me ? triggerChannel.permissionsFor(me) : null;
    if (!permissions?.has(REQUIRED_BOT_PERMISSIONS)) {
        logger.warn(`Join to Create: missing Manage Channels, Move Members or Connect for trigger ${triggerChannel.id} in guild ${guild.id}`);
        return { status: 'missing_permissions' };
    }
    if (member.voice?.channelId !== triggerChannel.id) return { status: 'left' };
    if (onCooldown(guild.id, member.id)) return { status: 'cooldown' };

    let reservation;
    try {
        reservation = await reserveJoinToCreate(client, guild.id, member.id, triggerChannel.id);
    } catch (error) {
        if (['JTC_STALE', 'JTC_CONFLICT'].includes(error.code)) return { status: 'skipped', code: error.code };
        throw error;
    }
    const { token, options } = reservation;

    const userLimit = Math.max(0, Math.min(99, options.userLimit || 0));
    const bitrate = Math.max(MIN_BITRATE, Math.min(options.bitrate, guild.maximumBitrate || options.bitrate));
    const createPromise = Promise.resolve().then(() => guild.channels.create({
        name: buildChannelName(options.nameTemplate, member, guild, triggerChannel),
        type: ChannelType.GuildVoice,
        parent: triggerChannel.parentId ?? undefined,
        userLimit: userLimit === 0 ? undefined : userLimit,
        bitrate,
        permissionOverwrites: buildOverwrites(triggerChannel, member.id),
        // The token lets an administrator match this channel in the audit log.
        reason: `Join to Create ${token}`,
    }));

    let channel;
    try {
        channel = await withTimeout(createPromise, joinToCreateTiming.createTimeoutMs);
    } catch (error) {
        if (isDefiniteRejection(error)) {
            await cancelJoinToCreatePending(client, guild.id, token);
            logger.warn(`Join to Create: Discord refused to create a channel in guild ${guild.id} (${describeError(error)})`);
            Promise.resolve()
                .then(() => member.send({ content: '❌ Failed to create your temporary voice channel. Please contact a server administrator.' }))
                .catch(() => {});
            return { status: 'rejected' };
        }
        if (error instanceof DiscordTimeoutError) {
            // The request may still complete. Deal with the channel if it ever arrives.
            createPromise.then(
                (late) => runExclusive(guild.id, () => finishLateCreate(client, guild, member, triggerChannel, token, late))
                    .catch((lateError) => logger.error('Join to Create: failed to handle a late channel create:', lateError)),
                () => {},
            );
            logger.warn(`Join to Create: Discord did not answer a channel create in guild ${guild.id}; the reservation is kept until it can be checked`);
            return { status: 'uncertain' };
        }
        // Outcome unknown (5xx or network). Look for the channel right away.
        logger.warn(`Join to Create: channel create in guild ${guild.id} has an unknown outcome (${describeError(error)})`);
        try {
            await settlePending(client, guild, await readJoinToCreateState(client, guild.id), { force: true });
        } catch (settleError) {
            logger.warn(`Join to Create: the interrupted create could not be checked yet (${describeError(settleError)})`);
        }
        return { status: 'uncertain' };
    }

    if (!(await registerCreatedChannel(client, guild, member, triggerChannel, token, channel))) return { status: 'unregistered' };
    return placeMember(client, guild, member, triggerChannel, channel);
}

/** Register a channel Discord just returned. On failure the channel is removed again. */
async function registerCreatedChannel(client, guild, member, triggerChannel, token, channel) {
    try {
        await completeJoinToCreate(client, guild.id, member.id, triggerChannel.id, token, channel.id);
        return true;
    } catch (error) {
        logger.warn(`Join to Create: registering channel ${channel.id} failed (${describeError(error)}); checking the stored state`);
    }
    // The transaction may or may not have committed: read before deciding.
    try {
        const state = await readJoinToCreateState(client, guild.id);
        if (state.temporaryChannels[channel.id]?.ownerId === member.id) return true;
        if (state.pending.some((pending) => pending.token === token)) {
            await completeJoinToCreate(client, guild.id, member.id, triggerChannel.id, token, channel.id);
            return true;
        }
    } catch (error) {
        logger.warn(`Join to Create: channel ${channel.id} could not be registered (${describeError(error)})`);
    }
    // We hold the ID of a channel we just created and cannot track: remove it.
    await withTimeout(channel.delete('Join to Create: could not register channel')).catch((error) => {
        if (!isUnknownChannel(error)) logger.error(`Join to Create: channel ${channel.id} could be neither registered nor deleted; remove it manually (${describeError(error)})`);
    });
    await cancelJoinToCreatePending(client, guild.id, token).catch(() => {});
    return false;
}

/** Move the member in; an unused channel is removed straight away. */
async function placeMember(client, guild, member, triggerChannel, channel) {
    let moved = false;
    if (member.voice?.channelId === triggerChannel.id) {
        try {
            await withTimeout(member.voice.setChannel(channel, 'Join to Create'));
            moved = true;
        } catch (error) {
            logger.warn(`Join to Create: could not move a member into ${channel.id} (${describeError(error)})`);
        }
    }
    if (!moved && humansIn(channel).size === 0) {
        await removeTemporaryChannel(client, guild, channel, 'Join to Create: owner left before the move');
        return { status: 'abandoned' };
    }
    logger.info(`Join to Create: created temporary channel ${channel.id} in guild ${guild.id}`);
    return { status: 'created', channelId: channel.id };
}

/** A create answered after we stopped waiting for it. */
async function finishLateCreate(client, guild, member, triggerChannel, token, channel) {
    const state = await readJoinToCreateState(client, guild.id);
    if (state.pending.some((pending) => pending.token === token)) {
        if (await registerCreatedChannel(client, guild, member, triggerChannel, token, channel)) {
            await placeMember(client, guild, member, triggerChannel, channel);
        }
        return;
    }
    if (Object.hasOwn(state.temporaryChannels, channel.id)) return; // already adopted by settlePending()
    if (humansIn(channel).size === 0) {
        await withTimeout(channel.delete('Join to Create: late channel create')).catch((error) => {
            if (!isUnknownChannel(error)) logger.warn(`Join to Create: could not delete late channel ${channel.id} (${describeError(error)})`);
        });
    }
}

async function handleTriggerJoin(client, guild, member, triggerChannel, state) {
    const existingId = Object.keys(state.temporaryChannels).find((channelId) => state.temporaryChannels[channelId].ownerId === member.id);
    if (existingId) {
        const existing = await resolveChannel(guild, existingId);
        if (existing) {
            if (member.voice?.channelId === triggerChannel.id) {
                await withTimeout(member.voice.setChannel(existing, 'Join to Create: existing channel'))
                    .catch((error) => logger.warn(`Join to Create: could not move a member to their existing channel ${existingId} (${describeError(error)})`));
            }
            return { status: 'existing', channelId: existingId };
        }
        // The record outlived its channel.
        await unregisterJoinToCreateChannelIfPresent(client, guild.id, existingId);
    }
    return createForMember(client, guild, member, triggerChannel);
}

async function handleTemporaryLeave(client, guild, channelId, state) {
    const info = state.temporaryChannels[channelId];
    const channel = await resolveChannel(guild, channelId);
    if (!channel) {
        await unregisterJoinToCreateChannelIfPresent(client, guild.id, channelId);
        return { status: 'record_removed' };
    }
    const humans = humansIn(channel);
    if (humans.size === 0) {
        const removed = await removeTemporaryChannel(client, guild, channel, 'Join to Create: channel is empty');
        return { status: removed ? 'deleted' : 'delete_failed' };
    }
    if (!humans.has(info.ownerId)) {
        const newOwnerId = await transferOwnership(client, guild, channel, info, humans, state);
        return { status: newOwnerId ? 'transferred' : 'kept', ownerId: newOwnerId };
    }
    return { status: 'kept' };
}

/**
 * Entry point for the voiceStateUpdate event. Resolves when the event has
 * been fully handled; never throws for expected conditions.
 */
export async function handleJoinToCreateVoiceState(client, oldState, newState) {
    const leftId = oldState?.channelId ?? null;
    const joinedId = newState?.channelId ?? null;
    if (leftId === joinedId) return null; // mute, deafen, stream…

    const member = newState?.member ?? oldState?.member;
    const guild = newState?.guild ?? oldState?.guild;
    if (!member || !guild || member.user?.bot) return null;

    if (queueLength(guild.id) >= MAX_QUEUED_OPERATIONS) {
        logger.warn(`Join to Create: too many queued voice events in guild ${guild.id}; one was dropped`);
        return null;
    }

    return exclusive(client, guild.id, async (state) => {
        const result = {};
        if (leftId && Object.hasOwn(state.temporaryChannels, leftId)) {
            result.left = await handleTemporaryLeave(client, guild, leftId, state);
            state = await readJoinToCreateState(client, guild.id);
        }
        if (joinedId && state.enabled && state.triggerChannels.includes(joinedId)) {
            const triggerChannel = guild.channels.cache.get(joinedId);
            if (triggerChannel) result.joined = await handleTriggerJoin(client, guild, member, triggerChannel, state);
        }
        return result;
    }, { waitForPending: true });
}

/** Entry point for the channelDelete event (voice channels only). */
export async function handleJoinToCreateChannelDelete(client, channel) {
    const guildId = channel?.guild?.id ?? channel?.guildId;
    if (!guildId || channel.type !== ChannelType.GuildVoice) return null;

    return exclusive(client, guildId, async (state) => {
        const result = { triggerRemoved: false, recordRemoved: false };
        if (state.triggerChannels.includes(channel.id)) {
            await removeJoinToCreateTrigger(client, guildId, channel.id);
            result.triggerRemoved = true;
            logger.info(`Join to Create: trigger ${channel.id} was deleted in Discord and removed from the configuration`);
        }
        if (Object.hasOwn(state.temporaryChannels, channel.id)) {
            result.recordRemoved = await unregisterJoinToCreateChannelIfPresent(client, guildId, channel.id);
        }
        return result;
    }, { waitForPending: true });
}

/**
 * Bring stored state and Discord back in line after downtime. Acts only on
 * a complete, freshly fetched channel list.
 */
export async function reconcileJoinToCreate(client, guildId) {
    const summary = { pendingSettled: 0, recordsRemoved: 0, channelsDeleted: 0, ownersTransferred: 0, triggersRemoved: 0, membersServed: 0, errors: 0 };
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return summary;

    const hadPending = (await readJoinToCreateState(client, guildId)).pending.length;

    await exclusive(client, guildId, async (initial) => {
        let state = initial;
        summary.pendingSettled = hadPending;
        const channels = await withTimeout(guild.channels.fetch());

        for (const [channelId, info] of Object.entries(state.temporaryChannels)) {
            try {
                const channel = channels.get(channelId);
                if (!channel) {
                    if (await unregisterJoinToCreateChannelIfPresent(client, guildId, channelId)) summary.recordsRemoved += 1;
                    continue;
                }
                const humans = humansIn(channel);
                if (humans.size === 0) {
                    if (await removeTemporaryChannel(client, guild, channel, 'Join to Create: empty after restart')) summary.channelsDeleted += 1;
                } else if (!humans.has(info.ownerId)) {
                    if (await transferOwnership(client, guild, channel, info, humans, state)) summary.ownersTransferred += 1;
                }
            } catch (error) {
                summary.errors += 1;
                logger.warn(`Join to Create: could not reconcile channel ${channelId} (${describeError(error)})`);
            }
        }

        for (const triggerId of state.triggerChannels) {
            if (channels.has(triggerId)) continue;
            try {
                await removeJoinToCreateTrigger(client, guildId, triggerId);
                summary.triggersRemoved += 1;
            } catch (error) {
                summary.errors += 1;
                logger.warn(`Join to Create: could not remove missing trigger ${triggerId} (${describeError(error)})`);
            }
        }

        // Members who joined a trigger while the bot was away.
        state = await readJoinToCreateState(client, guildId);
        if (!state.enabled) return;
        for (const triggerId of state.triggerChannels) {
            const triggerChannel = channels.get(triggerId);
            for (const member of humansIn(triggerChannel).values()) {
                try {
                    const result = await handleTriggerJoin(client, guild, member, triggerChannel, state);
                    if (['created', 'existing'].includes(result?.status)) summary.membersServed += 1;
                    state = await readJoinToCreateState(client, guildId);
                } catch (error) {
                    summary.errors += 1;
                    logger.warn(`Join to Create: could not serve a member waiting in trigger ${triggerId} (${describeError(error)})`);
                }
            }
        }
    }, { waitForPending: true });

    return summary;
}

// ---------------------------------------------------------------------------
// Configuration (used by the slash command)
// ---------------------------------------------------------------------------

/** Current configuration and channel records. Internal: includes owner IDs. */
export function getJoinToCreateState(client, guildId) {
    return readJoinToCreateState(client, guildId);
}

export function configureJoinToCreateTrigger(client, guildId, triggerId, options) {
    return exclusive(client, guildId, () => setupJoinToCreate(client, guildId, triggerId, options));
}

export function updateJoinToCreateTrigger(client, guildId, triggerId, patch, expectedConfigRevision = null) {
    return exclusive(client, guildId, () => updateJoinToCreate(client, guildId, triggerId, patch, expectedConfigRevision));
}

export function removeJoinToCreateTriggerConfig(client, guildId, triggerId, expectedConfigRevision = null) {
    return exclusive(client, guildId, () => removeJoinToCreateTrigger(client, guildId, triggerId, expectedConfigRevision));
}
