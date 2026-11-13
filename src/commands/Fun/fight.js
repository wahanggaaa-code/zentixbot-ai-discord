import { SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const EMBED_DESCRIPTION_LIMIT = 4096;
const ACTIONS = [
  "throws a wild punch",
  "lands a critical hit",
  "uses a weak spell",
  "parries and counterattacks",
];
/** A name as plain text: underscores and stars in a username must not turn into formatting. */
const nameOf = (user) => escapeMarkdown(String(user.username ?? 'Unknown'));

export default {
    data: new SlashCommandBuilder()
    .setName("fight")
    .setDescription("Starts a simulated 1v1 text-based battle.")
    .addUserOption((option) =>
      option
        .setName("opponent")
        .setDescription("The user to fight.")
        .setRequired(true),
    ),
  category: 'Fun',

  async execute(interaction, config, client) {
    await InteractionHelper.safeDefer(interaction);

    const challenger = interaction.user;
    const opponent = interaction.options.getUser("opponent");

    if (challenger.id === opponent.id) {
      const embed = warningEmbed(
        "⚔️ Invalid Challenge",
        `**${nameOf(challenger)}**, you can't fight yourself! That's a draw before it even starts.`
      );
      return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    if (opponent.bot) {
      const embed = warningEmbed(
        "⚔️ Invalid Opponent",
        "You can't fight bots! Challenge a real person instead."
      );
      return await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }

    const rounds = rand(3, 7);
    const maxDamage = rand(10, 50);
    const dealt = new Map([[challenger.id, 0], [opponent.id, 0]]);

    const log = [];
    log.push(
      `💥 **${nameOf(challenger)}** challenges **${nameOf(opponent)}** to a duel! (${rounds} rounds)`,
    );

    for (let i = 1; i <= rounds; i++) {
      const attacker = rand(0, 1) === 0 ? challenger : opponent;
      const target = attacker.id === challenger.id ? opponent : challenger;
      const damage = rand(1, maxDamage);
      dealt.set(attacker.id, dealt.get(attacker.id) + damage);
      log.push(
        `\n**Round ${i}:** ${nameOf(attacker)} ${ACTIONS[rand(0, ACTIONS.length - 1)]} on ${nameOf(target)} for ${damage} damage!`,
      );
    }

    // The winner is whoever dealt more damage in the rounds above; a tie is decided by a coin.
    const mine = dealt.get(challenger.id);
    const theirs = dealt.get(opponent.id);
    const tie = mine === theirs;
    const challengerWins = tie ? rand(0, 1) === 0 : mine > theirs;
    const winner = challengerWins ? challenger : opponent;
    const loser = challengerWins ? opponent : challenger;

    const outcomeText = log.join("\n");
    const scoreText = `**Damage dealt:** ${nameOf(challenger)} ${mine} — ${nameOf(opponent)} ${theirs}${tie ? ' (a tie, settled by a coin flip)' : ''}`;
    const winnerText = `👑 **${nameOf(winner)}** has defeated ${nameOf(loser)} and claims the victory!`;
    const fullDescription = `${outcomeText}\n\n${scoreText}\n${winnerText}`;

    const description = fullDescription.length <= EMBED_DESCRIPTION_LIMIT
      ? fullDescription
      : `${fullDescription.slice(0, EMBED_DESCRIPTION_LIMIT - 15)}\n\n...`;

    const embed = successEmbed(
      "🏆 Duel Complete!",
      description
    );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    logger.debug(`Fight command executed between ${challenger.id} and ${opponent.id} in guild ${interaction.guildId}`);
  },
};
