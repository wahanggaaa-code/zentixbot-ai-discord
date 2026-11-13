import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
  MAX_START,
  countingErrorMessage,
  disableGame,
  getCountingSystemChoices,
  getCountingSystemLabel,
  inspectGame,
  resetGame,
  setupGame,
} from '../../services/countingGame/manage.js';
import { recordGameChange } from '../../services/countingGame/audit.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

const PERMISSION_LABELS = { ViewChannel: 'View Channel', SendMessages: 'Send Messages', ManageMessages: 'Manage Messages' };
/** Subcommands that change the game. `status` and `leaderboard` only read. */
const CHANGES = new Set(['setup', 'disable', 'reset']);

const ERROR_TYPES = {
  COUNTING_SYSTEM: ErrorTypes.VALIDATION,
  COUNTING_CHANNEL: ErrorTypes.VALIDATION,
  COUNTING_START: ErrorTypes.VALIDATION,
  COUNTING_BOT_PERMISSION: ErrorTypes.PERMISSION,
  COUNTING_ACTIVE_ELSEWHERE: ErrorTypes.VALIDATION,
  COUNTING_NOT_ENABLED: ErrorTypes.VALIDATION,
  COUNTING_INVALID: ErrorTypes.DATABASE,
  COUNTING_UNAVAILABLE: ErrorTypes.DATABASE,
  COUNTING_UNCERTAIN: ErrorTypes.DATABASE,
};

function healthLine(view) {
  const { health, game } = view;
  if (health.state === 'channel_missing') return `The counting channel (${game.channelId}) no longer exists or is hidden from me. Disable the game and set it up again.`;
  if (health.state === 'permissions') {
    return `I am missing ${health.missing.map((flag) => `**${PERMISSION_LABELS[flag] ?? flag}**`).join(', ')} in <#${game.channelId}>. Wrong counts cannot be handled properly until that is fixed.`;
  }
  return null;
}

export default {
  data: new SlashCommandBuilder()
    .setName('count')
    .setDescription('Manage the server counting game')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('setup')
        .setDescription('Start a counting game in a text channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The channel where counting will take place')
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((option) =>
          option
            .setName('system')
            .setDescription('The counting system to use')
            .setRequired(true)
            .addChoices(...getCountingSystemChoices()),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('disable').setDescription('Disable the counting game for this server'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('status').setDescription('View current counting game status'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reset')
        .setDescription('Reset the current counting sequence')
        .addIntegerOption((option) =>
          option
            .setName('start')
            .setDescription('The number to start at after reset')
            .setMinValue(1)
            .setMaxValue(MAX_START),
        )
        .addBooleanOption((option) =>
          option
            .setName('clear_scores')
            .setDescription('Also empty the leaderboard and the best streak'),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('leaderboard').setDescription('Show the counting game leaderboard'),
    ),
  category: 'Fun',

  async execute(interaction) {
    try {
      const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
      if (!deferSuccess) {
        logger.warn('Count command defer failed', { userId: interaction.user.id, guildId: interaction.guildId });
        return;
      }
      if (!interaction.guild) {
        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This command can only be used in a server.' });
      }

      const subcommand = interaction.options.getSubcommand();
      // Discord decides who may run /count at all; changing the game always needs Manage Server.
      if (CHANGES.has(subcommand) && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to change the counting game.' });
      }

      const { client, guild } = interaction;
      const reply = (embed) => InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
      const record = (action, details) => recordGameChange(client, guild.id, action, { source: 'command', actorId: interaction.user.id, ...details });

      if (subcommand === 'setup') {
        const channel = interaction.options.getChannel('channel');
        const system = interaction.options.getString('system');
        const { changed, game } = await setupGame(client, guild, { channelId: channel?.id, system });
        if (!changed) {
          return await reply(infoEmbed('Counting Game Already Active', `The counting game is already running in <#${game.channelId}> with the **${getCountingSystemLabel(game.system)}** system. Nothing was changed.`));
        }
        await record('setup', { channelId: game.channelId, system: getCountingSystemLabel(game.system) });
        return await reply(successEmbed(
          'Counting Game Enabled',
          `The counting game is now active in <#${game.channelId}> using the **${getCountingSystemLabel(game.system)}** system. Players must count up from **1** and may not post two numbers in a row. The leaderboard and the best streak are kept.`,
        ));
      }

      if (subcommand === 'disable') {
        const { changed, game } = await disableGame(client, guild);
        if (!changed) return await reply(infoEmbed('Counting Game Disabled', 'The counting game is already disabled for this server.'));
        await record('disable', { channelId: game.channelId });
        return await reply(successEmbed('Counting Game Disabled', 'The counting game has been disabled. The leaderboard and the best streak are kept.'));
      }

      if (subcommand === 'reset') {
        const start = interaction.options.getInteger('start') ?? 1;
        const clearScores = interaction.options.getBoolean('clear_scores') === true;
        const { game } = await resetGame(client, guild, { start, clearScores });
        await record('reset', { channelId: game.channelId, start, scoresCleared: clearScores });
        return await reply(successEmbed(
          'Counting Game Reset',
          `The counting sequence has been reset. Start again with **${start}** in <#${game.channelId}>.${clearScores ? ' The leaderboard and the best streak were cleared.' : ''}`,
        ));
      }

      if (subcommand === 'status') {
        const view = await inspectGame(client, guild);
        const { game } = view;
        const warning = healthLine(view);
        const build = warning ? warningEmbed : null;
        const fields = [
          { name: 'Enabled', value: game.enabled ? 'Yes' : 'No', inline: true },
          { name: 'Channel', value: game.channelId ? `<#${game.channelId}>` : 'Not configured', inline: true },
          { name: 'System', value: getCountingSystemLabel(game.system), inline: true },
          { name: 'Next count', value: view.expected, inline: true },
          { name: 'Current streak', value: `${game.currentStreak}`, inline: true },
          { name: 'Best streak', value: `${game.bestStreak}`, inline: true },
          { name: 'Last counter', value: game.lastUserId ? `<@${game.lastUserId}>` : 'None', inline: true },
        ];
        if (build) {
          const embed = build('Counting Game Status', warning);
          embed.addFields(fields);
          return await reply(embed);
        }
        return await reply(createEmbed({
          title: 'Counting Game Status',
          description: 'Overview of the currently configured counting game.',
          fields,
          color: 'primary',
        }));
      }

      if (subcommand === 'leaderboard') {
        const view = await inspectGame(client, guild);
        const lines = view.top.map((entry, index) => `**${index + 1}.** <@${entry.userId}> — ${entry.counts} ${entry.counts === 1 ? 'count' : 'counts'}`);
        return await reply(createEmbed({
          title: 'Counting Game Leaderboard',
          description: lines.length > 0 ? lines.join('\n') : 'No counts have been recorded yet.',
          color: 'primary',
        }));
      }

      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please choose a valid counting game action.' });
    } catch (error) {
      const type = ERROR_TYPES[error?.code];
      if (type) {
        if (type === ErrorTypes.DATABASE) logger.error(`Count command storage failure (${error.code}): ${error.cause?.message ?? error.message}`);
        let message = countingErrorMessage(error, 'en', 'Something went wrong while managing the counting game.');
        if (error.code === 'COUNTING_ACTIVE_ELSEWHERE' && error.channelId) message = `The counting game is already running in <#${error.channelId}>. Disable it first with \`/count disable\`, then set it up again.`;
        return await replyUserError(interaction, { type, message });
      }
      logger.error('Count command error:', error);
      return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Something went wrong while managing the counting game. Check `/count status` before trying again.' });
    }
  },
};
