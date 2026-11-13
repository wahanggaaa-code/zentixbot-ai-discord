import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { readPanel } from '../services/reactionRoles/store.js';
import { formatLogLine } from '../utils/logging/logEmbeds.js';

const MAX_LOGGED_MESSAGE_CONTENT_LENGTH = 1024;

/**
 * A deleted reaction role panel keeps its stored record, so that the panel can be
 * posted again from the dashboard with its roles and text. Only the log is told.
 * Messages known to come from someone else are not looked up at all.
 */
async function notePanelMessageDeleted(message) {
  const client = message.client;
  if (message.author && message.author.id !== client.user?.id) return;
  try {
    const panel = await readPanel(client, message.guild.id, message.id);
    if (!panel) return;
    logger.info(`Reaction role panel message ${message.id} was deleted in guild ${message.guild.id}; the stored panel is kept for reposting`);
    await logEvent({
      client,
      guildId: message.guild.id,
      eventType: EVENT_TYPES.REACTION_ROLE_DELETE,
      data: {
        title: 'Reaction Role Panel Message Deleted',
        lines: [
          formatLogLine('Channel', message.channel ? `${message.channel.name} ${message.channel.toString()}` : 'Unknown'),
          formatLogLine('Message ID', `\`${message.id}\``),
          formatLogLine('Next step', 'Use /reactroles dashboard to repost or delete the panel'),
        ],
        quoted: true,
      },
    });
  } catch (error) {
    logger.warn(`Failed to handle deleted reaction role panel message ${message.id}:`, error);
  }
}

export default {
  name: Events.MessageDelete,
  once: false,

  async execute(message) {
    try {
      if (!message.guild) return;

      await notePanelMessageDeleted(message);

      if (message.author?.bot) return;

      const metaLines = [
        formatLogLine('Channel', message.channel ? `${message.channel.name} ${message.channel.toString()}` : 'Unknown'),
        formatLogLine('Message ID', `\`${message.id}\``),
        formatLogLine('Message author', message.author ? message.author.toString() : 'Unknown'),
        formatLogLine('Message created', `<t:${Math.floor(message.createdTimestamp / 1000)}:R>`),
      ];

      let messageBody = null;
      if (message.content) {
        messageBody = message.content.length > MAX_LOGGED_MESSAGE_CONTENT_LENGTH
          ? `${message.content.substring(0, MAX_LOGGED_MESSAGE_CONTENT_LENGTH - 3)}...`
          : message.content;
      }

      if (message.attachments.size > 0) {
        metaLines.push(formatLogLine('Attachments', String(message.attachments.size)));
      }

      await logEvent({
        client: message.client,
        guildId: message.guild.id,
        eventType: EVENT_TYPES.MESSAGE_DELETE,
        data: {
          title: 'Message deleted',
          lines: metaLines,
          quoted: true,
          section: messageBody ? { title: 'Message', body: messageBody || '*(empty message)*' } : null,
          userId: message.author?.id,
          channelId: message.channel.id,
        }
      });

    } catch (error) {
      logger.error('Error in messageDelete event:', error);
    }
  }
};
