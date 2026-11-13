import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';
import { ZentixBotError, ErrorTypes } from '../utils/errorHandler.js';
import { logEvent, EVENT_TYPES } from './loggingService.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';
import {
    validateChannelNameTemplate,
    normalizeChannelNameTemplate,
    validateBitrate,
    validateUserLimit,
    formatChannelName,
} from '../utils/joinToCreateTemplate.js';
import {
    getJoinToCreateState,
    configureJoinToCreateTrigger,
    updateJoinToCreateTrigger,
    removeJoinToCreateTriggerConfig,
} from './joinToCreateRuntime.js';

/**
 * Command-facing Join to Create API. Validates input, runs the operation
 * through the runtime (queue + PostgreSQL transaction) and turns storage
 * error codes into messages an administrator can act on.
 */

export { validateChannelNameTemplate, validateBitrate, validateUserLimit, formatChannelName };

const STORAGE_MESSAGES = {
    JTC_UNAVAILABLE: 'The database is currently unavailable. Please try again later.',
    JTC_SCOPE: 'Join to Create is only available in the configured server.',
    JTC_PENDING: 'A temporary channel is being created right now. Please try again in a few seconds.',
    JTC_STALE: 'The Join to Create configuration changed in the meantime. Run the command again.',
    JTC_INVALID: 'The stored Join to Create data needs to be reviewed by the bot owner before it can be changed.',
    JTC_LEGACY: 'The stored Join to Create data needs to be reviewed by the bot owner before it can be changed.',
    JTC_EXPIRY: 'The stored Join to Create data needs to be reviewed by the bot owner before it can be changed.',
};

/** Convert a storage error into a ZentixBotError; `overrides` adds operation-specific messages. */
function toUserError(error, fallbackMessage, overrides = {}) {
    if (error instanceof ZentixBotError) return error;
    const message = overrides[error?.code] ?? STORAGE_MESSAGES[error?.code];
    if (message) {
        return new ZentixBotError(`Join to Create storage: ${error.code}`, ErrorTypes.DATABASE, message, {
            storageCode: error.code,
            expected: true,
            suppressErrorLog: true,
        });
    }
    logger.error('Join to Create storage operation failed:', error);
    return new ZentixBotError(`Join to Create operation failed: ${error?.message}`, ErrorTypes.DATABASE, fallbackMessage);
}

function requireIds(guildId, channelId) {
    if (!guildId || !channelId) {
        throw new ZentixBotError(
            'Missing required guild or channel ID',
            ErrorTypes.VALIDATION,
            'Invalid guild or channel information provided.'
        );
    }
}

/** Validate command input and return only the fields the storage accepts. */
function normaliseOptions(options = {}) {
    const result = {};
    if (options.nameTemplate !== undefined && options.nameTemplate !== null) {
        validateChannelNameTemplate(options.nameTemplate);
        result.nameTemplate = normalizeChannelNameTemplate(options.nameTemplate);
    }
    if (options.userLimit !== undefined && options.userLimit !== null) {
        validateUserLimit(options.userLimit);
        result.userLimit = Number.parseInt(options.userLimit, 10);
    }
    if (options.bitrate !== undefined && options.bitrate !== null) {
        validateBitrate(options.bitrate / 1000);
        result.bitrate = Math.round(Number(options.bitrate));
    }
    return result;
}

/**
 * Stored configuration in the shape the command expects. Includes
 * temporaryChannels (with owner IDs): do not expose it outside the bot.
 */
export async function getConfiguration(client, guildId) {
    try {
        const state = await getJoinToCreateState(client, guildId);
        return {
            enabled: state.enabled,
            triggerChannels: state.triggerChannels,
            channelNameTemplate: state.channelNameTemplate,
            userLimit: state.userLimit,
            bitrate: state.bitrate,
            channelOptions: state.channelOptions,
            temporaryChannels: state.temporaryChannels,
            configRevision: state.configRevision,
        };
    } catch (error) {
        throw toUserError(error, 'Failed to retrieve settings.');
    }
}

