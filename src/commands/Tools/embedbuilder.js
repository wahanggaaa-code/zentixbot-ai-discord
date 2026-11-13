import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ComponentType,
    ChannelType,
    EmbedBuilder,
    embedLength,
    LabelBuilder,
    RadioGroupBuilder,
} from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { ZentixBotError, replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getColor } from '../../config/bot.js';

const MAX_FIELDS = 25;
// The panel closes after this long without any activity, and at SESSION_LIMIT at the latest:
// Discord accepts edits of the panel for 15 minutes after the command.
const IDLE_TIMEOUT = 300_000;
const SESSION_LIMIT = 840_000;
const EMBED_TOTAL_LIMIT = 6000;
const FIELD_NEEDS_TEXT = 'A field needs both a name and a value; neither can be empty or only spaces.';

// Every panel and picker of every member shares the channel, so each collector only listens to
// the one message it belongs to.
const fromMessage = (interaction, message) => Boolean(message?.id) && interaction.message?.id === message.id;

/**
 * Wait for the form opened from `origin`. A member can dismiss a form and open it again; the
 * dismissed one is still waiting, so only the form opened last is answered.
 */
async function awaitForm(origin, state, customId, time) {
    const turn = ++state.formTurn;
    const submitted = await origin
        .awaitModalSubmit({
            filter: i => i.customId === customId && i.user.id === origin.user.id && i.message?.id === origin.message?.id,
            time,
        })
        .catch(() => null);
    if (!submitted || state.formTurn !== turn) return null;
    return submitted;
}

const COLOR_PRESETS = [
    { label: 'Primary (Blue)',        value: '#336699' },
    { label: 'Success (Green)',       value: '#57F287' },
    { label: 'Error (Red)',           value: '#ED4245' },
    { label: 'Warning (Yellow)',      value: '#FEE75C' },
    { label: 'Info (Bright Blue)',    value: '#3498DB' },
    { label: 'Blurple (Discord)',     value: '#5865F2' },
    { label: 'Fuchsia',              value: '#EB459E' },
    { label: 'Gold',                  value: '#F1C40F' },
    { label: 'White',                 value: '#FFFFFF' },
    { label: 'Dark',                  value: '#202225' },
    { label: 'Custom Hex...',         value: '__custom__' },
];

