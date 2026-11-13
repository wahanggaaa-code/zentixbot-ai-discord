import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { plainText } from '../../services/searchLookup.js';

const ROLES_SHOWN = 10;

export default {
    data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Get detailed information about a user")
    .setDMPermission(false)
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("The user to inspect (defaults to you)"),
    ),

  async execute(interaction) {
    const guild = interaction.guild;
    if (!guild) {
      return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This command can only be used in a server.' });
    }

    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`UserInfo interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'userinfo'
      });
      return;
    }

    const target = interaction.options.getUser("target");
    const user = target || interaction.user;
    // Discord sends the member along with the command; the cache may not have them.
    const sent = target ? interaction.options.getMember?.("target") : interaction.member;
    const member = [sent, guild.members.cache.get(user.id)].find((entry) => entry?.roles?.cache) ?? null;

    const createdTimestamp = Math.floor(user.createdAt.getTime() / 1000);
    const joinedTimestamp = member?.joinedAt ? Math.floor(member.joinedAt.getTime() / 1000) : null;

    // Every member has @everyone (its id is the server's id); it says nothing about them.
    const roles = member
      ? [...member.roles.cache.values()].filter((role) => role.id !== guild.id).sort((a, b) => b.position - a.position)
      : [];
    const roleList = roles.slice(0, ROLES_SHOWN).map((role) => `<@&${role.id}>`).join(", ")
      + (roles.length > ROLES_SHOWN ? ` and ${roles.length - ROLES_SHOWN} more` : "");

    const embed = createEmbed({ title: `User Info: ${plainText(user.username, 100)}` })
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "ID", value: user.id, inline: true },
        { name: "Bot", value: user.bot ? "Yes" : "No", inline: true },
        { name: "Roles", value: roleList || "None", inline: true },
        {
          name: "Account Created",
          value: `<t:${createdTimestamp}:R>`,
          inline: false,
        },
        {
          name: "Joined Server",
          value: joinedTimestamp ? `<t:${joinedTimestamp}:R>` : (member ? "Unknown" : "Not in server"),
          inline: false,
        },
        {
          name: "Highest Role",
          value: roles.length > 0 ? `<@&${roles[0].id}>` : "None",
          inline: true,
        },
      );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed], allowedMentions: { parse: [] } });
    logger.info(`UserInfo command executed`, {
      userId: interaction.user.id,
      targetUserId: user.id,
      guildId: interaction.guildId
    });
  },
};
