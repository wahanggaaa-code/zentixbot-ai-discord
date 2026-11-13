// /reactroles — set up and manage reaction role panels.
//
// Every change goes through src/services/reactionRoles/manage.js, the same code
// the web dashboard uses. A dashboard session holds only the message id of its
// panel and reads the stored panel again for every action, so two open
// dashboards cannot overwrite each other. Each press checks Manage Roles again.

import { getColor } from '../../config/bot.js';
import {
    SlashCommandBuilder, PermissionFlagsBits, ChannelType, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonBuilder, ButtonStyle, MessageFlags, ComponentType,
    EmbedBuilder, LabelBuilder, CheckboxBuilder, TextDisplayBuilder,
} from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { startDashboardSession, wrapDashboardHandler } from '../../utils/dashboardSession.js';
import {
    addPanelRole, checkActorRole, checkPanelRole, createPanel, deletePanel, editPanelText, inspectPanels, panelErrorMessage,
    refreshPanelMessage, removePanelRole, repostPanel, roleReason,
} from '../../services/reactionRoles/manage.js';
import { MAX_DESCRIPTION, MAX_ROLES, MAX_TITLE, readPanel, readPanels } from '../../services/reactionRoles/store.js';
import { recordPanelChange } from '../../services/reactionRoles/audit.js';

const DASHBOARD_EPHEMERAL = MessageFlags.Ephemeral;

const mayManage = (member) => member?.permissions?.has?.(PermissionFlagsBits.ManageRoles) === true;

// Mistakes of the person using the command; everything else is logged as a failure.
const USER_ERRORS = new Set([
    'REACTROLES_TITLE', 'REACTROLES_DESCRIPTION', 'REACTROLES_CHANNEL', 'REACTROLES_NO_ROLES', 'REACTROLES_ROLE_LIMIT',
    'REACTROLES_ROLE_REFUSED', 'REACTROLES_ROLE_DUPLICATE', 'REACTROLES_ROLE_NOT_ON_PANEL', 'REACTROLES_LAST_ROLE',
    'REACTROLES_LIMIT', 'REACTROLES_MISSING', 'REACTROLES_STALE', 'REACTROLES_NOT_MISSING', 'REACTROLES_CHANNEL_MISSING',
    'REACTROLES_BOT_PERMISSION', 'REACTROLES_ROLES_GONE',
]);

/** Tell the user what went wrong. Failures that are not the user's doing are logged. */
async function replyPanelError(interaction, error, fallback) {
    const expected = USER_ERRORS.has(error?.code);
    if (!expected) logger.error(`[REACTROLES] ${fallback}`, error?.cause ?? error);
    let message = panelErrorMessage(error, 'en', fallback);
    if (error?.code === 'REACTROLES_MESSAGE_LEFT' && error.url) message += `\n${error.url}`;
    await replyUserError(interaction, { type: expected ? ErrorTypes.USER_INPUT : ErrorTypes.UNKNOWN, message }).catch(logger.error);
}

/** What happened to the posted panel after a stored change. `null` when it shows the change. */
function redrawNote(message) {
    switch (message?.state) {
        case 'updated':
            return null;
        case 'missing':
            return 'The panel message no longer exists. Use **Repost Panel** to post it again.';
        case 'channel_missing':
            return 'The channel of this panel no longer exists, so there is no message to update.';
        case 'no_roles':
            return 'None of the roles on this panel exist any more, so the message was left as it is.';
        default:
            return 'The change is saved, but the panel message could not be updated right now. Use **Refresh Panel Message** to try again.';
    }
}

/** Success when the posted panel shows the change, a warning that says why when it does not. */
function resultEmbed(title, text, message) {
    const note = redrawNote(message);
    return note ? warningEmbed(title, `${text}\n\n⚠️ ${note}`) : successEmbed(title, text);
}

