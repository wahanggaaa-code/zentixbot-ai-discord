import { SlashCommandBuilder } from 'discord.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

// Each module checks its limit again for itself: prefix commands do not pass through Discord's own check.
import searchDefine, { MAX_WORD_LENGTH } from './modules/search_define.js';
import searchGoogle, { MAX_QUERY_LENGTH } from './modules/search_google.js';
import searchUrban, { MAX_TERM_LENGTH } from './modules/search_urban.js';

export default {
    data: new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search the web and dictionaries')
        .addSubcommand(subcommand =>
            subcommand
                .setName('define')
                .setDescription('Look up a word definition')
                .addStringOption(option =>
                    option.setName('word')
                        .setDescription('The word to look up')
                        .setMinLength(2)
                        .setMaxLength(MAX_WORD_LENGTH)
                        .setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('google')
                .setDescription('Search Google')
                .addStringOption(option =>
                    option.setName('query')
                        .setDescription('What would you like to search for?')
                        .setMinLength(1)
                        .setMaxLength(MAX_QUERY_LENGTH)
                        .setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('urban')
                .setDescription('Search Urban Dictionary for definitions (age-restricted channels only)')
                .addStringOption(option =>
                    option.setName('term')
                        .setDescription('The term to look up on Urban Dictionary')
                        .setMinLength(2)
                        .setMaxLength(MAX_TERM_LENGTH)
                        .setRequired(true))
        ),

    async execute(interaction, config, client) {
        const subcommand = interaction.options.getSubcommand();

        switch (subcommand) {
            case 'define':
                return await searchDefine.execute(interaction, config, client);
            case 'google':
                return await searchGoogle.execute(interaction, config, client);
            case 'urban':
                return await searchUrban.execute(interaction, config, client);
            default:
                return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'Unknown subcommand' });
        }
    }
};