/** Register `channelId` as the guild's trigger channel. */
export async function initializeJoinToCreate(client, guildId, channelId, options = {}) {
    requireIds(guildId, channelId);
    const stored = normaliseOptions(options);
    if (!Object.keys(stored).length) stored.userLimit = 0;
    try {
        await configureJoinToCreateTrigger(client, guildId, channelId, stored);
    } catch (error) {
        throw toUserError(error, 'Failed to set up Join to Create system.', {
            JTC_CONFLICT: 'This server already has a Join to Create channel configured. Use `/jointocreate dashboard` to modify it, or remove it before creating a new one.',
        });
    }
    logger.info(`Initialized Join to Create for guild ${guildId} with trigger channel ${channelId}`);
    return getConfiguration(client, guildId);
}

/** Change only the given settings of a trigger. Returns the settings now in effect. */
export async function updateChannelConfig(client, guildId, channelId, updates) {
    requireIds(guildId, channelId);
    const patch = normaliseOptions(updates);
    if (!Object.keys(patch).length) {
        throw new ZentixBotError('No valid Join to Create settings supplied', ErrorTypes.VALIDATION, 'Nothing to update.');
    }
    try {
        const effective = await updateJoinToCreateTrigger(client, guildId, channelId, patch);
        logger.info(`Updated Join to Create config for channel ${channelId} in guild ${guildId}`, { updates: Object.keys(patch) });
        return effective;
    } catch (error) {
        throw toUserError(error, 'Failed to update configuration.', {
            JTC_MISSING: 'This channel is not set up as a Join to Create trigger.',
        });
    }
}

/**
 * Remove a trigger from the configuration. Temporary channels that already
 * exist stay registered and are removed when they become empty.
 */
export async function removeTriggerChannel(client, guildId, channelId) {
    requireIds(guildId, channelId);
    try {
        await removeJoinToCreateTriggerConfig(client, guildId, channelId);
    } catch (error) {
        throw toUserError(error, 'Failed to remove trigger channel.', {
            JTC_MISSING: 'This channel is not configured as a Join to Create trigger.',
        });
    }
    logger.info(`Removed Join to Create trigger channel ${channelId} from guild ${guildId}`);
    return true;
}

export async function getChannelConfiguration(client, guildId, channelId) {
    const config = await getConfiguration(client, guildId);
    if (!config.triggerChannels.includes(channelId)) {
        throw new ZentixBotError(
            'Channel is not a valid Join to Create trigger',
            ErrorTypes.VALIDATION,
            'This channel is not set up as a Join to Create trigger.'
        );
    }
    return { ...config, channelConfig: config.channelOptions?.[channelId] || {} };
}

export function hasManageGuildPermission(member) {
    try {
        if (!member || !member.permissions) {
            return false;
        }
        return member.permissions.has(PermissionFlagsBits.ManageGuild);
    } catch (error) {
        logger.error('Error checking ManageGuild permission:', error);
        return false;
    }
}

export async function logConfigurationChange(client, guildId, userId, action, details) {
    try {
        await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.COUNTER_CONFIG,
            data: {
                title: 'Join to Create Updated',
                lines: [
                    formatLogLine('Action', action),
                    formatLogLine('Details', typeof details === 'string' ? details : JSON.stringify(details)),
                ],
                userId,
            },
        });
    } catch (error) {
        logger.warn(`Failed to log Join to Create configuration change: ${error.message}`);
    }
}

export default {
    validateChannelNameTemplate,
    validateBitrate,
    validateUserLimit,
    formatChannelName,
    initializeJoinToCreate,
    updateChannelConfig,
    removeTriggerChannel,
    getConfiguration,
    getChannelConfiguration,
    hasManageGuildPermission,
    logConfigurationChange,
};
