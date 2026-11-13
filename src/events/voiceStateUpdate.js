import { logger } from '../utils/logger.js';
import { handleMusicVoiceState } from '../services/music/musicVoiceState.js';
import { handleJoinToCreateVoiceState } from '../services/joinToCreateRuntime.js';

export default {
    name: 'voiceStateUpdate',
    async execute(oldState, newState, client) {
        // Music auto-pause must see every voice change, including bots and
        // guilds where Join to Create is not configured.
        if (client.config?.features?.music) {
            handleMusicVoiceState(client, oldState, newState).catch((error) => {
                logger.error('Music voice state handler error:', error);
            });
        }

        try {
            await handleJoinToCreateVoiceState(client, oldState, newState);
        } catch (error) {
            const guildId = newState?.guild?.id ?? oldState?.guild?.id;
            // Nothing was half-written. Records are brought back in line by
            // the next event for the same channel or at the next startup.
            logger.error(`Join to Create failed to handle a voice event in guild ${guildId}:`, error);
        }
    }
};
