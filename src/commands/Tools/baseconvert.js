import { SlashCommandBuilder } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { codeSpan } from '../../services/searchLookup.js';

/** Longest input accepted; with it, every conversion together still fits one embed. */
export const MAX_INPUT_LENGTH = 200;

// `digits` is the alphabet in order of value. `fold` means letters are read without regard to case.
const BASES = Object.freeze({
    BIN: { name: 'Binary', prefix: '0b', digits: '01', fold: true, valid: '0 and 1' },
    OCT: { name: 'Octal', prefix: '0o', digits: '01234567', fold: true, valid: '0-7' },
    DEC: { name: 'Decimal', prefix: '', digits: '0123456789', fold: true, valid: '0-9' },
    HEX: { name: 'Hexadecimal', prefix: '0x', digits: '0123456789ABCDEF', fold: true, valid: '0-9 and A-F' },
    B64: { name: 'Base64', prefix: 'b64:', digits: null, fold: false, valid: 'standard Base64 (A-Z, a-z, 0-9, + and /, padded with =)' },
    B36: { name: 'Base36', prefix: '', digits: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', fold: true, valid: '0-9 and A-Z' },
    B58: { name: 'Base58', prefix: '', digits: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', fold: false, valid: '1-9, A-Z and a-z without 0, O, I and l (case matters)' },
    B62: { name: 'Base62', prefix: '', digits: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', fold: false, valid: '0-9, A-Z and a-z (case matters)' },
});
const BASE_CHOICES = Object.entries(BASES).map(([key, { name }]) => ({ name: `${key} (${name})`, value: key }));

/**
 * The value of `text` written in base `key`, as a BigInt; null when `text` is not a number in
 * that base. Base64 is read as the bytes of a big-endian whole number.
 */
export function parseInBase(text, key) {
    const base = BASES[key];
    if (!base || typeof text !== 'string' || text.length === 0) return null;
    if (key === 'B64') {
        const bytes = Buffer.from(text, 'base64');
        // Node's decoder skips what it does not know; only the exact spelling the encoder would
        // produce for these bytes is accepted.
        if (bytes.toString('base64') !== text) return null;
        return bytes.reduce((sum, byte) => (sum << 8n) | BigInt(byte), 0n);
    }
    const digits = base.fold ? text.toUpperCase() : text;
    const radix = BigInt(base.digits.length);
    let value = 0n;
    for (const digit of digits) {
        const at = base.digits.indexOf(digit);
        if (at < 0) return null;
        value = value * radix + BigInt(at);
    }
    return value;
}

/** `value` (a BigInt, zero or more) written in base `key`. */
export function formatInBase(value, key) {
    const base = BASES[key];
    if (key === 'B64') {
        const bytes = [];
        for (let rest = value; rest > 0n; rest >>= 8n) bytes.unshift(Number(rest & 0xffn));
        return Buffer.from(bytes.length ? bytes : [0]).toString('base64');
    }
    if (value === 0n) return base.digits[0];
    const radix = BigInt(base.digits.length);
    let out = '';
    for (let rest = value; rest > 0n; rest /= radix) out = base.digits[Number(rest % radix)] + out;
    return out;
}

export default {
    data: new SlashCommandBuilder()
        .setName('baseconvert')
        .setDescription('Convert whole numbers between different bases')
        .addStringOption((option) =>
            option.setName('number')
                .setDescription('The whole number to convert')
                .setMaxLength(MAX_INPUT_LENGTH + 4)
                .setRequired(true))
        .addStringOption((option) =>
            option.setName('from')
                .setDescription('Source base/format')
                .setRequired(true)
                .addChoices(...BASE_CHOICES))
        .addStringOption((option) =>
            option.setName('to')
                .setDescription('Target base/format (default: all)')
                .setRequired(false)
                .addChoices(...BASE_CHOICES)),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('BaseConvert interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'baseconvert' });
            return;
        }
        const refuse = (message) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message });

        const fromKey = interaction.options.getString('from');
        const toKey = interaction.options.getString('to');
        const from = BASES[fromKey];
        if (!from || (toKey && !BASES[toKey])) return refuse('Please choose the bases from the list.');

        const typed = String(interaction.options.getString('number') ?? '').trim();
        // The usual prefix of the source base may be typed, in either case: 0xFF, 0b101.
        const digits = from.prefix && typed.toLowerCase().startsWith(from.prefix) ? typed.slice(from.prefix.length) : typed;
        if (!digits) return refuse('Please give a number to convert, for example `/baseconvert number:1010 from:BIN to:DEC`.');
        if (digits.length > MAX_INPUT_LENGTH) return refuse(`That number is too long. Please keep it to ${MAX_INPUT_LENGTH} characters.`);

        const value = parseInBase(digits, fromKey);
        if (value === null) {
            return refuse(`${codeSpan(digits, 60)} is not a ${from.name} number. Valid characters: ${from.valid}. Only whole numbers without a sign are converted.`);
        }

        const written = (key) => `\`${BASES[key].prefix}${formatInBase(value, key)}\``;
        const lines = [`**Input (${from.name}):** \`${from.prefix}${from.fold ? digits.toUpperCase() : digits}\``];
        if (toKey) {
            lines.push(`**${BASES[toKey].name} (${toKey}):** ${written(toKey)}`);
            if (fromKey !== 'DEC' && toKey !== 'DEC') lines.push(`**Decimal:** \`${value}\``);
        } else {
            for (const key of Object.keys(BASES)) {
                if (key !== fromKey) lines.push(`**${BASES[key].name} (${key}):** ${written(key)}`);
            }
        }

        const embed = createEmbed({ title: toKey ? 'Base Conversion Result' : 'Base Conversion Results', description: lines.join('\n'), color: 'success' });
        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
