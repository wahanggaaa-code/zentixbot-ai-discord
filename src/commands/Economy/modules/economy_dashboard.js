import {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
    LabelBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ComponentType,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { getColor } from '../../../config/bot.js';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { successEmbed } from '../../../utils/embeds.js';
import { logger } from '../../../utils/logger.js';
import { ZentixBotError, ErrorTypes, replyUserError } from '../../../utils/errorHandler.js';
import { getEconomyPrefix } from '../../../utils/database.js';
import { getEconomyData, addMoney, removeMoney, getMaxBankCapacity } from '../../../utils/economy.js';
import { getGuildConfig, patchGuildConfig } from '../../../services/config/guildConfig.js';
import { economyPool, listEconomyBalances } from '../../../services/economy/accounts.js';
import {
    getCurrency, parseCurrencySymbol, parseCurrencyName, parseAdminAmount, MAX_ADMIN_AMOUNT,
} from '../../../services/economy/currency.js';

const AMOUNT_RULE = `Amount must be a whole number from 1 to ${MAX_ADMIN_AMOUNT.toLocaleString('en-US')}, digits only.`;
const NOT_ALLOWED = 'You need the **Manage Server** permission to use the economy dashboard.';

/** Checked again on every step: the permission may be removed while the dashboard is open. */
export function mayManageEconomy(interaction) {
    return Boolean(interaction?.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

// Stored with the server settings. The bot's source files are never edited:
// text typed in Discord must not end up inside a JavaScript file.
const CURRENCY_SCOPE = 'Saved for this server and shown on this dashboard. '
    + 'Other economy commands still display amounts with `$`.';

async function saveCurrency(client, guildId, change) {
    await patchGuildConfig(client, guildId, { economyCurrency: change });
}

async function currencyOf(client, guildId) {
    return getCurrency(await getGuildConfig(client, guildId));
}

/** Totals of the server: one query on PostgreSQL, no Discord request per account. */
async function economyTotals(guild, client) {
    const isBot = (userId) => guild.members.cache.get(userId)?.user?.bot === true;
    const pool = economyPool(client);
    if (pool) {
        const { accounts } = await listEconomyBalances(pool, guild.id);
        const people = accounts.filter((account) => !isBot(account.userId));
        return { total: people.reduce((sum, account) => sum + account.wallet + account.bank, 0), users: people.length };
    }
    let total = 0;
    let users = 0;
    const economyKeys = await client.db.list(getEconomyPrefix(guild.id));
    for (const key of economyKeys ?? []) {
        if (isBot(key.split(':').pop())) continue;
        const userData = await client.db.get(key, {});
        if (!userData) continue;
        total += (userData.wallet || 0) + (userData.bank || 0);
        users++;
    }
    return { total, users };
}

async function buildDashboardEmbed(guild, client) {
    const { symbol: currencySymbol, name: currencyName } = await currencyOf(client, guild.id);

    let totals = null;
    try {
        totals = await economyTotals(guild, client);
    } catch (error) {
        logger.error('Error calculating economy stats:', error);
    }
    const shown = (value, prefix = '') => (totals ? `\`${prefix}${value.toLocaleString()}\`` : '`unavailable`');
    const totalInCirculation = totals?.total ?? 0;
    const userCount = totals?.users ?? 0;

    const avgBalance = userCount > 0 ? Math.floor(totalInCirculation / userCount) : 0;

    return new EmbedBuilder()
        .setTitle('💰 Economy Dashboard')
        .setDescription(`Manage the economy system for **${guild.name}**.\nSelect an option below to perform an action.`)
        .setColor(getColor('economy'))
        .addFields(
            { name: '💰 Total in Circulation', value: shown(totalInCirculation, currencySymbol), inline: true },
            { name: '👥 Active Users', value: shown(userCount), inline: true },
            { name: '📊 Average Balance', value: shown(avgBalance, currencySymbol), inline: true },
            { name: '💱 Currency Symbol', value: `\`${currencySymbol}\``, inline: true },
            { name: '📝 Currency Name', value: `\`${currencyName}\``, inline: true },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();
}

function buildSelectMenu(guildId) {
    return new StringSelectMenuBuilder()
        .setCustomId(`economy_dashboard_${guildId}`)
        .setPlaceholder('Select an action...')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Add Currency')
                .setDescription('Add currency to a user\'s wallet or bank')
                .setValue('add_currency')
                .setEmoji('💰'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Remove Currency')
                .setDescription('Remove currency from a user\'s wallet or bank')
                .setValue('remove_currency')
                .setEmoji('💸'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Currency Symbol')
                .setDescription('Change the currency symbol (e.g., $, €, £)')
                .setValue('change_currency')
                .setEmoji('💱'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Change Currency Name')
                .setDescription('Change the currency name (e.g., coins, credits)')
                .setValue('change_name')
                .setEmoji('📝'),
        );
}

async function refreshDashboard(rootInteraction, guild, client) {
    const selectMenu = buildSelectMenu(guild.id);
    await InteractionHelper.safeEditReply(rootInteraction, {
        embeds: [await buildDashboardEmbed(guild, client)],
        components: [
            new ActionRowBuilder().addComponents(selectMenu),
        ],
    }).catch(() => {});
}

export default {
    prefixOnly: false,
    async execute(interaction, config, client) {
        try {
            const guild = interaction.guild;
            const selectMenu = buildSelectMenu(guild.id);
            const selectRow = new ActionRowBuilder().addComponents(selectMenu);

            await InteractionHelper.safeEditReply(interaction, {
                embeds: [await buildDashboardEmbed(guild, client)],
                components: [selectRow],
            });

            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.StringSelect,
                filter: i =>
                    i.user.id === interaction.user.id && i.customId === `economy_dashboard_${guild.id}`,
                time: 600_000,
            });

            collector.on('collect', async selectInteraction => {
                const selectedOption = selectInteraction.values[0];
                try {
                    if (!mayManageEconomy(selectInteraction)) {
                        await replyUserError(selectInteraction, { type: ErrorTypes.PERMISSION, message: NOT_ALLOWED });
                        return;
                    }
                    switch (selectedOption) {
                        case 'add_currency':
                            await handleAddCurrency(selectInteraction, interaction, guild, client);
                            break;
                        case 'remove_currency':
                            await handleRemoveCurrency(selectInteraction, interaction, guild, client);
                            break;
                        case 'change_currency':
                            await handleChangeCurrency(selectInteraction, interaction, guild, client);
                            break;
                        case 'change_name':
                            await handleChangeName(selectInteraction, interaction, guild, client);
                            break;
                    }
                } catch (error) {
                    if (error instanceof ZentixBotError) {
                        logger.debug(`Economy dashboard validation error: ${error.message}`);
                    } else {
                        logger.error('Unexpected economy dashboard error:', error);
                    }

                    const errorMessage =
                        error instanceof ZentixBotError
                            ? error.userMessage || 'An error occurred while processing your selection.'
                            : 'An unexpected error occurred while processing your request.';

                    if (!selectInteraction.replied && !selectInteraction.deferred) {
                        await selectInteraction.deferUpdate().catch(() => {});
                    }

                    await replyUserError(selectInteraction, {
                        type: ErrorTypes.UNKNOWN,
                        message: errorMessage,
                    }).catch(() => {});
                }
            });

            collector.on('end', async (collected, reason) => {
                if (reason === 'time') {
                    const timeoutEmbed = new EmbedBuilder()
                        .setTitle('Dashboard Timed Out')
                        .setDescription('This dashboard has been closed due to inactivity. Please run the command again to continue.')
                        .setColor(getColor('error'));
                    
                    await InteractionHelper.safeEditReply(interaction, {
                        embeds: [timeoutEmbed],
                        components: [],
                    }).catch(() => {});
                }
            });
        } catch (error) {
            if (error instanceof ZentixBotError) throw error;
            logger.error('Unexpected error in economy_dashboard:', error);
            throw new ZentixBotError(
                `Economy dashboard failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the economy dashboard.',
            );
        }
    },
};

async function handleAddCurrency(selectInteraction, rootInteraction, guild, client) {
    const modal = new ModalBuilder()
        .setCustomId(`economy_add_currency_${guild.id}`)
        .setTitle('Add Currency');

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('target_user')
        .setPlaceholder('Select a user...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const userLabel = new LabelBuilder()
        .setLabel('Target User')
        .setDescription('User to add currency to')
        .setUserSelectMenuComponent(userSelect);

    const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Amount to add')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('100')
        .setMinLength(1)
        .setMaxLength(10)
        .setRequired(true);

    const typeInput = new TextInputBuilder()
        .setCustomId('type')
        .setLabel('Type (wallet or bank)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('wallet')
        .setMinLength(1)
        .setMaxLength(5)
        .setRequired(true);

    modal.addLabelComponents(userLabel);
    modal.addComponents(
        new ActionRowBuilder().addComponents(amountInput),
        new ActionRowBuilder().addComponents(typeInput),
    );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `economy_add_currency_${guild.id}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;
    if (!mayManageEconomy(submitted)) {
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: NOT_ALLOWED });
        return;
    }

    const userId = submitted.fields.getField('target_user').values[0];
    const amount = parseAdminAmount(submitted.fields.getTextInputValue('amount'));
    const type = submitted.fields.getTextInputValue('type').trim().toLowerCase();

    if (amount === null) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: AMOUNT_RULE });
        return;
    }

    if (type !== 'wallet' && type !== 'bank') {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Type must be either "wallet" or "bank".' });
        return;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'The specified user is not in this server.' });
        return;
    }

    if (member.user.bot) {
        await replyUserError(submitted, { type: ErrorTypes.UNKNOWN, message: 'Bots do not have economy accounts.' });
        return;
    }

    const { newBalance } = await addMoney(client, guild.id, userId, amount, type);

    const { symbol: currencySymbol } = await currencyOf(client, guild.id);

    await submitted.reply({
        embeds: [successEmbed('Currency Added', `Successfully added ${currencySymbol}${amount.toLocaleString()} to ${member.user.tag}'s ${type}.\n**New Balance:** ${currencySymbol}${newBalance.toLocaleString()}`)],
        flags: MessageFlags.Ephemeral,
    });

    logger.info(`[ECONOMY_DASHBOARD] Currency added`, {
        adminId: submitted.user.id,
        targetUserId: userId,
        amount,
        type,
        newBalance,
    });

    await refreshDashboard(rootInteraction, guild, client);
}

