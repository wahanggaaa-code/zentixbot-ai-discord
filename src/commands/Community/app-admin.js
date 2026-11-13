import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { isApplicationId, purgeExpired, readAll, readConfig } from '../../services/applications/store.js';
import { canConfigure, canReview } from '../../services/applications/service.js';
import { adminListEmbed, newFormModal, refusalMessage, reviewPayload } from '../../services/applications/view.js';
import { refuse, showDashboard } from '../../handlers/applicationHandlers.js';

const PRIVATE = MessageFlags.Ephemeral;
const say = (interaction, message, type = ErrorTypes.VALIDATION) => replyUserError(interaction, { type, message });
const forbidden = (interaction) => say(interaction, refusalMessage({ code: 'APP_FORBIDDEN' }), ErrorTypes.PERMISSION);

async function handleReview(interaction) {
    const { settings, applications } = await readAll(interaction.client, interaction.guild.id);
    if (!canReview(interaction.guild, interaction.member, settings)) return forbidden(interaction);
    const id = String(interaction.options.getString('id') ?? '').trim();
    const application = isApplicationId(id) ? applications.find((entry) => entry.id === id) : null;
    if (!application) return say(interaction, refusalMessage({ code: 'APP_NOT_FOUND' }));
    // An application that was already decided is shown as decided, without buttons.
    return interaction.editReply(reviewPayload(application));
}

async function handleList(interaction) {
    const { client, guild } = interaction;
    const { settings, forms, applications } = await readAll(client, guild.id);
    if (!canReview(guild, interaction.member, settings)) return forbidden(interaction);

    const status = interaction.options.getString('status') ?? 'pending';
    const user = interaction.options.getUser('user');
    const roleFilter = String(interaction.options.getString('role') ?? '').trim();
    const limit = Math.min(Math.max(Math.trunc(interaction.options.getNumber('limit') ?? 10), 1), 25);

    const filters = [status];
    let found = applications.filter((application) => application.status === status);
    if (user) {
        found = found.filter((application) => application.userId === user.id);
        filters.push(`user <@${user.id}>`);
    }
    if (roleFilter) {
        // A role id, a role mention, or the name of an application.
        const roleId = roleFilter.replace(/^<@&(\d+)>$/, '$1');
        const byName = forms.find((form) => form.name.toLowerCase() === roleFilter.toLowerCase());
        found = found.filter((application) => application.roleId === roleId || application.roleId === byName?.roleId);
        filters.push(`role ${byName ? byName.name : roleFilter.slice(0, 40)}`);
    }

    // Applications past their retention were already left out; remove them for good while we are here.
    purgeExpired(client, guild.id).catch((error) => logger.warn('Could not remove expired applications', { guildId: guild.id, code: error?.code }));

    if (found.length === 0) {
        const hint = forms.length === 0 ? '\nNo application is set up yet. Use `/app-admin setup` to create one.' : '';
        return say(interaction, `No ${status} applications found${filters.length > 1 ? ' for this filter' : ''}.${hint}`);
    }
    return interaction.editReply({ embeds: [adminListEmbed(found.slice(0, limit), { total: found.length, filters })] });
}

export default {
    // Forms and private replies only exist for slash commands; as a prefix command the list of applicants would be posted in the channel.
    slashOnly: true,
    data: new SlashCommandBuilder()
    .setName("app-admin")
    .setDescription("Manage staff applications")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
        subcommand
            .setName("setup")
            .setDescription("Set up a new application")
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("review")
            .setDescription("Approve or deny an application")
            .addStringOption((option) =>
                option
                    .setName("id")
                    .setDescription("The application ID")
                    .setRequired(true),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("list")
            .setDescription("List all applications")
            .addStringOption((option) =>
                option
                    .setName("status")
                    .setDescription("Filter by status")
                    .addChoices(
                        { name: "Pending", value: "pending" },
                        { name: "Approved", value: "approved" },
                        { name: "Denied", value: "denied" },
                    ),
            )
            .addStringOption((option) =>
                option.setName("role").setDescription("Filter by role ID or application name"),
            )
            .addUserOption((option) =>
                option.setName("user").setDescription("Filter by user"),
            )
            .addNumberOption((option) =>
                option
                    .setName("limit")
                    .setDescription(
                        "Maximum number of applications to show (default: 10)",
                    )
                    .setMinValue(1)
                    .setMaxValue(25),
            ),
    )
    .addSubcommand((subcommand) =>
        subcommand
            .setName("dashboard")
            .setDescription("Open the applications configuration dashboard")
            .addStringOption((option) =>
                option
                    .setName("application")
                    .setDescription("Select an application to configure")
                    .setRequired(false)
                    .setAutocomplete(true),
            ),
    ),
    category: "Community",

    /**
     * Discord shows this command to Manage Server only, unless the server allows a role under
     * Integrations. Reading and deciding applications is also open to the manager roles chosen in the
     * application settings, so those two subcommands decide for themselves (`canReview`).
     */
    checksOwnAccess(interaction) {
        return ['review', 'list'].includes(interaction.options.getSubcommand());
    },

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }
        const { guild, client } = interaction;
        const subcommand = interaction.options.getSubcommand();
        logger.info(`App-admin command executed: ${subcommand}`, { userId: interaction.user.id, guildId: guild.id, subcommand });

        try {
            if (subcommand === 'setup') {
                // Settings and forms are for Manage Server; a manager role only reviews.
                if (!canConfigure(guild, interaction.member)) return await forbidden(interaction);
                return await interaction.showModal(newFormModal());
            }
            if (subcommand === 'dashboard') {
                if (!canConfigure(guild, interaction.member)) return await forbidden(interaction);
                await interaction.deferReply({ flags: PRIVATE });
                const wanted = String(interaction.options.getString('application') ?? '').trim().toLowerCase();
                let scope = 'global';
                if (wanted) {
                    const { forms } = await readConfig(client, guild.id);
                    scope = forms.find((form) => form.name.toLowerCase() === wanted)?.roleId ?? 'global';
                }
                return await showDashboard(interaction, client, scope, wanted && scope === 'global' ? 'There is no application with that name; this is the overview.' : null);
            }
            await interaction.deferReply({ flags: PRIVATE });
            if (subcommand === 'review') return await handleReview(interaction);
            return await handleList(interaction);
        } catch (error) {
            return await refuse(interaction, error, `app-admin ${subcommand}`);
        }
    }, { type: 'command', commandName: 'app-admin' }),

    /** Every application of the server, open or closed. A failed read offers nothing. */
    async autocomplete(interaction, client) {
        let choices = [];
        try {
            const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
            const { forms } = await readConfig(client, interaction.guildId);
            choices = forms.filter((form) => form.name.toLowerCase().includes(typed)).slice(0, 25)
                .map((form) => ({ name: `${form.name}${form.enabled ? '' : ' (closed)'}`.slice(0, 100), value: form.name }));
        } catch (error) {
            logger.warn('App-admin autocomplete failed', { guildId: interaction.guildId, code: error?.code });
        }
        await interaction.respond(choices).catch(() => {});
    },
};
