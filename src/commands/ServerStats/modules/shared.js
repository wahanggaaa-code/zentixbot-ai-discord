import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../../utils/logger.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../../utils/errorHandler.js';
import { counterErrorMessage } from '../../../services/serverStats/manage.js';
import { getCounterEmoji, getCounterTypeLabel } from '../../../services/serverstatsService.js';

export const typeDisplay = (type) => `${getCounterEmoji(type)} ${getCounterTypeLabel(type)}`;

/** Defer the reply and check Manage Channels. False when the command must stop. */
export async function begin(interaction, action) {
    try {
        await InteractionHelper.safeDefer(interaction);
    } catch (error) {
        logger.error('Failed to defer reply:', error);
        return false;
    }
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
        await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: `You need **Manage Channels** permission to ${action} counters.` }).catch(logger.error);
        return false;
    }
    return true;
}

const USER_ERRORS = new Set([
    'SERVERSTATS_TYPE', 'SERVERSTATS_CHANNEL_TYPE', 'SERVERSTATS_CATEGORY', 'SERVERSTATS_DUPLICATE',
    'SERVERSTATS_LIMIT', 'SERVERSTATS_MISSING', 'SERVERSTATS_STALE',
]);

/** Tell the user what went wrong. Failures that are not the user's doing are logged. */
export async function replyCounterError(interaction, error, fallback, extra = '') {
    const expected = USER_ERRORS.has(error?.code);
    if (!expected) logger.error(`[SERVERSTATS] ${fallback}`, error?.cause ?? error);
    const message = counterErrorMessage(error, 'en', fallback) + extra;
    await replyUserError(interaction, { type: expected ? ErrorTypes.USER_INPUT : ErrorTypes.UNKNOWN, message }).catch(logger.error);
}

/** One sentence about the channel name after a change, from a refresh result. */
export function describeRefresh(refresh) {
    switch (refresh?.status) {
        case 'renamed':
        case 'current':
            return 'The channel name is up to date.';
        case 'deferred':
            return `Discord limits how often a channel can be renamed. The name will follow <t:${Math.ceil(refresh.retryAt / 1000)}:R>.`;
        case 'pending':
        case 'slow':
            return 'Discord is holding the rename (rate limit). The name will follow without further action.';
        case 'no_permission':
            return 'I cannot rename the channel: I need **View Channel** and **Manage Channels** on it.';
        case 'count_unknown':
            return 'The member list could not be read, so the name was left as it is. It will be tried again.';
        case 'missing':
            return 'The channel no longer exists. The counter will be removed at the next check.';
        default:
            return 'The channel name could not be changed right now. It will be tried again at the next refresh.';
    }
}
