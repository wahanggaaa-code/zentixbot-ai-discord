import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { successEmbed, buildUserErrorEmbed } from '../../utils/embeds.js';
import { getMaxBankCapacity } from '../../utils/economy.js';
import { withEconomyTransaction } from '../../services/economy/transaction.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('deposit')
        .setDescription('Deposit money from your wallet into your bank')
        .addStringOption(option =>
            option
                .setName('amount')
                .setDescription('Amount to deposit (number or "all")')
                .setRequired(true)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;
        
        const userId = interaction.user.id;
            const guildId = interaction.guildId;
            const amountInput = interaction.options.getString("amount");

            const result = await withEconomyTransaction(client,guildId,[userId],accounts => {
                const userData = accounts.get(userId), warnings=[];
                const maxBank = getMaxBankCapacity(userData);
                let depositAmount;

                if (amountInput.toLowerCase() === "all") {
                    depositAmount = userData.wallet;
                } else {
                    depositAmount = parseInt(amountInput);

                    if (isNaN(depositAmount) || depositAmount <= 0) {
                        throw createError(
                            "Invalid deposit amount",
                            ErrorTypes.VALIDATION,
                            `Please enter a valid number or 'all'. You entered: \`${amountInput}\``,
                            { amountInput, userId }
                        );
                    }
                }

                if (depositAmount === 0) {
                    throw createError(
                        "Zero deposit amount",
                        ErrorTypes.VALIDATION,
                        "You have no cash to deposit.",
                        { userId, walletBalance: userData.wallet }
                    );
                }

                if (depositAmount > userData.wallet) {
                    depositAmount = userData.wallet;
                    warnings.push(`You tried to deposit more than you have. Depositing your remaining cash: **$${depositAmount.toLocaleString()}**`);
                }

                const availableSpace = maxBank - userData.bank;

                if (availableSpace <= 0) {
                    throw createError(
                        "Bank is full",
                        ErrorTypes.VALIDATION,
                        `Your bank is currently full (Max Capacity: $${maxBank.toLocaleString()}). Purchase a **Bank Upgrade** to increase your limit.`,
                        { maxBank, currentBank: userData.bank, userId }
                    );
                }

                if (depositAmount > availableSpace) {
                    depositAmount = availableSpace;
                    if (amountInput.toLowerCase() !== "all") warnings.push(`You only had space for **$${depositAmount.toLocaleString()}** in your bank account (Max: $${maxBank.toLocaleString()}). The rest remains in your cash.`);
                }

                if (depositAmount === 0) {
                    throw createError(
                        "No space or cash for deposit",
                        ErrorTypes.VALIDATION,
                        "The amount you tried to deposit was either 0 or exceeded your bank capacity after checking your cash balance.",
                        { depositAmount, availableSpace, walletBalance: userData.wallet }
                    );
                }

                userData.wallet -= depositAmount;
                userData.bank += depositAmount;

                return {depositAmount,maxBank,wallet:userData.wallet,bank:userData.bank,warnings};
            });
            const {depositAmount,maxBank,wallet,bank,warnings}=result;
            for (const warning of warnings) await interaction.followUp({embeds:[buildUserErrorEmbed('validation',warning)],flags:MessageFlags.Ephemeral}).catch(()=>{});

            const embed = successEmbed(
                'Deposit Successful',
                `You successfully deposited **$${depositAmount.toLocaleString()}** into your bank.`
            )
                .addFields(
                    {
                        name: "New Cash Balance",
                        value: `$${wallet.toLocaleString()}`,
                        inline: true,
                    },
                    {
                        name: "New Bank Balance",
                        value: `$${bank.toLocaleString()} / $${maxBank.toLocaleString()}`,
                        inline: true,
                    },
                );

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'deposit' })
};