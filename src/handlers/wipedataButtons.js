import { createEmbed } from '../utils/embeds.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';

// Old confirmation buttons may survive deployment; they must not trigger a partial wipe.
const wipedataConfirmHandler = {
  name: 'wipedata_yes',
  async execute(interaction) {
    const deferred = await InteractionHelper.safeDefer(interaction, {flags:MessageFlags.Ephemeral});
    if (!deferred) return;
    await interaction.editReply({content:'Data wipe is temporarily unavailable. No data was deleted. Please contact the server administrator for help.',embeds:[],components:[]});
  }
};

const wipedataCancelHandler = {
  name: 'wipedata_no',
  async execute(interaction, client) {
    try {
      await interaction.update({
        embeds: [
          createEmbed({
            title: '❌ Data Wipe Cancelled',
            description: 'Your data has been preserved. Your account remains unchanged.',
            color: 'info'
          })
        ],
        components: []
      });

      logger.info(`User ${interaction.user.tag} (${interaction.user.id}) cancelled data wipe in guild ${interaction.guildId}`);
    } catch (error) {
      logger.error('Wipedata cancel button handler error:', error);
      
      if (!interaction.replied && !interaction.deferred) {
        await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Could not cancel data wipe.' });
      }
    }
  }
};

export { wipedataConfirmHandler, wipedataCancelHandler };