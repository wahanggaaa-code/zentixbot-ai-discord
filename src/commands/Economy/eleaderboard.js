import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getEconomyPrefix } from '../../utils/database.js';
import { economyPool, listEconomyBalances } from '../../services/economy/accounts.js';

export default {
    data: new SlashCommandBuilder()
        .setName("eleaderboard")
        .setDescription("View the server's top 10 richest users.")
        .setDMPermission(false),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

            const guildId = interaction.guildId;

            logger.debug(`[ECONOMY] Leaderboard requested`, { guildId });

            let allUserData = [];
            const pool = economyPool(client);
            if (pool) {
                // PostgreSQL: one query. A failed query is reported as an error
                // instead of "no economy data".
                const { accounts } = await listEconomyBalances(pool, guildId);
                allUserData = accounts.map((account) => ({
                    userId: account.userId,
                    net_worth: account.wallet + account.bank,
                }));
            } else {
                const prefix = getEconomyPrefix(guildId);
                let allKeys = await client.db.list(prefix);
                if (!Array.isArray(allKeys)) {
                    allKeys = [];
                }
                for (const key of allKeys) {
                    const userId = key.replace(prefix, "");
                    const userData = await client.db.get(key);
                    if (userData) {
                        allUserData.push({
                            userId: userId,
                            net_worth: (userData.wallet || 0) + (userData.bank || 0),
                        });
                    }
                }
            }

            if (allUserData.length === 0) {
                throw createError(
                    "No economy data found",
                    ErrorTypes.VALIDATION,
                    "No economy data found for this server."
                );
            }

            allUserData.sort((a, b) => b.net_worth - a.net_worth);

            const topUsers = allUserData.slice(0, 10);
            const userRank =
                allUserData.findIndex((u) => u.userId === interaction.user.id) +
                1;
            const rankEmoji = ["🥇", "🥈", "🥉"];
            const leaderboardEntries = [];

            for (let i = 0; i < topUsers.length; i++) {
                const user = topUsers[i];
                const rank = i + 1;
                const emoji = rankEmoji[i] || `**#${rank}**`;

                leaderboardEntries.push(
                    `${emoji} <@${user.userId}> - 🏦 ${user.net_worth.toLocaleString()}`,
                );
            }

            logger.info(`[ECONOMY] Leaderboard generated`, { 
                guildId, 
                userCount: allUserData.length,
                userRank 
            });

            // The rank is part of the description: embed footers are not shown by this bot.
            const rankLine = userRank > 0
                ? `Your rank: **#${userRank}** of ${allUserData.length}`
                : 'You have no economy account yet.';
            const description = leaderboardEntries.length > 0
                ? `${leaderboardEntries.join("\n")}\n\n${rankLine}`
                : "No economy data is available for this server yet.";

            const embed = createEmbed({
                title: `Economy Leaderboard`,
                description,
                footer: `Your Rank: ${userRank > 0 ?`#${userRank}`: "No ranking data available"}`,
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    }, { command: 'eleaderboard' })
};