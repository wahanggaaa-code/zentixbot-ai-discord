import { randomInt } from 'node:crypto';
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

const NAMED = Object.freeze({
    '#FF0000': 'Red', '#00FF00': 'Green', '#0000FF': 'Blue', '#FFFF00': 'Yellow', '#FF00FF': 'Magenta',
    '#00FFFF': 'Cyan', '#000000': 'Black', '#FFFFFF': 'White', '#808080': 'Gray', '#FFA500': 'Orange',
    '#800080': 'Purple', '#A52A2A': 'Brown', '#FFC0CB': 'Pink', '#008000': 'Dark Green', '#000080': 'Navy',
    '#FFD700': 'Gold', '#C0C0C0': 'Silver', '#FF6347': 'Tomato', '#40E0D0': 'Turquoise', '#E6E6FA': 'Lavender',
});

/** `#RRGGBB` in capitals from `RGB`, `RRGGBB`, with or without `#`; null for anything else. */
export function parseHexColor(input) {
    const text = String(input ?? '').trim().replace(/^#/, '');
    if (!/^(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(text)) return null;
    const full = text.length === 3 ? [...text].map((c) => c + c).join('') : text;
    return `#${full.toUpperCase()}`;
}

const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

/** The named color nearest in red, green and blue, and whether it is exactly that color. */
export function nearestNamedColor(hex) {
    const [r, g, b] = channels(hex);
    let best = null;
    for (const [named, name] of Object.entries(NAMED)) {
        const [nr, ng, nb] = channels(named);
        const distance = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2;
        if (!best || distance < best.distance) best = { name, distance };
    }
    return { name: best.name, exact: best.distance === 0 };
}

export default {
    data: new SlashCommandBuilder()
        .setName('hexcolor')
        .setDescription('Show a hex color, or a random one, with a preview')
        .addStringOption((option) =>
            option.setName('color')
                .setDescription('Hex color, e.g. #FF5733, FF5733 or F53 (leave empty for a random one)')
                .setMaxLength(7)
                .setRequired(false)),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Hexcolor interaction defer failed', { userId: interaction.user.id, guildId: interaction.guildId, commandName: 'hexcolor' });
            return;
        }

        const typed = interaction.options.getString('color');
        const hex = typed ? parseHexColor(typed) : `#${randomInt(0x1000000).toString(16).padStart(6, '0').toUpperCase()}`;
        if (!hex) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please give a hex color of 3 or 6 digits, for example `#FF5733`, `FF5733` or `F53`.' });
        }

        const [r, g, b] = channels(hex);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        const textColor = brightness > 128 ? '000000' : 'FFFFFF';
        const { name, exact } = nearestNamedColor(hex);
        const embed = createEmbed({
            title: 'Color Information',
            description: `**Hex:** \`${hex}\`\n**RGB:** \`rgb(${r}, ${g}, ${b})\`\n**HSL:** \`${rgbToHsl(r, g, b)}\`\n**${exact ? 'Name' : 'Nearest named color'}:** ${name}${typed ? '' : '\n\nRandomly generated color.'}`,
        })
            .setColor(parseInt(hex.slice(1), 16))
            .setImage(`https://dummyimage.com/200x100/${hex.slice(1)}/${textColor}?text=${encodeURIComponent(hex)}`);

        await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
    },
};
