import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('wipedata')
        .setDescription('Request removal of your personal bot data'),
    async execute(interaction) {
        await InteractionHelper.safeReply(interaction, {
            content:'Data wipe is temporarily unavailable. No data was deleted. Please contact the server administrator for help.',
            flags:MessageFlags.Ephemeral,
        });
    }
};