function isValidUrl(str) {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function isValidHex(str) {
    return /^#[0-9A-Fa-f]{6}$/.test(str);
}

function resolveEmbedColor(value) {
    try {
        const resolved = getColor(value || 'primary');
        if (typeof resolved === 'number' && Number.isFinite(resolved) && resolved >= 0 && resolved <= 0xffffff) {
            return resolved;
        }
    } catch {
        // ignore invalid value and fall through to primary
    }
    return getColor('primary');
}

const isEmptyEmbed = (state) => !state.title && !state.description && state.fields.length === 0 && !state.author?.name;

const EMPTY_PLACEHOLDER = '*(Empty — use the menu below to add content)*';

/**
 * The member's embed as a plain API object, not an EmbedBuilder. The bot's own embeds go through
 * the house style of utils/embeds.js, which removes emoji and extra spaces, drops most footers
 * and ignores timestamps; a member's embed is shown and posted exactly as written.
 */
function buildPreviewEmbed(state) {
    const embed = { color: resolveEmbedColor(state.color) };

    if (state.title)       embed.title = state.title.substring(0, 256);
    if (state.description) embed.description = state.description.substring(0, 4096);

    if (state.author?.name) {
        embed.author = { name: state.author.name.substring(0, 256) };
        if (state.author.iconUrl && isValidUrl(state.author.iconUrl)) embed.author.icon_url = state.author.iconUrl;
        if (state.author.url     && isValidUrl(state.author.url))     embed.author.url      = state.author.url;
    }

    if (state.footer?.text) {
        embed.footer = { text: state.footer.text.substring(0, 2048) };
        if (state.footer.iconUrl && isValidUrl(state.footer.iconUrl)) embed.footer.icon_url = state.footer.iconUrl;
    }

    if (state.thumbnail && isValidUrl(state.thumbnail)) embed.thumbnail = { url: state.thumbnail };
    if (state.image     && isValidUrl(state.image))     embed.image     = { url: state.image };
    if (state.timestamp) embed.timestamp = new Date().toISOString();

    if (state.fields.length > 0) {
        embed.fields = state.fields.slice(0, MAX_FIELDS).map(({ name, value, inline }) => ({
            name: name.substring(0, 256),
            value: value.substring(0, 1024),
            inline: Boolean(inline),
        }));
    }

    if (isEmptyEmbed(state)) embed.description = EMPTY_PLACEHOLDER;

    return embed;
}

function buildDashboardEmbed(state) {
    const trunc = (str, n) =>
        str.length > n ? str.substring(0, n) + '…' : str;

    const lines = [
        `**Title** › ${state.title ?`\`${trunc(state.title, 40)}\`` : '`Not set`'}`,
        `**Description** › ${state.description ?`${state.description.length} character(s)`: '`Not set`'}`,
        `**Color** › ${state.color ?`\`${state.color}\`` : '`Default`'}`,
        `**Author** › ${state.author?.name ?`\`${trunc(state.author.name, 30)}\`` : '`Not set`'}`,
        `**Footer** › ${state.footer?.text ?`\`${trunc(state.footer.text, 30)}\`` : '`Not set`'}`,
        `**Thumbnail** › ${state.thumbnail ? '✅ Set' : '`Not set`'}`,
        `**Image** › ${state.image ? '✅ Set' : '`Not set`'}`,
        `**Timestamp** › ${state.timestamp ? '✅ Enabled' : '`Disabled`'}`,
        `**Fields** › ${state.fields.length} / ${MAX_FIELDS}`,
    ];

    return new EmbedBuilder()
        .setTitle('Embed Builder — Control Panel')
        .setDescription(lines.join('\n'))
        .setColor(getColor('info'))
        .setFooter({ text: 'The preview above updates live · Closes after 5 min of inactivity, 14 min at most' });
}

function buildMainMenu(state) {
    const primaryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_edit_content')
            .setLabel('Edit Content')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        new ButtonBuilder()
            .setCustomId('eb_main_set_color')
            .setLabel('Set Color')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🎨'),
        new ButtonBuilder()
            .setCustomId('eb_main_set_images')
            .setLabel('Set Images')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🖼️'),
        new ButtonBuilder()
            .setCustomId('eb_main_post_embed')
            .setLabel('Post Embed')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📤'),
    );

    const secondaryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_add_field')
            .setLabel(`Add Field (${state.fields.length}/${MAX_FIELDS})`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('➕'),
        new ButtonBuilder()
            .setCustomId('eb_main_edit_field')
            .setLabel('Edit Field')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📝')
            .setDisabled(state.fields.length === 0),
        new ButtonBuilder()
            .setCustomId('eb_main_remove_field')
            .setLabel('Remove Field')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('➖')
            .setDisabled(state.fields.length === 0),
        new ButtonBuilder()
            .setCustomId('eb_main_toggle_timestamp')
            .setLabel(state.timestamp ? 'Disable Timestamp' : 'Enable Timestamp')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🕐'),
    );

    const tertiaryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('eb_main_reorder_fields')
            .setLabel('Reorder Fields')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('↕️')
            .setDisabled(state.fields.length < 2),
        new ButtonBuilder()
            .setCustomId('eb_main_set_author')
            .setLabel('Set Author')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('eb_main_set_footer')
            .setLabel('Set Footer')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('eb_main_json_export')
            .setLabel('JSON / Raw Data')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📋'),
        new ButtonBuilder()
            .setCustomId('eb_main_reset_all')
            .setLabel('Reset Everything')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🗑️'),
    );

    return [primaryRow, secondaryRow, tertiaryRow];
}

async function refreshDashboard(interaction, state) {
    // Any change counts as activity.
    state.touch?.();
    return await InteractionHelper.safeEditReply(interaction, {
        embeds: [buildPreviewEmbed(state), buildDashboardEmbed(state)],
        components: buildMainMenu(state),
    });
}

async function handleEditContent(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_content')
        .setTitle('Edit Content')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_title')
                    .setLabel('Title (max 256 characters)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.title || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('My Embed Title'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('eb_description')
                    .setLabel('Description (max 4000 characters)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(state.description ? state.description.substring(0, 4000) : '')
                    .setMaxLength(4000)
                    .setRequired(false)
                    .setPlaceholder('Write your embed description here...'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await awaitForm(selectInteraction, state, 'eb_content', 120_000);

    if (!submitted) return;

    await submitted.deferUpdate().catch(() => {});

    state.title       = submitted.fields.getTextInputValue('eb_title').trim()       || null;
    state.description = submitted.fields.getTextInputValue('eb_description').trim() || null;

    await refreshDashboard(rootInteraction, state);
}

async function handleSetColor(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate().catch(() => {});

    const colorSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_color_pick')
        .setPlaceholder('Choose a color...')
        .addOptions(
            COLOR_PRESETS.map(c =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(c.label)
                    .setValue(c.value)
                    .setDescription(c.value !== '__custom__' ? c.value : 'Enter your own #RRGGBB value'),
            ),
        );

    const picker = await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Set Color')
                .setDescription(
                    'Select a preset color or choose **Custom Hex** to enter your own `#RRGGBB` value.',
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(colorSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const colorCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            fromMessage(i, picker) && i.user.id === selectInteraction.user.id && i.customId === 'eb_color_pick',
        time: 60_000,
        max: 1,
    });

    colorCollector.on('collect', async colorInter => {
        try {
        const picked = colorInter.values[0];

        if (picked === '__custom__') {
            const hexModal = new ModalBuilder()
                .setCustomId('eb_custom_hex')
                .setTitle('Custom Color')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('hex_value')
                            .setLabel('Hex Color Code')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('#5865F2')
                            .setMaxLength(7)
                            .setMinLength(7)
                            .setRequired(true),
                    ),
                );

            const shown = await InteractionHelper.safeShowModal(colorInter, hexModal);
            if (!shown) return;

            const hexSubmit = await awaitForm(colorInter, state, 'eb_custom_hex', 60_000);

            if (!hexSubmit) return;

            const hex = hexSubmit.fields.getTextInputValue('hex_value').trim();
            if (!isValidHex(hex)) {
                await replyUserError(hexSubmit, {
                    type: ErrorTypes.USER_INPUT,
                    message: `\`${hex}\` is not a valid hex color. Use the format \`#RRGGBB\` (e.g. \`#5865F2\`).`,
                });
                return;
            }

            state.color = hex;
            await hexSubmit.deferUpdate().catch(() => {});
        } else {
            state.color = picked;
            await colorInter.deferUpdate().catch(() => {});
        }

        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder color picker interaction failed:', error.message);
        }
    });
}

