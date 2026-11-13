// A line in the bot's log channel for every change to the counting game
// settings, whether it came from /count or from the web dashboard.

import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { logger } from '../../utils/logger.js';

const TITLES = {
    setup: 'Counting Game Set Up',
    disable: 'Counting Game Disabled',
    reset: 'Counting Game Reset',
};
const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);

/**
 * Best effort: never throws, and the change it describes has already happened.
 * `details`: `{actorId, source, channelId?, system?, start?, scoresCleared?}`.
 */
export async function recordGameChange(client, guildId, action, details = {}) {
    const title = TITLES[action];
    if (!title) return;
    try {
        await logEvent({
            client,
            guildId,
            eventType: EVENT_TYPES.COUNTING_CONFIG,
            data: {
                title,
                lines: [
                    `**Source:** ${details.source === 'dashboard' ? 'web dashboard' : '/count'}`,
                    ...(isId(details.actorId) ? [`**By:** <@${details.actorId}> (${details.actorId})`] : []),
                    ...(isId(details.channelId) ? [`**Channel:** <#${details.channelId}>`] : []),
                    ...(details.system ? [`**System:** ${String(details.system).slice(0, 50)}`] : []),
                    ...(Number.isSafeInteger(details.start) ? [`**Starts at:** ${details.start}`] : []),
                    ...(details.scoresCleared === true ? ['**Scores:** leaderboard and best streak cleared'] : []),
                ],
            },
        });
    } catch (error) {
        logger.warn(`[COUNTING] Could not write the log entry for ${action}: ${error?.message ?? error}`);
    }
}
