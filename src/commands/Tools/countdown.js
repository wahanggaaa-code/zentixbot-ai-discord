import { SlashCommandBuilder } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';
import { plainText } from '../../services/searchLookup.js';
import { MAX_SECONDS, MAX_RUNNING, runningCountdowns, runningPayload, scheduleFinish } from '../../handlers/countdownButtons.js';

export const COUNTDOWNS_PER_WINDOW = 5;
export const COUNTDOWN_WINDOW_MS = 10 * 60 * 1000;
const TITLE_LIMIT = 100;

export default {
    data: new SlashCommandBuilder()
        .setName('countdown')
        .setDescription('Start a countdown timer')
        .addIntegerOption((option) =>
            option
                .setName('minutes')
                .setDescription('Number of minutes to count down (0-1440)')
                .setMinValue(0)
                .setMaxValue(1440)
                .setRequired(false),
        )
        .addIntegerOption((option) =>
            option
                .setName('seconds')
                .setDescription('Number of seconds to count down (0-59)')
                .setMinValue(0)
                .setMaxValue(59)
                .setRequired(false),
        )
        .addStringOption((option) =>
            option
                .setName('title')
                .setDescription('Optional title for the countdown')
                .setMaxLength(TITLE_LIMIT)
                .setRequired(false),
        ),

    async execute(interaction) {
        const minutes = interaction.options.getInteger('minutes') ?? 0;
        const seconds = interaction.options.getInteger('seconds') ?? 0;
        const total = minutes * 60 + seconds;
        const refuse = (message) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message });

        if (!Number.isInteger(total) || minutes < 0 || seconds < 0 || total < 1) return refuse('Please give a duration of at least 1 second, with `minutes`, `seconds` or both.');
        if (total > MAX_SECONDS) return refuse('A countdown cannot be longer than 24 hours.');
        if (runningCountdowns() >= MAX_RUNNING) return refuse('Too many countdowns are running right now. Please try again later.');
        if (!await checkRateLimit(`countdown:${interaction.guildId ?? 'dm'}:${interaction.user.id}`, COUNTDOWNS_PER_WINDOW, COUNTDOWN_WINDOW_MS)) {
            return refuse(`You can start ${COUNTDOWNS_PER_WINDOW} countdowns per 10 minutes. Please wait a little.`);
        }

        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('Countdown interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'countdown' });
            return;
        }

        // What the member typed is shown as ordinary text: it cannot format itself or hide a link.
        const title = plainText(interaction.options.getString('title') ?? '', TITLE_LIMIT) || 'Countdown';
        const endsAt = Math.floor(Date.now() / 1000) + total;
        const message = (await interaction.editReply(runningPayload(title, interaction.user.id, endsAt)))
            ?? (await interaction.fetchReply?.().catch(() => null));
        scheduleFinish(message, title, endsAt);
    },
};
