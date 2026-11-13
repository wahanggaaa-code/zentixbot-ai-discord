import { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { evaluateMathExpression, MAX_EXPRESSION_LENGTH } from '../../utils/safeMathParser.js';
import { codeSpan } from '../../services/searchLookup.js';

export const OPERATIONS = Object.freeze({
    add: { sign: '+', label: '+', verb: 'add' },
    subtract: { sign: '-', label: '-', verb: 'subtract' },
    multiply: { sign: '*', label: '×', verb: 'multiply by' },
    divide: { sign: '/', label: '÷', verb: 'divide by' },
});

/**
 * A result as members read it. Whole numbers keep every digit while JavaScript can hold them
 * exactly; very large and very small values use scientific notation with ten digits.
 */
export function formatResult(value) {
    if (Object.is(value, -0)) return '0';
    const size = Math.abs(value);
    if (Number.isInteger(value) && size <= Number.MAX_SAFE_INTEGER) return value.toLocaleString('en-US');
    if (size >= 1e15 || (size > 0 && size < 1e-6)) return value.toExponential(10).replace(/\.?0+e/, 'e');
    return value.toLocaleString('en-US', { maximumFractionDigits: 10 });
}

/** The sentence for a failed evaluation; every failure of the parser is a MathError with a code. */
export function mathFailureMessage(error) {
    switch (error?.code) {
        case 'TOO_LONG': return `The expression is too long. Please keep it under ${MAX_EXPRESSION_LENGTH} characters.`;
        case 'UNKNOWN_NAME': return `I do not know ${codeSpan(error.symbol, 30)}. Known names: sin, cos, tan, sqrt, abs, ln, log10, log2, exp, floor, ceil, round, pi, e.`;
        case 'NOT_FINITE': return 'The result is not a finite number (for example a division by zero, or a value too large to represent).';
        case 'SYNTAX': return 'I could not read that expression. Supported: numbers, + - * / % ^, parentheses, and functions such as sqrt(2) or sin(45 deg).';
        default: return null;
    }
}

/** The buttons under a result. They carry the owner and the value itself, so nothing is kept in memory. */
export function resultButtons(ownerId, value) {
    return new ActionRowBuilder().addComponents(
        Object.entries(OPERATIONS).map(([name, { label }]) => new ButtonBuilder()
            .setCustomId(`calc:op:${name}:${ownerId}:${value}`)
            .setLabel(label)
            .setStyle(ButtonStyle.Primary)),
    );
}

export function resultEmbed(expression, value) {
    return createEmbed({
        title: 'Calculation Result',
        description: `**Expression:** ${codeSpan(expression, MAX_EXPRESSION_LENGTH + 80)}\n**Result:** \`${formatResult(value)}\`\n\nUse the buttons to continue with this result.`,
        color: 'success',
    });
}

export default {
    data: new SlashCommandBuilder()
        .setName('calculate')
        .setDescription('Evaluate a mathematical expression')
        .addStringOption((option) =>
            option
                .setName('expression')
                .setDescription('For example 2+2*3, sqrt(16), sin(45 deg), 2^10')
                .setRequired(true)
                .setMaxLength(MAX_EXPRESSION_LENGTH),
        ),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('Calculate interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'calculate' });
            return;
        }

        const expression = String(interaction.options.getString('expression') ?? '').trim();
        let value;
        try {
            value = evaluateMathExpression(expression);
        } catch (error) {
            const message = mathFailureMessage(error);
            if (!message) throw error;
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message });
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [resultEmbed(expression, value)],
            components: [resultButtons(interaction.user.id, value)],
        });
    },
};