export default {
    data: new SlashCommandBuilder()
        .setName('reactroles')
        .setDescription('Manage reaction role assignments')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up a new reaction role panel')
                .addChannelOption(option => 
                    option.setName('channel')
                        .setDescription('The channel to send the reaction role message to')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('title')
                        .setDescription('Title for the reaction role panel')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('description')
                        .setDescription('Description for the reaction role panel')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role1')
                        .setDescription('First role to add')
                        .setRequired(true)
                )
                .addRoleOption(option =>
                    option.setName('role2')
                        .setDescription('Second role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role3')
                        .setDescription('Third role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role4')
                        .setDescription('Fourth role to add')
                        .setRequired(false)
                )
                .addRoleOption(option =>
                    option.setName('role5')
                        .setDescription('Fifth role to add')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('dashboard')
                .setDescription('Manage and configure your reaction role panels')
                .addStringOption(option =>
                    option
                        .setName('panel')
                        .setDescription('Select a reaction role panel to manage')
                        .setRequired(false)
                        .setAutocomplete(true)
                )
        ),

    async execute(interaction) {
        if (!mayManage(interaction.member)) {
            await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the **Manage Roles** permission to manage reaction role panels.',
            }).catch(logger.error);
            return;
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'setup') {
            await handleSetup(interaction);
        } else if (subcommand === 'dashboard') {
            await handleDashboard(interaction, interaction.options.getString('panel'));
        }
    },

    async autocomplete(interaction) {
        if (interaction.commandName !== 'reactroles') return;
        if (interaction.options.getSubcommand() !== 'dashboard') return;
        // Autocomplete must respond within 3s: stored data and cached channels only, no Discord fetches.
        try {
            const guild = interaction.guild;
            const { panels } = await readPanels(interaction.client, guild.id);
            const choices = panels.slice(0, 25).map((panel) => {
                const channel = guild.channels.cache.get(panel.channelId);
                const title = panel.title ?? channel?.messages?.cache?.get(panel.messageId)?.embeds?.[0]?.title ?? null;
                const place = channel ? `#${channel.name}` : 'channel missing';
                const count = `${panel.roles.length} role${panel.roles.length === 1 ? '' : 's'}`;
                return { name: `${title ? `${title} · ` : ''}${place} · ${count}`.slice(0, 100), value: panel.messageId };
            });
            await interaction.respond(choices).catch(() => {});
        } catch {
            await interaction.respond([]).catch(() => {});
        }
    },
};

async function handleSetup(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) return;

    const guild = interaction.guild;
    const channel = interaction.options.getChannel('channel');
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    const roles = [];
    const refused = [];
    const seen = new Set();
    for (let i = 1; i <= 5; i++) {
        const role = interaction.options.getRole(`role${i}`);
        if (!role) continue;
        if (seen.has(role.id)) {
            refused.push(`**${role.name}** - This role was selected more than once.`);
            continue;
        }
        seen.add(role.id);
        const check = checkPanelRole(guild, role);
        const mine = check.ok ? checkActorRole(guild, interaction.member, role) : check;
        if (!mine.ok) {
            refused.push(`**${role.name}** - ${roleReason(mine.code)}`);
            continue;
        }
        roles.push(role);
    }
    if (roles.length === 0) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: refused.length
                ? `None of the selected roles can be offered on a panel:\n${refused.join('\n')}`
                : 'You must provide at least one role.',
        }).catch(logger.error);
        return;
    }

    let created;
    try {
        created = await createPanel(interaction.client, guild, { channel, title, description, roles, actor: interaction.member });
    } catch (error) {
        await replyPanelError(interaction, error, 'The panel could not be created. Nothing was changed.');
        return;
    }
    const { message } = created;
    logger.info(`Reaction role panel created: ${message.id} with ${roles.length} roles by ${interaction.user.tag}`);

    try {
        await logEvent({
            client: interaction.client,
            guildId: interaction.guildId,
            eventType: EVENT_TYPES.REACTION_ROLE_CREATE,
            data: {
                description: `Reaction role panel created by ${interaction.user.tag}`,
                userId: interaction.user.id,
                channelId: channel.id,
                fields: [
                    { name: 'Title', value: created.panel.title.slice(0, 1024), inline: false },
                    { name: 'Channel', value: channel.toString(), inline: true },
                    { name: 'Roles', value: `${roles.length} roles`, inline: true },
                    { name: 'Role List', value: roles.map((role) => role.toString()).join(', ').slice(0, 1024), inline: false },
                    { name: 'Message Link', value: message.url, inline: false },
                ],
            },
        });
    } catch (logError) {
        logger.warn('Failed to log reaction role creation:', logError);
    }

    const text = `✅ Reaction role panel created in ${channel}!\n\n${message.url}`;
    await InteractionHelper.safeEditReply(interaction, {
        embeds: [refused.length
            ? warningEmbed('Panel created', `${text}\n\n⚠️ These roles were left out:\n${refused.join('\n')}`)
            : successEmbed('Success', text)],
    });
}

