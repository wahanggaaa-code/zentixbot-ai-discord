import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { plainText } from '../../services/searchLookup.js';

export const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
export const MAX_OPTIONS = 10;
export const QUESTION_LIMIT = 300;
export const OPTION_LIMIT = 100;
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

// What the bot needs where the poll is posted; the votes are reactions.
const NEEDED = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    [PermissionFlagsBits.AddReactions, 'Add Reactions'],
    [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
];

const builder = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a simple poll with up to 10 options')
    .addStringOption((option) =>
        option.setName('question')
            .setDescription('The poll question')
            .setMaxLength(QUESTION_LIMIT)
            .setRequired(true));
for (let index = 0; index < MAX_OPTIONS; index++) {
    builder.addStringOption((option) =>
        option.setName(`option${index + 1}`)
            .setDescription(`${ORDINALS[index]} option${index < 2 ? '' : ' (optional)'}`)
            .setMaxLength(OPTION_LIMIT)
            .setRequired(index < 2));
}

export default {
    data: builder,

    async execute(interaction) {
        const refuse = (message, type = ErrorTypes.VALIDATION) => replyUserError(interaction, { type, message });
        if (!interaction.guild) return refuse('Polls can only be created in a server.');

        // Members read these as ordinary text: no formatting, no hidden links.
        const question = plainText(interaction.options.getString('question') ?? '', QUESTION_LIMIT);
        const options = [];
        for (let index = 1; index <= MAX_OPTIONS; index++) {
            const option = plainText(interaction.options.getString(`option${index}`) ?? '', OPTION_LIMIT);
            if (option) options.push(option);
        }
        if (!question) return refuse('The poll needs a question.');
        if (options.length < 2) return refuse('A poll needs at least 2 options.');
        if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return refuse('Two options are the same. Each option must be different.');

        const mine = interaction.channel?.permissionsFor?.(interaction.guild.members.me) ?? interaction.appPermissions ?? null;
        const missing = mine ? NEEDED.filter(([flag]) => !mine.has(flag)).map(([, name]) => name) : [];
        if (missing.length) return refuse(`I cannot run a poll in this channel. Missing here: ${missing.join(', ')}.`, ErrorTypes.PERMISSION);

        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('Poll interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'poll' });
            return;
        }

        const lines = options.map((option, index) => `**${index + 1}.** ${option}`);
        const embed = createEmbed({
            title: 'Poll',
            description: `**${question}**\n\n${lines.join('\n')}\n\nVote with the numbered reactions below. Reactions are visible to everyone.`,
            color: 'success',
        });
        const message = (await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } }))
            ?? (await interaction.fetchReply?.().catch(() => null));

        let added = 0;
        try {
            for (; added < options.length; added++) await message.react(POLL_EMOJIS[added]);
        } catch (error) {
            logger.warn('Poll reactions could not all be added', { guildId: interaction.guildId, channelId: interaction.channelId, added, wanted: options.length, code: error?.code });
            await interaction.followUp({
                content: `The poll is posted, but I could only add ${added} of ${options.length} reactions. Members can still vote by adding the missing numbers themselves.`,
                flags: MessageFlags.Ephemeral,
            }).catch(() => {});
        }
    },
};
