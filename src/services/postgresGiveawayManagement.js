import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createGiveawayEmbed, createGiveawayButtons } from './giveawayService.js';
import { performPostgresGiveawayDelivery } from './postgresGiveawayRuntime.js';
import {
    assertPostgresGiveawayReady,
    beginPostgresGiveawayDeletion,
    cancelPostgresGiveawayDeletion,
    createPostgresGiveaway,
    finishPostgresGiveawayDeletion,
    inspectPostgresGiveaway,
    retryPostgresGiveawayDelivery,
} from './storage/postgresGiveawayTransactions.js';
import { logger } from '../utils/logger.js';

/**
 * Creating, deleting and repairing giveaways on PostgreSQL.
 *
 * Discord and the database cannot be changed in one transaction. Each
 * operation here is ordered so that an interruption leaves something an
 * administrator can see and finish, and every error says which of the two
 * sides may have changed:
 *
 *   GIVEAWAY_DISCORD_UNVERIFIED  nothing was changed anywhere
 *   GIVEAWAY_CREATE_FAILED       nothing was left behind
 *   GIVEAWAY_SEND_UNKNOWN        a message may exist; no record was written
 *   GIVEAWAY_CREATE_ORPHAN       a message exists; the record is missing or unknown
 *   GIVEAWAY_DELETE_UNFINISHED   the record is marked for deletion and still exists
 *   GIVEAWAY_DELIVERY_UNKNOWN    a re-delivery was started and not confirmed
 *
 * Codes from the storage protocol (GIVEAWAY_STALE, GIVEAWAY_MISSING, ...)
 * pass through unchanged and always mean that nothing was changed.
 */

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;

const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export const GIVEAWAY_POST_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
];

