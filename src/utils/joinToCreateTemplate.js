import { logger } from './logger.js';
import { ZentixBotError, ErrorTypes } from './errorHandler.js';

/**
 * Pure helpers for Join to Create channel-name templates and option limits.
 * Shared by the slash command, the runtime that creates channels and tests.
 */

export const CHANNEL_NAME_MAX_LENGTH = 100;
const CHANNEL_VARIABLE_MAX_LENGTH = 32;
const CONTROL_AND_INVISIBLE_CHARS_REGEX = /[\x00-\x1F\x7F\u200B-\u200D\uFEFF]/g;
export const ALLOWED_TEMPLATE_PLACEHOLDERS = new Set([
    '{username}',
    '{user_tag}',
    '{displayName}',
    '{display_name}',
    '{guildName}',
    '{guild_name}',
    '{channelName}',
    '{channel_name}'
]);

/** Template as it is stored and rendered: NFKC, without control or invisible characters. */
export function normalizeChannelNameTemplate(template) {
    return String(template ?? '').normalize('NFKC').replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '').trim();
}

export function validateChannelNameTemplate(template) {
    if (!template || typeof template !== 'string') {
        throw new ZentixBotError(
            'Invalid channel template: must be a non-empty string',
            ErrorTypes.VALIDATION,
            'Channel name template must be valid text.'
        );
    }

    const normalizedTemplate = normalizeChannelNameTemplate(template);

    if (!normalizedTemplate) {
        throw new ZentixBotError(
            'Channel template is empty after normalization',
            ErrorTypes.VALIDATION,
            'Channel name template must contain visible text.'
        );
    }

    if (normalizedTemplate.length > CHANNEL_NAME_MAX_LENGTH) {
        throw new ZentixBotError(
            'Channel template exceeds maximum length',
            ErrorTypes.VALIDATION,
            `Channel name template cannot exceed ${CHANNEL_NAME_MAX_LENGTH} characters.`
        );
    }

    if (/[@#:`]/.test(normalizedTemplate)) {
        throw new ZentixBotError(
            'Channel template contains forbidden characters',
            ErrorTypes.VALIDATION,
            'Channel template cannot contain @, #, :, or backtick characters.'
        );
    }

    const placeholders = normalizedTemplate.match(/\{[^}]+\}/g) || [];
    for (const placeholder of placeholders) {
        if (!ALLOWED_TEMPLATE_PLACEHOLDERS.has(placeholder)) {
            throw new ZentixBotError(
                'Channel template contains unknown placeholders',
                ErrorTypes.VALIDATION,
                `Unknown placeholder: ${placeholder}. Allowed placeholders are ${Array.from(ALLOWED_TEMPLATE_PLACEHOLDERS).join(', ')}`
            );
        }
    }

    return true;
}

export function validateBitrate(bitrate) {
    const bitrateNum = parseInt(bitrate);

    if (isNaN(bitrateNum)) {
        throw new ZentixBotError(
            'Bitrate must be a valid number',
            ErrorTypes.VALIDATION,
            'Please enter a valid number for bitrate.'
        );
    }

    if (bitrateNum < 8 || bitrateNum > 384) {
        throw new ZentixBotError(
            'Bitrate out of valid range',
            ErrorTypes.VALIDATION,
            'Bitrate must be between 8 and 384 kbps.'
        );
    }

    return true;
}

export function validateUserLimit(limit) {
    const limitNum = parseInt(limit);

    if (isNaN(limitNum)) {
        throw new ZentixBotError(
            'User limit must be a valid number',
            ErrorTypes.VALIDATION,
            'Please enter a valid number for user limit.'
        );
    }

    if (limitNum < 0 || limitNum > 99) {
        throw new ZentixBotError(
            'User limit out of valid range',
            ErrorTypes.VALIDATION,
            'User limit must be between 0 (no limit) and 99.'
        );
    }

    return true;
}

export function formatChannelName(template, variables) {
    try {
        const safeTemplate = normalizeChannelNameTemplate(template);
        validateChannelNameTemplate(safeTemplate);

        if (!variables || typeof variables !== 'object') {
            throw new ZentixBotError(
                'Invalid variables object for channel formatting',
                ErrorTypes.VALIDATION
            );
        }

        const sanitized = {};
        for (const [key, value] of Object.entries(variables)) {
            if (value === null || value === undefined) {
                sanitized[key] = 'Unknown';
            } else {
                
                sanitized[key] = String(value)
                    .normalize('NFKC')
                    .replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '')
                    .replace(/[@#:`\n\r\t]/g, '') 
                    .trim()
                    .substring(0, CHANNEL_VARIABLE_MAX_LENGTH);
            }
        }

        const replacements = {
            '{username}': sanitized.username || 'User',
            '{user_tag}': sanitized.userTag || 'User#0000',
            '{displayName}': sanitized.displayName || 'User',
            '{display_name}': sanitized.displayName || 'User',
            '{guildName}': sanitized.guildName || 'Server',
            '{guild_name}': sanitized.guildName || 'Server',
            '{channelName}': sanitized.channelName || 'Voice Channel',
            '{channel_name}': sanitized.channelName || 'Voice Channel',
        };

        // Single pass with a function replacer: a name containing "$&" or a
        // placeholder is inserted literally, never interpreted.
        let formatted = safeTemplate.replace(/\{[^}]+\}/g, (placeholder) => replacements[placeholder] ?? placeholder);

        formatted = formatted
            .normalize('NFKC')
            .replace(CONTROL_AND_INVISIBLE_CHARS_REGEX, '')
            .replace(/[@#:`\n\r\t]/g, '') 
            .replace(/\s+/g, ' ')
            .trim();

        if (formatted.length === 0) {
            formatted = 'Voice Channel';
        } else if (formatted.length > CHANNEL_NAME_MAX_LENGTH) {
            formatted = formatted.substring(0, CHANNEL_NAME_MAX_LENGTH);
        }

        return formatted;

    } catch (error) {
        logger.error('Error formatting channel name:', error);
        throw error;
    }
}
