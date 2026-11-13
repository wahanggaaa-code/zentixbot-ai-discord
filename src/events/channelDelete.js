import { getTicketData, saveTicketData } from '../utils/database.js';
import { handleJoinToCreateChannelDelete } from '../services/joinToCreateRuntime.js';
import { forgetDeletedCounterChannel } from '../services/serverStats/manage.js';
import { logger } from '../utils/logger.js';

export default {
    name: 'channelDelete',
    async execute(channel, client) {
        
        if (channel.type === 0 && channel.guild) {
            try {
                // A save is refused when another action changed the ticket in between; read again once.
                for (let attempt = 1; attempt <= 2; attempt++) {
                    const ticketData = await getTicketData(channel.guild.id, channel.id);
                    if (!ticketData || ticketData.status !== 'open') break;
                    ticketData.status = 'deleted';
                    ticketData.closedAt = new Date().toISOString();
                    try {
                        await saveTicketData(channel.guild.id, channel.id, ticketData);
                    } catch (saveError) {
                        if (saveError?.code === 'TICKET_STALE' && attempt === 1) continue;
                        throw saveError;
                    }
                    logger.info(`Ticket channel ${channel.id} was manually deleted in guild ${channel.guild.id}, marked as deleted`);
                    break;
                }
            } catch (err) {
                logger.warn(`Could not clean up ticket record for deleted channel ${channel.id}:`, err);
            }
        }

        if (!channel.guild) return;
        const guildId = channel.guild.id;

        // A counter can be a voice or a text channel; the lookup is by channel id, so every type is checked.
        try {
            const removed = await forgetDeletedCounterChannel(client, guildId, channel.id);
            if (removed) {
                logger.info(`Counter channel ${channel.name} (${channel.id}) was deleted, removed counter ${removed.id} (type: ${removed.type}) from guild ${guildId}`);
            }
        } catch (error) {
            // The scheduled counter check removes the record later.
            logger.warn(`Could not remove the counter record of deleted channel ${channel.id} in guild ${guildId}:`, error);
        }

        // Join to Create only concerns voice channels and categories, as before.
        if (channel.type !== 2 && channel.type !== 4) return;

        try {
            await handleJoinToCreateChannelDelete(client, channel);
        } catch (error) {
            // The record is cleaned up later (next join, leave or restart).
            logger.warn(`Join to Create could not process deleted channel ${channel.id} in guild ${guildId}:`, error);
        }
    }
};