// ---- dashboard --------------------------------------------------------------------

const STATUS_TEXT = {
    ok: (panel) => (panel.url ? `✅ Active — [view panel](${panel.url})` : '✅ Active'),
    message_missing: () => '⚠️ Panel message was deleted — use **Repost Panel** below',
    channel_missing: () => '⚠️ Panel channel missing or deleted — delete this panel and create a new one',
    unknown: () => '❔ Could not be checked at Discord right now',
};

function roleLine(state) {
    if (state.ok) return `<@&${state.id}>`;
    if (state.reason === 'ROLE_MISSING') return `\`${state.id}\` ⚠️ deleted role`;
    return `<@&${state.id}> ⚠️ ${roleReason(state.reason)}`;
}

function buildDashboardPayload(panel, guildId) {
    const roleList = panel.roleStates.length ? panel.roleStates.map(roleLine).join('\n').slice(0, 1024) : '`None`';
    const embed = new EmbedBuilder()
        .setTitle('Reaction Roles Dashboard')
        .setDescription(`**Title:** ${panel.title ?? 'Untitled Panel'}\n\nSelect an option below to modify a setting.`)
        .setColor(getColor('info'))
        .addFields(
            { name: 'Panel Status', value: (STATUS_TEXT[panel.status] ?? STATUS_TEXT.unknown)(panel), inline: false },
            { name: 'Channel', value: panel.channel ? `<#${panel.channel.id}>` : '`Not found`', inline: true },
            { name: 'Roles', value: `\`${panel.roles.length} / ${MAX_ROLES}\``, inline: true },
            { name: '\u200B', value: '\u200B', inline: true },
            { name: 'Role List', value: roleList, inline: false },
        )
        .setFooter({ text: 'Dashboard closes after 10 minutes of inactivity' })
        .setTimestamp();

    const buttons = [];
    if (panel.status === 'message_missing') {
        buttons.push(new ButtonBuilder().setCustomId(`rr_repost_${guildId}`).setLabel('Repost Panel').setStyle(ButtonStyle.Primary).setEmoji('📌'));
    }
    if (panel.status === 'ok') {
        buttons.push(new ButtonBuilder().setCustomId(`rr_sync_${guildId}`).setLabel('Refresh Panel Message').setStyle(ButtonStyle.Secondary).setEmoji('🔄'));
    }
    buttons.push(
        new ButtonBuilder().setCustomId(`rr_edit_text_${guildId}`).setLabel('Edit Panel Text').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId(`rr_delete_${guildId}`).setLabel('Delete Panel').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    );

    const options = [];
    if (panel.roles.length < MAX_ROLES) {
        options.push(new StringSelectMenuOptionBuilder().setLabel('Add Role').setDescription(`Add a role to this panel (up to ${MAX_ROLES} total)`).setValue('add_role').setEmoji('➕'));
    }
    if (panel.roles.length > 1) {
        options.push(new StringSelectMenuOptionBuilder().setLabel('Remove Role').setDescription('Remove a role from this panel').setValue('remove_role').setEmoji('➖'));
    }
    const components = [new ActionRowBuilder().addComponents(buttons)];
    if (options.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`rr_opts_${guildId}`).setPlaceholder('Select an action...').addOptions(options),
        ));
    }
    return { embeds: [embed], components };
}

