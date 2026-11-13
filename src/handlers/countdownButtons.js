import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';

/**
 * Countdowns keep no state of their own. The message shows the end as a Discord timestamp, which
 * every client counts down by itself, and the buttons carry who started it and when it ends.
 * The only thing in memory is one timer per running countdown, for the final "Time's up" edit;
 * after a restart that edit is made by the first press of a button instead.
 */

export const MAX_SECONDS = 86_400;
export const MAX_RUNNING = 500;
const SNOWFLAKE = /^\d{17,20}$/;
const DEFAULT_TITLE = 'Countdown';

/** messageId -> timer of the final edit. */
const timers = new Map();
export const runningCountdowns = () => timers.size;

export function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const button = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const cancelButton = (ownerId) => button(`countdown:cancel:${ownerId}`, 'Cancel', ButtonStyle.Danger);

export function runningPayload(title, ownerId, endsAt) {
    return {
        embeds: [createEmbed({ title: title || DEFAULT_TITLE, description: `Ends <t:${endsAt}:R>, at <t:${endsAt}:T>.`, color: 'success' })],
        components: [new ActionRowBuilder().addComponents(button(`countdown:pause:${ownerId}:${endsAt}`, 'Pause', ButtonStyle.Secondary), cancelButton(ownerId))],
    };
}

const pausedPayload = (title, ownerId, remaining) => ({
    embeds: [createEmbed({ title: title || DEFAULT_TITLE, description: `Paused with **${formatTime(remaining)}** remaining.`, color: 'warning' })],
    components: [new ActionRowBuilder().addComponents(button(`countdown:resume:${ownerId}:${remaining}`, 'Resume', ButtonStyle.Success), cancelButton(ownerId))],
});

const finishedPayload = (title, endsAt) => ({
    embeds: [createEmbed({ title: title || DEFAULT_TITLE, description: `**Time's up!** Ended <t:${endsAt}:R>.`, color: 'success' })],
    components: [],
});

function forget(messageId) {
    clearTimeout(timers.get(messageId));
    timers.delete(messageId);
}

/** Arrange the final edit of a running countdown. Returns false when too many are running already. */
export function scheduleFinish(message, title, endsAt) {
    if (!message?.id || typeof message.edit !== 'function') return true;
    forget(message.id);
    if (timers.size >= MAX_RUNNING) return false;
    const timer = setTimeout(async () => {
        timers.delete(message.id);
        try {
            await message.edit(finishedPayload(title, endsAt));
        } catch (error) {
            // The message was deleted, or the channel is out of reach; there is nothing left to update.
            logger.debug('Countdown message could not be updated at its end', { messageId: message.id, code: error?.code });
        }
    }, Math.max(0, endsAt * 1000 - Date.now()));
    timer.unref?.();
    timers.set(message.id, timer);
    return true;
}

const titleOf = (interaction) => interaction.message?.embeds?.[0]?.title ?? DEFAULT_TITLE;
const gone = (interaction) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This countdown is no longer valid. Use `/countdown` to start a new one.' });

function mayControl(interaction, ownerId) {
    if (interaction.user.id === ownerId) return true;
    return interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageMessages) === true
        || interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageMessages) === true;
}

/** `countdown:pause:<owner>:<endsAt>`, `countdown:resume:<owner>:<remaining>`, `countdown:cancel:<owner>`. */
export async function countdownButtonHandler(interaction, client, args) {
    const [action, ownerId, number] = args;
    if (!['pause', 'resume', 'cancel'].includes(action) || !SNOWFLAKE.test(ownerId ?? '')) return gone(interaction);
    if (!mayControl(interaction, ownerId)) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only the member who started this countdown, or a member with **Manage Messages**, can control it.' });
    }
    const title = titleOf(interaction);
    const messageId = interaction.message?.id;
    const now = Math.floor(Date.now() / 1000);

    if (action === 'cancel') {
        forget(messageId);
        return interaction.update({
            embeds: [createEmbed({ title, description: `Cancelled by <@${interaction.user.id}>.`, color: 'error' })],
            components: [],
        });
    }

    const value = /^\d{1,12}$/.test(number ?? '') ? Number(number) : null;
    if (action === 'pause') {
        // The end is a moment this bot wrote: at most one countdown length ahead.
        if (value === null || value > now + MAX_SECONDS) return gone(interaction);
        forget(messageId);
        if (value <= now) return interaction.update(finishedPayload(title, value));
        return interaction.update(pausedPayload(title, ownerId, value - now));
    }

    if (value === null || value < 1 || value > MAX_SECONDS) return gone(interaction);
    const endsAt = now + value;
    await interaction.update(runningPayload(title, ownerId, endsAt));
    if (!scheduleFinish(interaction.message, title, endsAt)) {
        logger.warn('Countdown resumed without a final edit: too many are running', { messageId });
    }
}

/** Buttons of countdowns started before this version; their state lived in memory and is gone. */
export const legacyCountdownButton = (interaction) => gone(interaction);

export default countdownButtonHandler;
