import { isHomeGuild } from '../utils/singleGuild.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig, setGuildConfig } from './config/guildConfig.js';
import {
    getTicketPanelStatus,
    getVerificationPanelStatus,
} from '../utils/panelStatus.js';
import { summarizePanels } from './reactionRoles/manage.js';

async function persistVerificationMessageId(client, guildId, config, messageId) {
    if (!messageId || config.verification?.messageId === messageId) return;
    // Save against the original guild snapshot: the Discord scan can take long
    // enough for the verification channel or other settings to change.
    config.verification = { ...config.verification, messageId };
    await setGuildConfig(client, guildId, config);
}

export async function reconcileTicketPanels(client) {
    const summary = {
        scannedGuilds: 0,
        healthyPanels: 0,
        deletedPanels: 0,
        missingChannels: 0,
        recoveredIds: 0,
        errors: 0,
    };

    for (const guild of client.guilds.cache.values()) {
        if (!isHomeGuild(client, guild.id)) continue;
        summary.scannedGuilds += 1;

        try {
            const config = await getGuildConfig(client, guild.id);
            if (!config?.ticketPanelChannelId) continue;

            const panelStatus = await getTicketPanelStatus(client, guild, config);

            if (panelStatus.recoveredId) {
                config.ticketPanelMessageId = panelStatus.recoveredId;
                await setGuildConfig(client, guild.id, config);
                summary.recoveredIds += 1;
            }

            if (panelStatus.exists) {
                summary.healthyPanels += 1;
            } else if (panelStatus.reason === 'channel_missing') {
                summary.missingChannels += 1;
                logger.warn(`Ticket panel channel missing for guild ${guild.id} (${guild.name})`);
            } else if (panelStatus.reason === 'panel_deleted') {
                summary.deletedPanels += 1;
                logger.warn(
                    `Ticket panel message deleted for guild ${guild.id} (${guild.name}) — admins can repost from /ticket dashboard`,
                );
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Ticket panel health check failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}

export async function reconcileVerificationPanels(client) {
    const summary = {
        scannedGuilds: 0,
        healthyPanels: 0,
        deletedPanels: 0,
        missingChannels: 0,
        recoveredIds: 0,
        errors: 0,
    };

    for (const guild of client.guilds.cache.values()) {
        if (!isHomeGuild(client, guild.id)) continue;
        summary.scannedGuilds += 1;

        try {
            const config = await getGuildConfig(client, guild.id);
            const verification = config?.verification;
            if (!verification?.channelId || verification.enabled === false) continue;

            const panelStatus = await getVerificationPanelStatus(client, guild, verification);

            if (panelStatus.recoveredId) {
                await persistVerificationMessageId(client, guild.id, config, panelStatus.recoveredId);
                summary.recoveredIds += 1;
            }

            if (panelStatus.exists) {
                summary.healthyPanels += 1;
            } else if (panelStatus.reason === 'channel_missing') {
                summary.missingChannels += 1;
                logger.warn(`Verification panel channel missing for guild ${guild.id} (${guild.name})`);
            } else if (panelStatus.reason === 'panel_deleted') {
                summary.deletedPanels += 1;
                logger.warn(
                    `Verification panel deleted for guild ${guild.id} (${guild.name}) — repost from /verification dashboard`,
                );
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Verification panel health check failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}

/**
 * Count the stored reaction role panels by what Discord shows for them.
 * Reads only. A record is never moved to another message here: with two panels
 * in one channel that used to overwrite the second panel with the first one's roles.
 */
export async function reconcileReactionRolePanelHealth(client) {
    const summary = {
        scannedGuilds: 0,
        scannedPanels: 0,
        healthyPanels: 0,
        deletedPanels: 0,
        missingChannels: 0,
        uncheckedPanels: 0,
        unreadableRecords: 0,
        recoveredIds: 0,
        errors: 0,
    };

    for (const guild of client.guilds.cache.values()) {
        if (!isHomeGuild(client, guild.id)) continue;
        summary.scannedGuilds += 1;

        try {
            const panels = await summarizePanels(client, guild);
            summary.scannedPanels += panels.stored;
            summary.healthyPanels += panels.ok;
            summary.deletedPanels += panels.messageMissing;
            summary.missingChannels += panels.channelMissing;
            summary.uncheckedPanels += panels.unknown;
            summary.unreadableRecords += panels.unreadable;
            if (panels.messageMissing > 0) {
                logger.warn(`Reaction role panel message missing for guild ${guild.id} (${panels.messageMissing}) — repost from /reactroles dashboard`);
            }
            if (panels.channelMissing > 0) {
                logger.warn(`Reaction role panel channel missing for guild ${guild.id} (${panels.channelMissing})`);
            }
        } catch (error) {
            summary.errors += 1;
            logger.warn(`Reaction role panel health check failed for guild ${guild.id}:`, error.message);
        }
    }

    return summary;
}
