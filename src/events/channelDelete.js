import { getTicketData, saveTicketData } from '../utils/database.js';
import { handleJoinToCreateChannelDelete } from '../services/joinToCreateRuntime.js';
import { getServerCounters, saveServerCounters } from '../services/serverstatsService.js';
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

if (channel.type !== 2 && channel.type !== 4) {
            return;
        }

        const guildId = channel.guild.id;

        try {
            
            const counters = await getServerCounters(client, guildId);
            const orphanedCounter = counters.find(c => c.channelId === channel.id);
            
            if (orphanedCounter) {
                logger.info(`Counter channel ${channel.name} (${channel.id}) was deleted, removing counter ${orphanedCounter.id} from database`);
                
                const updatedCounters = counters.filter(c => c.channelId !== channel.id);
                const success = await saveServerCounters(client, guildId, updatedCounters);
                
                if (success) {
                    logger.info(`Successfully removed orphaned counter ${orphanedCounter.id} (type: ${orphanedCounter.type}) from guild ${guildId}`);
                } else {
                    logger.warn(`Failed to remove orphaned counter ${orphanedCounter.id} from guild ${guildId}`);
                }
            }

        } catch (error) {
            logger.error(`Error in channelDelete event for guild ${guildId}:`, error);
        }

        try {
            await handleJoinToCreateChannelDelete(client, channel);
        } catch (error) {
            // The record is cleaned up later (next join, leave or restart).
            logger.warn(`Join to Create could not process deleted channel ${channel.id} in guild ${guildId}:`, error);
        }
    }
};