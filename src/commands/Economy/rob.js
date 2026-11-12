import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { attemptRob } from '../../services/economy/rob.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { BotConfig } from '../../config/bot.js';

const ROB_COOLDOWN = BotConfig.economy?.cooldowns?.rob ?? 4 * 60 * 60 * 1000;

export default {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Attempt to rob another user (very risky)')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('User to rob')
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
            
            const robberId = interaction.user.id;
            const victimUser = interaction.options.getUser("user");
            const guildId = interaction.guildId;
            const now = Date.now();

            if (robberId === victimUser.id) {
                throw createError(
                    "Cannot rob self",
                    ErrorTypes.VALIDATION,
                    "You cannot rob yourself.",
                    { robberId, victimId: victimUser.id }
                );
            }
            
            if (victimUser.bot) {
                throw createError(
                    "Cannot rob bot",
                    ErrorTypes.VALIDATION,
                    "You cannot rob a bot.",
                    { victimId: victimUser.id, isBot: true }
                );
            }

            const outcome = await attemptRob({client,guildId,robberId,victimId:victimUser.id,victimName:victimUser.username,now});
            if (outcome.status === 'blocked') {
                return await InteractionHelper.safeEditReply(interaction, { embeds: [warningEmbed('Robbery Blocked', `${victimUser.username} was prepared! Your attempt failed because they own a **Personal Safe**. You got away clean but didn't gain anything.`)] });
            }
            const resultEmbed = outcome.status === 'success'
                ? successEmbed('Robbery Successful', `You successfully stole **$${outcome.amount.toLocaleString()}** from ${victimUser.username}!`)
                : buildUserErrorEmbed('unknown', `You failed the robbery and were caught! You were fined **$${outcome.amount.toLocaleString()}** of your own cash.`, { titleOverride: 'Robbery Failed' });

            resultEmbed
                .addFields(
                    {
                        name: `Your New Cash (${interaction.user.username})`,
                        value: `$${outcome.robberWallet.toLocaleString()}`,
                        inline: true,
                    },
                    {
                        name: `Victim's New Cash (${victimUser.username})`,
                        value: `$${outcome.victimWallet.toLocaleString()}`,
                        inline: true,
                    },
                )
                .setFooter({ text: `Next robbery available in ${Math.ceil(ROB_COOLDOWN / (60 * 60 * 1000))} hours.` });

            await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
    }, { command: 'rob' })
};