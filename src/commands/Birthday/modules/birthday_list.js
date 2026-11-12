import { EmbedBuilder } from 'discord.js';
import { getAllBirthdays } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        await InteractionHelper.safeDefer(interaction);

        const guildId = interaction.guildId;

        const sortedBirthdays = await getAllBirthdays(client, guildId);

        if (sortedBirthdays.length === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No Birthdays')
                .setDescription('No birthdays have been set in this server yet.');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        const userIds = sortedBirthdays.map(b => b.userId);
        const fetchedMembers = await interaction.guild.members.fetch({ user: userIds }).catch(() => null);

        let birthdayList = '';
        let displayIndex = 0;
        const staleUserIds = [];

        for (const birthday of sortedBirthdays) {
            if (fetchedMembers && !fetchedMembers.has(birthday.userId)) {
                staleUserIds.push(birthday.userId);
                continue;
            }
            displayIndex++;
            birthdayList += `${displayIndex}. <@${birthday.userId}> - ${birthday.monthName} ${birthday.day}\n`;
        }


        if (displayIndex === 0) {
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle('No Birthdays')
                .setDescription('No birthdays have been set by current server members.');
            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [embed]
            });
        }

        birthdayList = `**${displayIndex} birthday${displayIndex !== 1 ? 's' : ''} in ${interaction.guild.name}**\n\n` + birthdayList;

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Server Birthdays')
            .setDescription(`${birthdayList}\n\nTotal: ${displayIndex} birthday${displayIndex !== 1 ? 's' : ''}`);

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [embed]
        });

        logger.info('Birthday list retrieved successfully', {
            userId: interaction.user.id,
            guildId,
            birthdayCount: displayIndex,
            unresolvedMembers: staleUserIds.length,
            commandName: 'birthday_list'
        });
    }
};