async function handleSetAuthor(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_author')
        .setTitle('Set Author')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_name')
                    .setLabel('Author Name (leave blank to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.name || '')
                    .setMaxLength(256)
                    .setRequired(false)
                    .setPlaceholder('Your Name'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_icon')
                    .setLabel('Author Icon URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('author_url')
                    .setLabel('Author Link URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.author?.url || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await awaitForm(selectInteraction, state, 'eb_author', 120_000);

    if (!submitted) return;

    const name    = submitted.fields.getTextInputValue('author_name').trim();
    const iconUrl = submitted.fields.getTextInputValue('author_icon').trim();
    const url     = submitted.fields.getTextInputValue('author_url').trim();

    if (iconUrl && !isValidUrl(iconUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Author icon URL must be a valid `https://` URL.',
        });
        return;
    }
    if (url && !isValidUrl(url)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Author link URL must be a valid `https://` URL.',
        });
        return;
    }

    state.author = name ? { name, iconUrl: iconUrl || null, url: url || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetFooter(selectInteraction, rootInteraction, state) {
    const modal = new ModalBuilder()
        .setCustomId('eb_footer')
        .setTitle('Set Footer')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_text')
                    .setLabel('Footer Text (leave blank to remove)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.text || '')
                    .setMaxLength(2048)
                    .setRequired(false)
                    .setPlaceholder('Built with ZentixBot'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('footer_icon')
                    .setLabel('Footer Icon URL (optional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(state.footer?.iconUrl || '')
                    .setRequired(false)
                    .setPlaceholder('https://example.com/icon.png'),
            ),
        );

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await awaitForm(selectInteraction, state, 'eb_footer', 120_000);

    if (!submitted) return;

    const text    = submitted.fields.getTextInputValue('footer_text').trim();
    const iconUrl = submitted.fields.getTextInputValue('footer_icon').trim();

    if (iconUrl && !isValidUrl(iconUrl)) {
        await replyUserError(submitted, {
            type: ErrorTypes.USER_INPUT,
            message: 'Footer icon URL must be a valid `https://` URL.',
        });
        return;
    }

    state.footer = text ? { text, iconUrl: iconUrl || null } : null;

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleSetImages(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate().catch(() => {});

    const imageSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_image_pick')
        .setPlaceholder('What would you like to change?')
        .addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Thumbnail')
                .setDescription('Small image displayed in the top-right corner')
                .setValue('set_thumbnail')
                .setEmoji('🖼️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Set Large Image')
                .setDescription('Full-width banner image at the bottom')
                .setValue('set_image')
                .setEmoji('📸'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Clear Thumbnail')
                .setDescription('Remove the current thumbnail')
                .setValue('clear_thumbnail')
                .setEmoji('🗑️'),
            new StringSelectMenuOptionBuilder()
                .setLabel('Clear Large Image')
                .setDescription('Remove the current large image')
                .setValue('clear_image')
                .setEmoji('🗑️'),
        );

    const picker = await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Set Images')
                .setDescription('Choose which image to set or remove.')
                .addFields(
                    { name: 'Thumbnail',    value: state.thumbnail ? `[View](${state.thumbnail})` : '`Not set`', inline: true },
                    { name: 'Large Image',  value: state.image     ? `[View](${state.image})`     : '`Not set`', inline: true },
                )
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(imageSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const imgMenuCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            fromMessage(i, picker) && i.user.id === selectInteraction.user.id && i.customId === 'eb_image_pick',
        time: 60_000,
        max: 1,
    });

    imgMenuCollector.on('collect', async imgInter => {
        try {
        const pick = imgInter.values[0];

        if (pick === 'clear_thumbnail') {
            state.thumbnail = null;
            await imgInter.deferUpdate();
            await refreshDashboard(rootInteraction, state);
            return;
        }
        if (pick === 'clear_image') {
            state.image = null;
            await imgInter.deferUpdate();
            await refreshDashboard(rootInteraction, state);
            return;
        }

        const isThumb = pick === 'set_thumbnail';

        const urlModal = new ModalBuilder()
            .setCustomId('eb_image_url')
            .setTitle(isThumb ? 'Set Thumbnail' : 'Set Large Image')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('image_url')
                        .setLabel('Image URL')
                        .setStyle(TextInputStyle.Short)
                        .setValue(isThumb ? (state.thumbnail || '') : (state.image || ''))
                        .setRequired(true)
                        .setPlaceholder('https://example.com/image.png'),
                ),
            );

        const shown = await InteractionHelper.safeShowModal(imgInter, urlModal);
        if (!shown) return;

        const submitted = await awaitForm(imgInter, state, 'eb_image_url', 60_000);

        if (!submitted) return;

        const url = submitted.fields.getTextInputValue('image_url').trim();
        if (!isValidUrl(url)) {
            await replyUserError(submitted, {
                type: ErrorTypes.USER_INPUT,
                message: 'Image URL must be a valid `https://` link to a publicly accessible image.',
            });
            return;
        }

        if (isThumb) state.thumbnail = url;
        else         state.image     = url;

        await submitted.deferUpdate().catch(() => {});
        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder image picker interaction failed:', error.message);
        }
    });
}

async function handleAddField(selectInteraction, rootInteraction, state) {
    if (state.fields.length >= MAX_FIELDS) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: `Embeds can have a maximum of ${MAX_FIELDS} fields.`,
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId('eb_add_field')
        .setTitle('Add Field');

    const fieldNameLabel = new LabelBuilder()
        .setLabel('Field Name (max 256 characters)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_name')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(256)
                .setRequired(true)
                .setPlaceholder('Field Title'),
        );

    const fieldValueLabel = new LabelBuilder()
        .setLabel('Field Value (max 1024 characters)')
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId('field_value')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1024)
                .setRequired(true)
                .setPlaceholder('Field content goes here...'),
        );

    const inlineRadio = new RadioGroupBuilder()
        .setCustomId('field_inline')
        .setRequired(false)
        .addOptions([
            { label: 'No — full width', value: 'no' },
            { label: 'Yes — side-by-side', value: 'yes' },
        ]);

    const inlineLabel = new LabelBuilder()
        .setLabel('Display inline?')
        .setRadioGroupComponent(inlineRadio);

    modal.addLabelComponents(fieldNameLabel, fieldValueLabel, inlineLabel);

    const shown = await InteractionHelper.safeShowModal(selectInteraction, modal);
    if (!shown) return;

    const submitted = await awaitForm(selectInteraction, state, 'eb_add_field', 120_000);

    if (!submitted) return;

    const name     = submitted.fields.getTextInputValue('field_name').trim();
    const value    = submitted.fields.getTextInputValue('field_value').trim();
    const inline   = submitted.fields.getRadioGroup('field_inline') === 'yes';

    if (!name || !value) {
        await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: FIELD_NEEDS_TEXT });
        return;
    }
    if (state.fields.length >= MAX_FIELDS) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: `Embeds can have a maximum of ${MAX_FIELDS} fields.` });
        return;
    }
    state.fields.push({ name, value, inline });

    await submitted.deferUpdate().catch(() => {});
    await refreshDashboard(rootInteraction, state);
}