async function handleDashboard(interaction, selectedPanelId) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: DASHBOARD_EPHEMERAL });
    if (!deferSuccess) return;

    const client = interaction.client;
    const guild = interaction.guild;
    const guildId = guild.id;

    let view;
    try {
        view = await inspectPanels(client, guild);
    } catch (error) {
        await replyPanelError(interaction, error, 'The reaction role panels could not be read right now.');
        return;
    }
    if (view.panels.length === 0) {
        await replyUserError(interaction, {
            type: ErrorTypes.CONFIGURATION,
            message: 'No reaction role panels found. Use `/reactroles setup` first.',
        }).catch(logger.error);
        return;
    }
    const first = selectedPanelId ? view.panels.find((panel) => panel.messageId === selectedPanelId) : null;
    if (!first && view.panels.length > 1) {
        await replyUserError(interaction, {
            type: ErrorTypes.USER_INPUT,
            message: 'Multiple panels exist. Choose one using the **panel** option.',
        }).catch(logger.error);
        return;
    }

    // The session knows which panel it is about, not what the panel contains.
    const session = { messageId: (first ?? view.panels[0]).messageId, closed: false, stop: () => {} };
    const ctx = { client, guild, guildId, root: interaction, session };

    /** Read the panel again and redraw the dashboard. Returns the panel, or null when it is gone. */
    ctx.show = async () => {
        const current = (await inspectPanels(client, guild)).panels.find((panel) => panel.messageId === session.messageId);
        if (!current) {
            await closeDashboard(ctx, 'This panel no longer exists. Run `/reactroles dashboard` to manage another panel.');
            return null;
        }
        await InteractionHelper.safeEditReply(interaction, { ...buildDashboardPayload(current, guildId), flags: DASHBOARD_EPHEMERAL });
        return current;
    };

    /** False (and an answer to the press) when the member may no longer manage panels. */
    ctx.allowed = async (pressed) => {
        if (mayManage(pressed.member)) return true;
        await replyUserError(pressed, {
            type: ErrorTypes.PERMISSION,
            message: 'You no longer have the **Manage Roles** permission. Nothing was changed.',
        }).catch(logger.error);
        return false;
    };

    const started = await startDashboardSession({
        interaction,
        ...buildDashboardPayload(first ?? view.panels[0], guildId),
        flags: DASHBOARD_EPHEMERAL,
        selectMenuId: `rr_opts_${guildId}`,
        buttonMatcher: (customId) => [`rr_edit_text_${guildId}`, `rr_delete_${guildId}`, `rr_repost_${guildId}`, `rr_sync_${guildId}`].includes(customId),
        onSelect: async (pressed) => {
            if (session.closed || !(await ctx.allowed(pressed))) return;
            if (pressed.values[0] === 'add_role') await handleAddRole(pressed, ctx);
            else if (pressed.values[0] === 'remove_role') await handleRemoveRole(pressed, ctx);
        },
        onButton: async (pressed) => {
            if (session.closed || !(await ctx.allowed(pressed))) return;
            if (pressed.customId === `rr_repost_${guildId}`) await handleRepost(pressed, ctx);
            else if (pressed.customId === `rr_sync_${guildId}`) await handleRefresh(pressed, ctx);
            else if (pressed.customId === `rr_edit_text_${guildId}`) await handleEditText(pressed, ctx);
            else if (pressed.customId === `rr_delete_${guildId}`) await handleDeletePanel(pressed, ctx);
        },
    });
    session.stop = started.stop;
}

async function closeDashboard(ctx, text, color = 'info') {
    ctx.session.closed = true;
    ctx.session.stop();
    await InteractionHelper.safeEditReply(ctx.root, {
        embeds: [new EmbedBuilder().setTitle('Reaction Roles Dashboard').setDescription(text).setColor(getColor(color))],
        components: [],
        flags: DASHBOARD_EPHEMERAL,
    });
}

/** Wait for one pick on a follow-up prompt of this press. Other dashboards' prompts are not answered here. */
function collectPick(pressed, ctx, prompt, { componentType, customId }, onPick) {
    const collector = ctx.root.channel.createMessageComponentCollector({
        componentType,
        filter: (i) => i.user.id === pressed.user.id && i.customId === customId && (!prompt?.id || i.message?.id === prompt.id),
        time: 60_000,
        max: 1,
    });
    collector.on('collect', wrapDashboardHandler(async (pick) => {
        if (ctx.session.closed || !(await ctx.allowed(pick))) return;
        await pick.deferUpdate();
        await onPick(pick);
    }, 'reaction roles dashboard'));
    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            replyUserError(pressed, { type: ErrorTypes.RATE_LIMIT, message: 'No role selected. Nothing was changed.' }).catch(() => {});
        }
    });
}

async function handleAddRole(pressed, ctx) {
    await pressed.deferUpdate();
    const prompt = await pressed.followUp({
        embeds: [new EmbedBuilder().setTitle('Add Role').setDescription('Select a role to add to this panel.').setColor(getColor('info'))],
        components: [new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId('rr_add_role_pick').setPlaceholder('Select a role to add...').setMaxValues(1),
        )],
        flags: MessageFlags.Ephemeral,
    });
    collectPick(pressed, ctx, prompt, { componentType: ComponentType.RoleSelect, customId: 'rr_add_role_pick' }, async (pick) => {
        const role = pick.roles.first();
        try {
            const { panel, message } = await addPanelRole(ctx.client, ctx.guild, ctx.session.messageId, role, { actor: pick.member });
            await recordPanelChange(ctx.client, ctx.guildId, 'role_add', { actorId: pick.user.id, messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleId: role.id });
            await pick.followUp({ embeds: [resultEmbed('Role Added', `${role} has been added to the panel.`, message)], flags: MessageFlags.Ephemeral });
        } catch (error) {
            await replyPanelError(pick, error, 'The role could not be added. Nothing was changed.');
        }
        await ctx.show();
    });
}