async function handleRemoveCurrency(selectInteraction, rootInteraction, guild, client) {
    const modal = new ModalBuilder()
        .setCustomId(`economy_remove_currency_${guild.id}`)
        .setTitle('Remove Currency');

    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('target_user')
        .setPlaceholder('Select a user...')
        .setMinValues(1)
        .setMaxValues(1)
        .setRequired(true);

    const userLabel = new LabelBuilder()
        .setLabel('Target User')
        .setDescription('User to remove currency from')
        .setUserSelectMenuComponent(userSelect);

    const amountInput = new TextInputBuilder()
        .setCustomId('amount')
        .setLabel('Amount to remove')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('100')
        .setMinLength(1)
        .setMaxLength(10)
        .setRequired(true);

    const typeInput = new TextInputBuilder()
        .setCustomId('type')
        .setLabel('Type (wallet or bank)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('wallet')
        .setMinLength(1)
        .setMaxLength(5)
        .setRequired(true);

    modal.addLabelComponents(userLabel);
    modal.addComponents(
        new ActionRowBuilder().addComponents(amountInput),
        new ActionRowBuilder().addComponents(typeInput),
    );

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `economy_remove_currency_${guild.id}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;
    if (!mayManageEconomy(submitted)) {
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: NOT_ALLOWED });
        return;
    }

    const userId = submitted.fields.getField('target_user').values[0];
    const amount = parseAdminAmount(submitted.fields.getTextInputValue('amount'));
    const type = submitted.fields.getTextInputValue('type').trim().toLowerCase();

    if (amount === null) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: AMOUNT_RULE });
        return;
    }

    if (type !== 'wallet' && type !== 'bank') {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'Type must be either "wallet" or "bank".' });
        return;
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: 'The specified user is not in this server.' });
        return;
    }

    if (member.user.bot) {
        await replyUserError(submitted, { type: ErrorTypes.UNKNOWN, message: 'Bots do not have economy accounts.' });
        return;
    }

    const { newBalance } = await removeMoney(client, guild.id, userId, amount, type);

    const { symbol: currencySymbol } = await currencyOf(client, guild.id);

    await submitted.reply({
        embeds: [successEmbed('Currency Removed', `Successfully removed ${currencySymbol}${amount.toLocaleString()} from ${member.user.tag}'s ${type}.\n**New Balance:** ${currencySymbol}${newBalance.toLocaleString()}`)],
        flags: MessageFlags.Ephemeral,
    });

    logger.info(`[ECONOMY_DASHBOARD] Currency removed`, {
        adminId: submitted.user.id,
        targetUserId: userId,
        amount,
        type,
        newBalance,
    });

    await refreshDashboard(rootInteraction, guild, client);
}