async function handleEditField(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_edit_field_pick')
        .setPlaceholder('Select a field to edit...')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 80)}${f.value.length > 80 ? '…' : ''} · ${f.inline ? 'Inline' : 'Block'}`,
                    )
                    .setValue(String(i))
                    .setEmoji('📝'),
            ),
        );

    const picker = await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Edit Field')
                .setDescription('Select the field you want to modify.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            fromMessage(i, picker) && i.user.id === selectInteraction.user.id && i.customId === 'eb_edit_field_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        try {
        const idx   = parseInt(pickInter.values[0], 10);
        const field = state.fields[idx];
        if (!field) { await pickInter.deferUpdate(); return; }

        const modal = new ModalBuilder()
            .setCustomId('eb_edit_field_modal')
            .setTitle(`Edit Field ${idx + 1}`);

        const editNameLabel = new LabelBuilder()
            .setLabel('Field Name')
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_name')
                    .setStyle(TextInputStyle.Short)
                    .setValue(field.name)
                    .setMaxLength(256)
                    .setRequired(true),
            );

        const editValueLabel = new LabelBuilder()
            .setLabel('Field Value')
            .setTextInputComponent(
                new TextInputBuilder()
                    .setCustomId('field_value')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(field.value.substring(0, 4000))
                    .setMaxLength(1024)
                    .setRequired(true),
            );

        const editInlineRadio = new RadioGroupBuilder()
            .setCustomId('field_inline')
            .setRequired(false)
            .addOptions([
                { label: 'No — full width', value: 'no' },
                { label: 'Yes — side-by-side', value: 'yes' },
            ]);
        
        if (field.inline) {
            editInlineRadio.setOptions([
                { label: 'No — full width', value: 'no' },
                { label: 'Yes — side-by-side', value: 'yes', default: true },
            ]);
        }

        const editInlineLabel = new LabelBuilder()
            .setLabel('Display inline?')
            .setRadioGroupComponent(editInlineRadio);

        modal.addLabelComponents(editNameLabel, editValueLabel, editInlineLabel);

        const shown = await InteractionHelper.safeShowModal(pickInter, modal);
        if (!shown) return;

        const submitted = await awaitForm(pickInter, state, 'eb_edit_field_modal', 120_000);

        if (!submitted) return;

        const name   = submitted.fields.getTextInputValue('field_name').trim();
        const value  = submitted.fields.getTextInputValue('field_value').trim();
        const inline = submitted.fields.getRadioGroup('field_inline') === 'yes';

        if (!name || !value) {
            await replyUserError(submitted, { type: ErrorTypes.USER_INPUT, message: FIELD_NEEDS_TEXT });
            return;
        }
        // The list may have changed while the form was open.
        if (state.fields[idx] !== field) {
            await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'The fields changed while this form was open. Please choose the field again.' });
            return;
        }
        state.fields[idx] = { name, value, inline };

        await submitted.deferUpdate().catch(() => {});
        await refreshDashboard(rootInteraction, state);
        } catch (error) {
            logger.warn('Embed builder field edit interaction failed:', error.message);
        }
    });
}

async function handleRemoveField(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_remove_field_pick')
        .setPlaceholder('Select a field to remove...')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 90)}${f.value.length > 90 ? '…' : ''}`,
                    )
                    .setValue(String(i))
                    .setEmoji('➖'),
            ),
        );

    const picker = await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Remove Field')
                .setDescription('Select the field you want to delete.')
                .setColor(getColor('warning')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const removeCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            fromMessage(i, picker) && i.user.id === selectInteraction.user.id && i.customId === 'eb_remove_field_pick',
        time: 60_000,
        max: 1,
    });

    removeCollector.on('collect', async removeInter => {
        await removeInter.deferUpdate();
        const idx = parseInt(removeInter.values[0], 10);
        state.fields.splice(idx, 1);
        await refreshDashboard(rootInteraction, state);
    });
}