async function handleRemoveRole(pressed, ctx) {
    await pressed.deferUpdate();
    let panel;
    try {
        panel = (await inspectPanels(ctx.client, ctx.guild)).panels.find((entry) => entry.messageId === ctx.session.messageId);
    } catch (error) {
        await replyPanelError(pressed, error, 'The panel could not be read right now.');
        return;
    }
    if (!panel) {
        await ctx.show();
        return;
    }
    // Deleted roles are listed too: this is the only way to take them off the panel.
    const options = panel.roleStates.slice(0, 25).map((state) => new StringSelectMenuOptionBuilder()
        .setLabel((state.name ?? `Deleted role (${state.id})`).slice(0, 100))
        .setValue(state.id)
        .setEmoji('🎭'));
    const prompt = await pressed.followUp({
        embeds: [new EmbedBuilder().setTitle('Remove Role').setDescription('Select the role you want to remove from this panel.').setColor(getColor('info'))],
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('rr_remove_role_pick').setPlaceholder('Select a role to remove...').setMaxValues(1).addOptions(options),
        )],
        flags: MessageFlags.Ephemeral,
    });
    collectPick(pressed, ctx, prompt, { componentType: ComponentType.StringSelect, customId: 'rr_remove_role_pick' }, async (pick) => {
        const roleId = pick.values[0];
        try {
            const { panel, message } = await removePanelRole(ctx.client, ctx.guild, ctx.session.messageId, roleId);
            await recordPanelChange(ctx.client, ctx.guildId, 'role_remove', { actorId: pick.user.id, messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleId });
            await pick.followUp({ embeds: [resultEmbed('Role Removed', `<@&${roleId}> has been removed from the panel.`, message)], flags: MessageFlags.Ephemeral });
        } catch (error) {
            await replyPanelError(pick, error, 'The role could not be removed. Nothing was changed.');
        }
        await ctx.show();
    });
}