/** Can the bot post a giveaway in this channel? Used for the list and again before sending. */
export function canPostGiveaway(guild, channel) {
    if (!channel || channel.type !== ChannelType.GuildText) return false;
    const me = guild.members?.me;
    const permissions = me ? channel.permissionsFor?.(me) : null;
    return Boolean(permissions?.has(GIVEAWAY_POST_PERMISSIONS));
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// One creation at a time per guild in this process: a double click must not
// post two giveaways. Other processes are not covered.
const creating = new Set();

/**
 * Post the giveaway message, then store the record.
 * If storing fails and the record is known to be absent, the message is
 * removed again so nobody can join a giveaway that does not exist.
 */
export async function createPostgresGiveawayFromDashboard(client, guild, input) {
    const { channelId, prize, winnerCount, durationMs, hostId } = input ?? {};
    const validInput = isId(channelId) && isId(hostId)
        && typeof prize === 'string' && prize.trim() === prize && prize.length >= 1 && prize.length <= 256
        && Number.isInteger(winnerCount) && winnerCount >= 1 && winnerCount <= 100
        && Number.isSafeInteger(durationMs) && durationMs > 0;
    if (!validInput) throw fail('GIVEAWAY_INVALID', 'Invalid giveaway input');
    if (creating.has(guild.id)) throw fail('GIVEAWAY_BUSY', 'Another giveaway is being created');

    creating.add(guild.id);
    try {
        // Storage problems are found before anything is posted.
        await assertPostgresGiveawayReady(client, guild.id);

        let channel;
        try {
            channel = await guild.channels.fetch(channelId);
        } catch {
            throw fail('GIVEAWAY_CHANNEL', 'Channel could not be read');
        }
        if (!channel || channel.id !== channelId || !canPostGiveaway(guild, channel)) {
            throw fail('GIVEAWAY_CHANNEL', 'Channel is not usable for a giveaway');
        }

        const endsAt = Date.now() + durationMs;
        const data = {
            messageId: 'placeholder',
            channelId,
            guildId: guild.id,
            prize,
            hostId,
            endTime: endsAt,
            endsAt,
            winnerCount,
            participants: [],
            isEnded: false,
            ended: false,
            createdAt: new Date().toISOString(),
            createdVia: 'dashboard',
        };

        let message;
        try {
            message = await channel.send({
                content: '🎉 **NEW GIVEAWAY** 🎉',
                embeds: [createGiveawayEmbed(data, 'active')],
                components: [createGiveawayButtons(false)],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            // A numbered Discord API error is a refusal; anything else (timeout,
            // network) may have posted the message.
            if (Number.isInteger(error?.code) && Number.isInteger(error?.status)) {
                throw fail('GIVEAWAY_CREATE_FAILED', 'Discord refused the giveaway message');
            }
            throw fail('GIVEAWAY_SEND_UNKNOWN', 'The giveaway message may or may not have been posted', { channelId });
        }
        if (!isId(message?.id)) {
            throw fail('GIVEAWAY_SEND_UNKNOWN', 'The giveaway message has no usable ID', { channelId });
        }

        data.messageId = message.id;
        try {
            await createPostgresGiveaway(client, guild.id, data);
        } catch (storeError) {
            const outcome = await settleFailedInsert(client, guild.id, message);
            if (outcome === 'stored') return { messageId: message.id, channelId, endsAt };
            logger.warn(`Giveaway message ${message.id} was posted but not stored (${outcome}): ${storeError.message}`);
            if (outcome === 'removed') {
                throw fail('GIVEAWAY_CREATE_FAILED', 'The giveaway could not be stored; its message was removed');
            }
            throw fail('GIVEAWAY_CREATE_ORPHAN', 'A giveaway message exists without a confirmed record', {
                messageId: message.id,
                channelId,
            });
        }
        return { messageId: message.id, channelId, endsAt };
    } finally {
        creating.delete(guild.id);
    }
}

/**
 * After a failed insert: 'stored' (the commit did happen), 'removed' (no
 * record, message deleted again) or 'orphan' (message left in place).
 */
async function settleFailedInsert(client, guildId, message) {
    try {
        await inspectPostgresGiveaway(client, guildId, message.id);
        return 'stored';
    } catch (error) {
        // Only a definite "no such record" allows removing the message.
        if (error.code !== 'GIVEAWAY_MISSING') return 'orphan';
    }
    try {
        await message.delete();
        return 'removed';
    } catch (error) {
        return error?.code === UNKNOWN_MESSAGE ? 'removed' : 'orphan';
    }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Find the giveaway message without changing anything.
 * Returns { message }, or { gone: true } when Discord says the message or its
 * channel no longer exists. Anything unclear is an error, not "gone".
 */
async function locateGiveawayMessage(client, guildId, channelId, messageId) {
    const unverified = (message) => fail('GIVEAWAY_DISCORD_UNVERIFIED', message);
    const guild = client.guilds.cache.get(guildId);
    if (!guild || guild.id !== guildId) throw unverified('Guild unavailable');

    let channel;
    try {
        channel = await guild.channels.fetch(channelId);
    } catch (error) {
        if (error?.code === UNKNOWN_CHANNEL) return { gone: true };
        throw unverified('Channel could not be read');
    }
    const usable = channel && channel.id === channelId && channel.guildId === guildId
        && channel.isTextBased?.() && typeof channel.messages?.fetch === 'function';
    if (!usable) throw unverified('Channel is not usable');

    let message;
    try {
        message = await channel.messages.fetch(messageId);
    } catch (error) {
        if (error?.code === UNKNOWN_MESSAGE) return { gone: true };
        throw unverified('Message could not be read');
    }
    if (!message || message.id !== messageId) throw unverified('Message could not be read');
    // The record must never be used to delete somebody else's message.
    if (message.author?.id !== client.user?.id || typeof message.delete !== 'function') {
        throw unverified('Message does not belong to the bot');
    }
    return { message, channel };
}

/**
 * Delete a giveaway: its Discord message, then its record.
 *
 * With `recordOnly`, Discord is not contacted at all; this is for records
 * whose message cannot be reached or was already dealt with by hand.
 * The winner announcement of an ended giveaway is never deleted.
 */
export async function deletePostgresGiveaway(client, guildId, messageId, actorId, expectedRevision = null, { recordOnly = false } = {}) {
    const view = await inspectPostgresGiveaway(client, guildId, messageId);
    if (expectedRevision !== null && view.revision !== expectedRevision) {
        throw fail('GIVEAWAY_STALE', 'Giveaway changed; inspect again');
    }

    const target = recordOnly ? null : await locateGiveawayMessage(client, guildId, view.channelId, messageId);
    const mark = await beginPostgresGiveawayDeletion(client, guildId, messageId, actorId, view.revision);

    let discord = recordOnly ? 'untouched' : 'already_gone';
    if (target?.message) {
        try {
            await target.message.delete();
            discord = 'deleted';
        } catch (error) {
            if (error?.code !== UNKNOWN_MESSAGE && error?.code !== UNKNOWN_CHANNEL) {
                await undoMarkAfterRefusal(client, guildId, messageId, mark, error);
            }
        }
    }

    try {
        await finishPostgresGiveawayDeletion(client, guildId, messageId, mark.token);
    } catch (error) {
        logger.warn(`Giveaway ${messageId} is marked for deletion but its record was not removed: ${error.message}`);
        throw fail('GIVEAWAY_DELETE_UNFINISHED', 'The record is marked for deletion but was not removed', { discord });
    }
    return {
        discord,
        channelId: mark.channelId,
        prize: mark.prize,
        entries: mark.entries,
        ended: mark.ended,
        winners: mark.winners,
    };
}

/**
 * The message could not be deleted. Always throws.
 * A clear refusal by Discord means the message is still there, so the mark
 * set by this attempt is taken off and the giveaway keeps working. After an
 * unclear failure the mark stays: the message may be gone.
 */
async function undoMarkAfterRefusal(client, guildId, messageId, mark, error) {
    const refused = error?.code === MISSING_ACCESS || error?.code === MISSING_PERMISSIONS;
    if (refused && !mark.resumed) {
        let restored = false;
        try {
            await cancelPostgresGiveawayDeletion(client, guildId, messageId, mark.token);
            restored = true;
        } catch (cancelError) {
            logger.warn(`Giveaway ${messageId} stays marked for deletion: ${cancelError.message}`);
        }
        if (restored) throw fail('GIVEAWAY_DISCORD_UNVERIFIED', 'Discord refused to delete the message');
    }
    throw fail('GIVEAWAY_DELETE_UNFINISHED', 'The Discord message could not be confirmed deleted', { discord: 'unknown' });
}

// ---------------------------------------------------------------------------
// Unfinished delivery
// ---------------------------------------------------------------------------

/**
 * Announce the saved winners again. No new draw.
 * If the first announcement did reach Discord, this posts a second one;
 * the caller must have looked at the channel first.
 */
export async function redeliverPostgresGiveaway(client, guildId, messageId, actorId, expectedRevision = null) {
    const unverified = () => fail('GIVEAWAY_DISCORD_UNVERIFIED', 'Giveaway message could not be verified');
    const view = await inspectPostgresGiveaway(client, guildId, messageId);
    if (expectedRevision !== null && view.revision !== expectedRevision) {
        throw fail('GIVEAWAY_STALE', 'Giveaway changed; inspect again');
    }
    if (view.deliveryStatus !== 'pending') throw fail('GIVEAWAY_STATE', 'No delivery is pending');

    let channel;
    let message;
    let previousPing = null;
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild || guild.id !== guildId) throw unverified();
        channel = await guild.channels.fetch(view.channelId);
        const usable = channel && channel.id === view.channelId && channel.guildId === guildId
            && channel.isTextBased?.() && typeof channel.messages?.fetch === 'function';
        if (!usable) throw unverified();
        message = await channel.messages.fetch(messageId);
        if (!message || message.id !== messageId || message.author?.id !== client.user?.id) throw unverified();
        if (view.winnerPingMessageId) {
            previousPing = await channel.messages.fetch(view.winnerPingMessageId);
            const editable = previousPing && previousPing.id === view.winnerPingMessageId
                && previousPing.author?.id === client.user?.id && typeof previousPing.edit === 'function';
            if (!editable) throw unverified();
        }
    } catch {
        throw unverified();
    }

    const claim = await retryPostgresGiveawayDelivery(client, guildId, messageId, actorId, view.channelId, view.revision);
    try {
        await performPostgresGiveawayDelivery(client, guildId, messageId, claim, { message, channel, previousPing });
    } catch (error) {
        logger.warn(`Giveaway ${messageId} re-delivery was not confirmed: ${error.message}`);
        throw fail('GIVEAWAY_DELIVERY_UNKNOWN', 'Re-delivery was started but not confirmed');
    }
    return { winners: claim.winners.length, entries: claim.entries };
}