async function handleChangeCurrency(selectInteraction, rootInteraction, guild, client) {
    const current = await currencyOf(client, guild.id);
    const modal = new ModalBuilder()
        .setCustomId(`economy_change_currency_${guild.id}`)
        .setTitle('Change Currency Symbol');

    const symbolInput = new TextInputBuilder()
        .setCustomId('currency_symbol')
        .setLabel('New Currency Symbol')
        .setStyle(TextInputStyle.Short)
        .setValue(current.symbol)
        .setPlaceholder('$')
        .setMinLength(1)
        .setMaxLength(6)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(symbolInput));

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `economy_change_currency_${guild.id}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;
    if (!mayManageEconomy(submitted)) {
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: NOT_ALLOWED });
        return;
    }

    const newSymbol = parseCurrencySymbol(submitted.fields.getTextInputValue('currency_symbol'));

    if (newSymbol === null) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: 'Currency symbol must be 1-3 letters, digits, currency signs or emoji.',
        });
        return;
    }

    await saveCurrency(client, guild.id, { symbol: newSymbol });

    await submitted.reply({
        embeds: [successEmbed('Currency Symbol Updated', `Currency symbol changed to **${newSymbol}**.\n\n${CURRENCY_SCOPE}`)],
        flags: MessageFlags.Ephemeral,
    });

    logger.info(`[ECONOMY_DASHBOARD] Currency symbol changed`, {
        adminId: submitted.user.id,
        oldSymbol: current.symbol,
        newSymbol
    });

    await refreshDashboard(rootInteraction, guild, client);
}

async function handleChangeName(selectInteraction, rootInteraction, guild, client) {
    const current = await currencyOf(client, guild.id);
    const modal = new ModalBuilder()
        .setCustomId(`economy_change_name_${guild.id}`)
        .setTitle('Change Currency Name');

    const nameInput = new TextInputBuilder()
        .setCustomId('currency_name')
        .setLabel('New Currency Name')
        .setStyle(TextInputStyle.Short)
        .setValue(current.name)
        .setPlaceholder('coins')
        .setMinLength(1)
        .setMaxLength(20)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

    await selectInteraction.showModal(modal);

    const submitted = await selectInteraction
        .awaitModalSubmit({
            filter: i => i.customId === `economy_change_name_${guild.id}` && i.user.id === selectInteraction.user.id,
            time: 120_000,
        })
        .catch(() => null);

    if (!submitted) return;
    if (!mayManageEconomy(submitted)) {
        await replyUserError(submitted, { type: ErrorTypes.PERMISSION, message: NOT_ALLOWED });
        return;
    }

    const newName = parseCurrencyName(submitted.fields.getTextInputValue('currency_name'));

    if (newName === null) {
        await replyUserError(submitted, {
            type: ErrorTypes.VALIDATION,
            message: 'Currency name must be 1-20 letters, digits, spaces or hyphens.',
        });
        return;
    }

    await saveCurrency(client, guild.id, { name: newName });

    await submitted.reply({
        embeds: [successEmbed('Currency Name Updated', `Currency name changed to **${newName}**.\n\n${CURRENCY_SCOPE}`)],
        flags: MessageFlags.Ephemeral,
    });

    logger.info(`[ECONOMY_DASHBOARD] Currency name changed`, {
        adminId: submitted.user.id,
        oldName: current.name,
        newName
    });

    await refreshDashboard(rootInteraction, guild, client);
}