async function handleRepost(pressed, ctx) {
    await pressed.deferUpdate();
    try {
        const { panel, message } = await repostPanel(ctx.client, ctx.guild, ctx.session.messageId);
        ctx.session.messageId = panel.messageId;
        await recordPanelChange(ctx.client, ctx.guildId, 'repost', { actorId: pressed.user.id, messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleIds: panel.roles });
        await pressed.followUp({
            embeds: [successEmbed('Panel Reposted', `The reaction role panel was posted again in <#${panel.channelId}>.\n${message.url ?? ''}`)],
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        await replyPanelError(pressed, error, 'The panel could not be reposted. Nothing was changed.');
    }
    await ctx.show();
}

async function handleRefresh(pressed, ctx) {
    await pressed.deferUpdate();
    try {
        const { message } = await refreshPanelMessage(ctx.client, ctx.guild, ctx.session.messageId);
        await pressed.followUp({
            embeds: [resultEmbed('Panel Refreshed', 'The panel message was drawn again from the stored panel.', message)],
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        await replyPanelError(pressed, error, 'The panel message could not be refreshed.');
    }
    await ctx.show();
}

/** Stored text of the panel for a modal. A modal must open within 3s: the database and the cache only. */
async function currentText(ctx) {
    const panel = await readPanel(ctx.client, ctx.guildId, ctx.session.messageId).catch(() => null);
    const shown = ctx.guild.channels.cache.get(panel?.channelId)?.messages?.cache?.get(panel?.messageId)?.embeds?.[0];
    return {
        title: String(panel?.title ?? shown?.title ?? '').slice(0, MAX_TITLE),
        description: String(panel?.description ?? shown?.description ?? '').slice(0, MAX_DESCRIPTION),
    };
}

async function handleEditText(pressed, ctx) {
    const text = await currentText(ctx);
    const modal = new ModalBuilder()
        .setCustomId('rr_edit_text')
        .setTitle('Edit Panel Text')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('panel_title').setLabel('Title').setStyle(TextInputStyle.Short)
                    .setValue(text.title).setMaxLength(MAX_TITLE).setMinLength(1).setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('panel_description').setLabel('Description').setStyle(TextInputStyle.Paragraph)
                    .setValue(text.description).setMaxLength(MAX_DESCRIPTION).setMinLength(1).setRequired(true),
            ),
        );
    try {
        await pressed.showModal(modal);
    } catch (error) {
        logger.error('Error showing edit text modal:', error);
        await replyUserError(pressed, { type: ErrorTypes.UNKNOWN, message: 'Failed to show the edit panel text modal. Please try again.' }).catch(() => {});
        return;
    }
    const submitted = await pressed
        .awaitModalSubmit({ filter: (i) => i.customId === 'rr_edit_text' && i.user.id === pressed.user.id, time: 120_000 })
        .catch(() => null);
    if (!submitted) return;
    if (ctx.session.closed || !(await ctx.allowed(submitted))) return;

    try {
        const { panel, message } = await editPanelText(ctx.client, ctx.guild, ctx.session.messageId, {
            title: submitted.fields.getTextInputValue('panel_title'),
            description: submitted.fields.getTextInputValue('panel_description'),
        });
        await recordPanelChange(ctx.client, ctx.guildId, 'text', { actorId: submitted.user.id, messageId: panel.messageId, channelId: panel.channelId, title: panel.title });
        await submitted.reply({
            embeds: [resultEmbed('Panel Updated', 'The title and description have been saved.', message)],
            flags: MessageFlags.Ephemeral,
        });
    } catch (error) {
        await replyPanelError(submitted, error, 'The panel text could not be changed. Nothing was changed.');
    }
    await ctx.show();
}

async function handleDeletePanel(pressed, ctx) {
    const { title } = await currentText(ctx);
    const name = title || 'this panel';
    const deleteModal = new ModalBuilder().setCustomId('rr_delete_confirm_modal').setTitle('Delete Reaction Role Panel');
    deleteModal
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `⚠️ You are about to permanently delete the panel **${name.slice(0, 200)}**. This removes the Discord message and the stored panel. Roles members already have are kept.`,
        ))
        .addLabelComponents(new LabelBuilder()
            .setLabel('I confirm — this cannot be undone')
            .setCheckboxComponent(new CheckboxBuilder().setCustomId('delete_confirmation').setDefault(false)));
    await pressed.showModal(deleteModal);

    const submitted = await pressed
        .awaitModalSubmit({ filter: (i) => i.customId === 'rr_delete_confirm_modal' && i.user.id === pressed.user.id, time: 120_000 })
        .catch(() => null);
    if (!submitted) return;
    if (ctx.session.closed || !(await ctx.allowed(submitted))) return;
    if (!submitted.fields.getCheckbox('delete_confirmation')) {
        await replyUserError(submitted, { type: ErrorTypes.VALIDATION, message: 'You must tick the confirmation checkbox to delete the panel.' });
        return;
    }
    await submitted.deferUpdate();

    let deleted;
    try {
        deleted = await deletePanel(ctx.client, ctx.guild, ctx.session.messageId);
    } catch (error) {
        await replyPanelError(submitted, error, 'The panel could not be deleted. Nothing was changed.');
        await ctx.show().catch(() => {});
        return;
    }
    try {
        await logEvent({
            client: ctx.client,
            guildId: ctx.guildId,
            eventType: EVENT_TYPES.REACTION_ROLE_DELETE,
            data: {
                description: `Reaction role panel deleted by ${submitted.user.tag}`,
                userId: submitted.user.id,
                channelId: deleted.panel.channelId,
                fields: [
                    { name: 'Panel', value: (deleted.title ?? name).slice(0, 1024), inline: true },
                    { name: 'Channel', value: `<#${deleted.panel.channelId}>`, inline: true },
                ],
            },
        });
    } catch (logErr) {
        logger.warn('Failed to log reaction role deletion:', logErr);
    }
    await submitted.followUp({
        embeds: [successEmbed('Panel Deleted', `**${deleted.title ?? name}** has been deleted.`)],
        flags: MessageFlags.Ephemeral,
    });

    const left = await readPanels(ctx.client, ctx.guildId).then((result) => result.panels.length, () => null);
    await closeDashboard(
        ctx,
        left === 0 ? 'No panels remain. Use `/reactroles setup` to create one.' : 'Panel deleted. Run `/reactroles dashboard` to manage another panel.',
        left === 0 ? 'info' : 'success',
    );
}
