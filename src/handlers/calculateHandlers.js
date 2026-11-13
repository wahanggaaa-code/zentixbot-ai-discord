import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { evaluateMathExpression } from '../utils/safeMathParser.js';
import { OPERATIONS, formatResult, mathFailureMessage, resultButtons, resultEmbed } from '../commands/Tools/calculate.js';

const PRIVATE = MessageFlags.Ephemeral;
const GONE = 'This calculator is no longer valid. Use `/calculate` again.';
const gone = (interaction) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: GONE });

/** The number a button or form carries; null when it is not one this bot would have written. */
function carried(text) {
    if (typeof text !== 'string' || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

function apply(operation, left, right) {
    if (operation === 'add') return left + right;
    if (operation === 'subtract') return left - right;
    if (operation === 'multiply') return left * right;
    return left / right;
}

/** `calc:op:<operation>:<ownerId>:<value>`: ask for the second number. */
export async function calculatorButton(interaction, client, args) {
    const [action, operation, ownerId, text] = args;
    const value = carried(text);
    if (action !== 'op' || !Object.hasOwn(OPERATIONS, operation) || value === null) return gone(interaction);
    if (interaction.user.id !== ownerId) {
        return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'Only the member who ran this calculation can continue it. Use `/calculate` for your own.' });
    }
    const { verb } = OPERATIONS[operation];
    const modal = new ModalBuilder()
        .setCustomId(`calc:apply:${operation}:${text}`)
        .setTitle('Continue the calculation')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('operand')
                .setLabel(`Number to ${verb}`.slice(0, 45))
                .setPlaceholder('A number or an expression, e.g. 5 or sqrt(2)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(50),
        ));
    await interaction.showModal(modal);
}

/** `calc:apply:<operation>:<value>`: compute and show the new result in the same message. */
export async function calculatorModal(interaction, client, args) {
    const [action, operation, text] = args;
    const left = carried(text);
    if (action !== 'apply' || !Object.hasOwn(OPERATIONS, operation) || left === null) return gone(interaction);

    const typed = String(interaction.fields.getTextInputValue('operand') ?? '').trim();
    let value;
    try {
        const right = evaluateMathExpression(typed);
        value = apply(operation, left, right);
        if (!Number.isFinite(value)) throw Object.assign(new Error('not finite'), { code: 'NOT_FINITE' });
    } catch (error) {
        const message = mathFailureMessage(error);
        if (!message) throw error;
        return replyUserError(interaction, { type: ErrorTypes.VALIDATION, message });
    }

    const expression = `${formatResult(left)} ${OPERATIONS[operation].sign} (${typed})`;
    const payload = { embeds: [resultEmbed(expression, value)], components: [resultButtons(interaction.user.id, value)] };
    // Opened from the buttons under a result: that message shows the new result.
    if (interaction.isFromMessage?.()) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: PRIVATE });
}
