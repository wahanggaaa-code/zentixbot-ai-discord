import { randomInt } from 'node:crypto';
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export const MIN_LENGTH = 8;
export const MAX_LENGTH = 50;
const CLASSES = Object.freeze({
    lowercase: { label: 'Lowercase', chars: 'abcdefghijklmnopqrstuvwxyz' },
    uppercase: { label: 'Uppercase', chars: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    numbers: { label: 'Numbers', chars: '0123456789' },
    // No backtick and no backslash: the password is shown inside a code span.
    symbols: { label: 'Symbols', chars: '!@#$%^&*()_+-=[]{}|;:,.<>?' },
});

/**
 * A password of `length` characters with at least one character of every class in `wanted`.
 * `pick(n)` returns a whole number from 0 up to, not including, n; the default is the
 * operating system's random source.
 */
export function generatePassword(length, wanted, pick = randomInt) {
    const sets = wanted.map((name) => CLASSES[name].chars);
    const all = sets.join('');
    // One of each class first, then the rest from everything.
    const chars = sets.map((set) => set[pick(set.length)]);
    while (chars.length < length) chars.push(all[pick(all.length)]);
    // Shuffle, so the guaranteed characters are not always in front.
    for (let i = chars.length - 1; i > 0; i--) {
        const j = pick(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return { password: chars.join(''), bits: Math.floor(length * Math.log2(all.length)) };
}

export default {
    data: new SlashCommandBuilder()
        .setName('generatepassword')
        .setDescription('Generate a strong, random password')
        .addIntegerOption((option) =>
            option.setName('length')
                .setDescription(`Password length (default: 16, ${MIN_LENGTH}-${MAX_LENGTH})`)
                .setMinValue(MIN_LENGTH)
                .setMaxValue(MAX_LENGTH)
                .setRequired(false))
        .addBooleanOption((option) =>
            option.setName('uppercase')
                .setDescription('Include uppercase letters (A-Z)')
                .setRequired(false))
        .addBooleanOption((option) =>
            option.setName('numbers')
                .setDescription('Include numbers (0-9)')
                .setRequired(false))
        .addBooleanOption((option) =>
            option.setName('symbols')
                .setDescription('Include symbols (!@#$%^&*)')
                .setRequired(false)),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('GeneratePassword interaction defer failed', { userId: interaction.user?.id, guildId: interaction.guildId, commandName: 'generatepassword' });
            return;
        }

        const length = interaction.options.getInteger('length') ?? 16;
        if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `The length must be a whole number from ${MIN_LENGTH} to ${MAX_LENGTH}.` });
        }
        const wanted = ['lowercase'];
        for (const name of ['uppercase', 'numbers', 'symbols']) {
            if (interaction.options.getBoolean(name) ?? true) wanted.push(name);
        }

        const { password, bits } = generatePassword(length, wanted);
        const embed = createEmbed({
            title: 'Generated Password',
            description: `**Password:** ||\`${password}\`||\n**Length:** ${length} characters\n**Contains:** ${wanted.map((name) => CLASSES[name].label).join(', ')}\n**Randomness:** about ${bits} bits\n\nOnly you can see this message. The password is not stored or logged.`,
            color: 'success',
        });

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