async function handleReorderFields(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const pickSelect = new StringSelectMenuBuilder()
        .setCustomId('eb_reorder_pick')
        .setPlaceholder('Select a field to move...')
        .addOptions(
            state.fields.slice(0, 25).map((f, i) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i + 1}. ${f.name.substring(0, 50)}`)
                    .setDescription(
                        `${f.value.substring(0, 90)}${f.value.length > 90 ? '…' : ''}`,
                    )
                    .setValue(String(i))
                    .setEmoji('↕️'),
            ),
        );

    const picker = await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Reorder Fields')
                .setDescription('Select a field, then use the arrows to move it up or down.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(pickSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const pickCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: i =>
            fromMessage(i, picker) && i.user.id === selectInteraction.user.id && i.customId === 'eb_reorder_pick',
        time: 60_000,
        max: 1,
    });

    pickCollector.on('collect', async pickInter => {
        await pickInter.deferUpdate();
        const sourceIdx = parseInt(pickInter.values[0], 10);

        const upBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_up')
            .setLabel('Move Up')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⬆️')
            .setDisabled(sourceIdx === 0);

        const downBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_down')
            .setLabel('Move Down')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('⬇️')
            .setDisabled(sourceIdx === state.fields.length - 1);

        const cancelBtn = new ButtonBuilder()
            .setCustomId('eb_reorder_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary);

        const directionPicker = await pickInter.followUp({
            embeds: [
                new EmbedBuilder()
                    .setTitle('Move Field')
                    .setDescription(
                        `Moving **${state.fields[sourceIdx].name}** — currently at position **${sourceIdx + 1}** of **${state.fields.length}**.`,
                    )
                    .setColor(getColor('info')),
            ],
            components: [new ActionRowBuilder().addComponents(upBtn, downBtn, cancelBtn)],
            flags: MessageFlags.Ephemeral,
        });

        const dirCollector = rootInteraction.channel.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: i =>
                fromMessage(i, directionPicker) && i.user.id === selectInteraction.user.id &&
                ['eb_reorder_up', 'eb_reorder_down', 'eb_reorder_cancel'].includes(i.customId),
            time: 30_000,
            max: 1,
        });

        dirCollector.on('collect', async dirInter => {
            await dirInter.deferUpdate();
            if (dirInter.customId === 'eb_reorder_cancel') return;

            const targetIdx =
                dirInter.customId === 'eb_reorder_up' ? sourceIdx - 1 : sourceIdx + 1;

            if (targetIdx < 0 || targetIdx >= state.fields.length) return;

            const temp             = state.fields[sourceIdx];
            state.fields[sourceIdx] = state.fields[targetIdx];
            state.fields[targetIdx] = temp;

            await refreshDashboard(rootInteraction, state);
        });
    });
}

async function handlePostEmbed(selectInteraction, rootInteraction, state, guild) {
    if (
        !state.title &&
        !state.description &&
        state.fields.length === 0 &&
        !state.author?.name
    ) {
        await selectInteraction.deferUpdate();
        await replyUserError(selectInteraction, {
            type: ErrorTypes.VALIDATION,
            message: 'Add at least a title, description, or field before posting.',
        });
        return;
    }

    await selectInteraction.deferUpdate();

    const chanSelect = new ChannelSelectMenuBuilder()
        .setCustomId('eb_post_channel')
        .setPlaceholder('Select a channel...')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    const picker = await selectInteraction.followUp({
        embeds: [
            new EmbedBuilder()
                .setTitle('Post Embed')
                .setDescription('Select the channel where this embed will be sent.')
                .setColor(getColor('info')),
        ],
        components: [new ActionRowBuilder().addComponents(chanSelect)],
        flags: MessageFlags.Ephemeral,
    });

    const chanCollector = rootInteraction.channel.createMessageComponentCollector({
        componentType: ComponentType.ChannelSelect,
        filter: i =>
            fromMessage(i, picker) && i.user.id === selectInteraction.user.id && i.customId === 'eb_post_channel',
        time: 60_000,
        max: 1,
    });

    chanCollector.on('collect', async chanInter => {
        try {
            await chanInter.deferUpdate();
            const refuse = (message, type = ErrorTypes.PERMISSION) => replyUserError(chanInter, { type, message });
            const picked = chanInter.channels.first();
            const channel = picked ? guild.channels.cache.get(picked.id) : null;
            if (!channel || typeof channel.send !== 'function') {
                return await refuse('I could not find the selected channel. Please try again.', ErrorTypes.USER_INPUT);
            }

            // The bot posts on the member's behalf, so the member needs the right to post there too.
            const theirs = channel.permissionsFor(chanInter.member ?? chanInter.user.id);
            if (!theirs?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return await refuse(`You need **View Channel**, **Send Messages** and **Embed Links** in ${channel} to post an embed there.`);
            }
            const mine = channel.permissionsFor(guild.members.me);
            if (!mine?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return await refuse(`I need **View Channel**, **Send Messages** and **Embed Links** in ${channel} to post there.`);
            }

            // The panel may have been reset while this picker was open.
            if (isEmptyEmbed(state)) {
                return await refuse('Add at least a title, description, or field before posting.', ErrorTypes.VALIDATION);
            }
            const finalEmbed = buildPreviewEmbed(state);
            const total = embedLength(finalEmbed);
            if (total > EMBED_TOTAL_LIMIT) {
                return await refuse(`This embed has ${total} characters in total; Discord accepts at most ${EMBED_TOTAL_LIMIT}. Please shorten it.`, ErrorTypes.VALIDATION);
            }

            let posted;
            try {
                posted = await channel.send({ embeds: [finalEmbed], allowedMentions: { parse: [] } });
            } catch (error) {
                logger.warn('Embed builder could not post the embed', { guildId: guild.id, channelId: channel.id, userId: chanInter.user.id, code: error?.code, error: error?.message });
                return await refuse(`Discord refused the embed in ${channel}, so nothing was posted. Check the image and link addresses, then try again.`, ErrorTypes.DISCORD_API);
            }

            // The embed itself does not say who wrote it; this line does.
            logger.info('Embed posted with the embed builder', { guildId: guild.id, channelId: channel.id, messageId: posted?.id ?? null, userId: chanInter.user.id });
            await chanInter.followUp({
                embeds: [successEmbed('Embed Sent', `Your embed has been posted to ${channel}.`)],
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            logger.error('Embed builder post failed:', error);
            await replyUserError(chanInter, { type: ErrorTypes.UNKNOWN, message: 'The embed could not be posted. Please try again.' }).catch(() => {});
        }
    });
}

async function handleJsonExport(selectInteraction, rootInteraction, state) {
    await selectInteraction.deferUpdate();

    const json = JSON.stringify(buildPreviewEmbed(state), null, 2);

    // Shown as message text, not inside an embed: the bot's embeds would strip emoji from it.
    if (json.length <= 1900 && !json.includes('```')) {
        await selectInteraction.followUp({
            content: `**Embed JSON**\n\`\`\`json\n${json}\n\`\`\``,
            allowedMentions: { parse: [] },
            flags: MessageFlags.Ephemeral,
        });
    } else {
        await selectInteraction.followUp({
            content: '**Embed JSON** is attached as a file.',
            files: [
                {
                    attachment: Buffer.from(json, 'utf-8'),
                    name: 'embed.json',
                },
            ],
            flags: MessageFlags.Ephemeral,
        });
    }
}

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName('embedbuilder')
        .setDescription('Build and post a fully custom embed with live preview')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        try {
            const deferSuccess = await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
            if (!deferSuccess) return;

            const guild = interaction.guild;

            const state = {
                title:       null,
                description: null,
                color:       getColor('primary'),
                author:      null,
                footer:      null,
                thumbnail:   null,
                image:       null,
                timestamp:   false,
                fields:      [],
                formTurn:    0,
                touch:       null,
            };

            await refreshDashboard(interaction, state);
            const panel = await interaction.fetchReply();

            const collector = interaction.channel.createMessageComponentCollector({
                componentType: ComponentType.Button,
                filter: i =>
                    fromMessage(i, panel) && i.user.id === interaction.user.id && i.customId.startsWith('eb_main_'),
                time: SESSION_LIMIT,
                idle: IDLE_TIMEOUT,
            });
            // resetTimer() restarts both timers; the session limit is given what is left of it, so
            // that activity pushes back the idle timeout only.
            const deadline = Date.now() + SESSION_LIMIT;
            state.touch = () => collector.resetTimer?.({ time: Math.max(1, deadline - Date.now()) });

            collector.on('collect', async ci => {
                try {
                    switch (ci.customId) {
                        case 'eb_main_edit_content':
                            await handleEditContent(ci, interaction, state);
                            break;
                        case 'eb_main_set_color':
                            await handleSetColor(ci, interaction, state);
                            break;
                        case 'eb_main_set_author':
                            await handleSetAuthor(ci, interaction, state);
                            break;
                        case 'eb_main_set_footer':
                            await handleSetFooter(ci, interaction, state);
                            break;
                        case 'eb_main_set_images':
                            await handleSetImages(ci, interaction, state);
                            break;
                        case 'eb_main_post_embed':
                            await handlePostEmbed(ci, interaction, state, guild);
                            break;
                        case 'eb_main_add_field':
                            await handleAddField(ci, interaction, state);
                            break;
                        case 'eb_main_edit_field':
                            await handleEditField(ci, interaction, state);
                            break;
                        case 'eb_main_remove_field':
                            await handleRemoveField(ci, interaction, state);
                            break;
                        case 'eb_main_reorder_fields':
                            await handleReorderFields(ci, interaction, state);
                            break;
                        case 'eb_main_toggle_timestamp':
                            state.timestamp = !state.timestamp;
                            await ci.deferUpdate();
                            await refreshDashboard(interaction, state);
                            break;
                        case 'eb_main_json_export':
                            await handleJsonExport(ci, interaction, state);
                            break;
                        case 'eb_main_reset_all':
                            state.title       = null;
                            state.description = null;
                            state.color       = getColor('primary');
                            state.author      = null;
                            state.footer      = null;
                            state.thumbnail   = null;
                            state.image       = null;
                            state.timestamp   = false;
                            state.fields      = [];
                            await ci.deferUpdate();
                            await refreshDashboard(interaction, state);
                            break;
                        default:
                            await ci.deferUpdate();
                    }
                } catch (error) {
                    logger.error('Error in embedbuilder collector:', error);
                    const msg =
                        error instanceof ZentixBotError
                            ? error.userMessage || 'An error occurred.'
                            : 'An unexpected error occurred.';
                    if (!ci.replied && !ci.deferred) await ci.deferUpdate().catch(() => {});
                    await replyUserError(ci, {
                        type: ErrorTypes.UNKNOWN,
                        message: msg,
                    }).catch(() => {});
                }
            });

            collector.on('end', async (_, reason) => {
                if (reason === 'time' || reason === 'idle') {
                    state.touch = null;
                    await InteractionHelper.safeEditReply(interaction, {
                        content: reason === 'idle'
                            ? 'This embed builder closed after 5 minutes without activity. Use `/embedbuilder` to start again.'
                            : 'This embed builder reached its 14 minute limit and closed. Use `/embedbuilder` to start again.',
                        components: [],
                    }).catch(() => {});
                }
            });
        } catch (error) {
            if (error instanceof ZentixBotError) throw error;
            logger.error('Unexpected error in embedbuilder:', error);
            throw new ZentixBotError(
                `embedbuilder failed: ${error.message}`,
                ErrorTypes.UNKNOWN,
                'Failed to open the embed builder.',
            );
        }
    },
};