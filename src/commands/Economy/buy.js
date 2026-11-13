import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { shopItems } from '../../config/shop/items.js';
import { purchaseInventoryItem } from '../../services/economy/shop.js';
import { purchasePremiumRole, PREMIUM_ITEM_ID } from '../../services/economy/premiumRole.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const SHOP_ITEMS = shopItems;

export default {
    data: new SlashCommandBuilder()
        .setName('buy')
        .setDescription('Buy an item from the shop')
        .addStringOption(option =>
            option
                .setName('item_id')
                .setDescription('ID of the item to buy')
                .setRequired(true)
        )
        .addIntegerOption(option =>
            option
                .setName('quantity')
                .setDescription('Quantity to buy (default: 1)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(10)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

            const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const itemId = interaction.options.getString("item_id").toLowerCase();
            const quantity = interaction.options.getInteger("quantity") || 1;

            const item = SHOP_ITEMS.find(i => i.id === itemId);

            if (!item) {
                throw createError(
                    `Item ${itemId} not found`,
                    ErrorTypes.VALIDATION,
                    `The item ID \`${itemId}\` does not exist in the shop.`,
                    { itemId }
                );
            }

            if (quantity < 1) {
                throw createError(
                    "Invalid quantity",
                    ErrorTypes.VALIDATION,
                    "You must purchase a quantity of 1 or more.",
                    { quantity }
                );
            }

            if (item.type === 'role') {
                if (itemId !== PREMIUM_ITEM_ID) {
                    throw createError('Unsupported item', ErrorTypes.VALIDATION, 'This item is not available.', { itemId });
                }
                if (quantity > 1) {
                    throw createError(
                        "Invalid quantity for role",
                        ErrorTypes.VALIDATION,
                        `You can only purchase the **${item.name}** role once.`,
                        { itemId, quantity }
                    );
                }

                // Payment, role and refund are handled as one protocol; see premiumRole.js.
                const result = await purchasePremiumRole({ client, guild: interaction.guild, member: interaction.member, item });
                const paid = result.status === 'resumed'
                    ? `Your earlier payment of **$${result.price.toLocaleString()}** for **${item.name}** was still open. You were not charged again.`
                    : `You successfully purchased 1x **${item.name}** for **$${result.price.toLocaleString()}**!`;
                const embed = successEmbed(
                    '💰 Purchase Successful',
                    `${paid}\n\n**👑 The role ${result.role.toString()} has been granted to you!**`,
                ).addFields({ name: 'New Balance', value: `$${result.wallet.toLocaleString()}`, inline: true });
                await InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
                return;
            }

            const { wallet, totalCost } = await purchaseInventoryItem({ client, guildId, userId, item, quantity });
            let description = `You successfully purchased ${quantity}x **${item.name}** for **$${totalCost.toLocaleString()}**!`;
            if (item.type === 'upgrade') description += '\n\n**✨ Your upgrade is now active!**';
            else if (item.type === 'tool') description += `\n\n**🛠️ ${item.name} added to your inventory!**`;
            const embed = successEmbed('💰 Purchase Successful', description)
                .addFields({ name: 'New Balance', value: `$${wallet.toLocaleString()}`, inline: true });
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed], flags: [MessageFlags.Ephemeral] });
    }, { command: 'buy' })
};