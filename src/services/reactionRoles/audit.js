// A line in the bot's log channel for every change to a reaction role panel,
// whether it came from /reactroles or from the web dashboard.

import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { logger } from '../../utils/logger.js';

const ACTIONS = {
    create: [EVENT_TYPES.REACTION_ROLE_CREATE, 'Reaction Role Panel Created'],
    repost: [EVENT_TYPES.REACTION_ROLE_CREATE, 'Reaction Role Panel Reposted'],
    delete: [EVENT_TYPES.REACTION_ROLE_DELETE, 'Reaction Role Panel Deleted'],
    role_add: [EVENT_TYPES.REACTION_ROLE_UPDATE, 'Role Added To Reaction Role Panel'],
    role_remove: [EVENT_TYPES.REACTION_ROLE_UPDATE, 'Role Removed From Reaction Role Panel'],
    text: [EVENT_TYPES.REACTION_ROLE_UPDATE, 'Reaction Role Panel Text Changed'],
};
const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);

/**
 * Best effort: never throws, and the change it describes has already happened.
 * `details`: `{actorId, source, messageId, channelId?, title?, roleIds?, roleId?}`.
 */
export async function recordPanelChange(client, guildId, action, details = {}) {
    const known = ACTIONS[action];
    if (!known) return;
    try {
        const roleIds = (Array.isArray(details.roleIds) ? details.roleIds : []).filter(isId);
        await logEvent({
            client,
            guildId,
            eventType: known[0],
            data: {
                title: known[1],
                lines: [
                    `**Source:** ${details.source === 'dashboard' ? 'web dashboard' : '/reactroles'}`,
                    ...(isId(details.actorId) ? [`**By:** <@${details.actorId}> (${details.actorId})`] : []),
                    ...(isId(details.messageId) ? [`**Message:** ${details.messageId}`] : []),
                    ...(isId(details.channelId) ? [`**Channel:** <#${details.channelId}>`] : []),
                    ...(details.title ? [`**Panel:** ${String(details.title).slice(0, 256)}`] : []),
                    ...(isId(details.roleId) ? [`**Role:** <@&${details.roleId}> (${details.roleId})`] : []),
                    ...(roleIds.length ? [`**Roles:** ${roleIds.map((id) => `<@&${id}>`).join(', ').slice(0, 900)}`] : []),
                ],
            },
        });
    } catch (error) {
        logger.warn(`[REACTROLES] Could not write the log entry for ${action}: ${error?.message ?? error}`);
    }
}
