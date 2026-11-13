import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { isApplicationId, readAll, readApplication, readConfig } from '../../services/applications/store.js';
import { openForm } from '../../services/applications/service.js';
import { applyModal, listEmbed, ownListEmbed, refusalMessage, statusEmbed } from '../../services/applications/view.js';
import { refuse } from '../../handlers/applicationHandlers.js';

const PRIVATE = MessageFlags.Ephemeral;
const say = (interaction, message) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message });

/** The forms a member can apply with right now: switched on, and their role still exists. */
const openForms = (guild, forms) => forms.filter((form) => form.enabled && guild.roles.cache.has(form.roleId));

export default {
    slashOnly: true,
    data: new SlashCommandBuilder()
        .setName("apply")
        .setDescription("Manage role applications")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("submit")
                .setDescription("Submit an application for a role")
                .addStringOption((option) =>
                    option
                        .setName("application")
                        .setDescription("The application you want to submit")
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("status")
                .setDescription("Check the status of your application")
                .addStringOption((option) =>
                    option
                        .setName("id")
                        .setDescription("Application ID (leave empty to see all)")
                        .setRequired(false),
                ),
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("list")
                .setDescription("List available applications to apply for"),
        ),
    category: "Community",

    execute: withErrorHandling(async (interaction) => {
        if (!interaction.inGuild()) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This command can only be used in a server.' });
        }
        const { guild, client } = interaction;
        const subcommand = interaction.options.getSubcommand();
        logger.info(`Apply command executed: ${subcommand}`, { userId: interaction.user.id, guildId: guild.id, subcommand });

        try {
            if (subcommand === 'submit') {
                // The form must be the first answer to the command, so nothing is deferred here.
                const { form, questions, mark } = await openForm(client, guild, interaction.member, interaction.options.getString('application') ?? '');
                return await interaction.showModal(applyModal(form, questions, mark));
            }

            if (subcommand === 'list') {
                await interaction.deferReply();
                const { settings, forms } = await readConfig(client, guild.id);
                if (!settings.enabled) return await say(interaction, refusalMessage({ code: 'APP_DISABLED' }));
                const available = openForms(guild, forms);
                if (available.length === 0) return await say(interaction, 'No applications are currently available.');
                return await interaction.editReply({ embeds: [listEmbed(guild, available)] });
            }

            // status: a member's own applications stay readable while applications are switched off.
            await interaction.deferReply({ flags: PRIVATE });
            const id = interaction.options.getString('id');
            if (id) {
                const application = isApplicationId(id.trim()) ? await readApplication(client, guild.id, id.trim()) : null;
                // One answer for "no such application" and "not yours": an id must not reveal that it exists.
                if (!application || application.userId !== interaction.user.id) return await say(interaction, 'Application not found. Use `/apply status` without an ID to see your applications.');
                return await interaction.editReply({ embeds: [statusEmbed(application)] });
            }
            const { applications } = await readAll(client, guild.id);
            const own = applications.filter((application) => application.userId === interaction.user.id);
            if (own.length === 0) return await say(interaction, 'You have not submitted any applications yet.');
            return await interaction.editReply({ embeds: [ownListEmbed(own)] });
        } catch (error) {
            return await refuse(interaction, error, `apply ${subcommand}`);
        }
    }, { type: 'command', commandName: 'apply' }),

    /** The applications a member can choose: only those that are open. A failed read offers nothing. */
    async autocomplete(interaction, client) {
        let choices = [];
        try {
            const typed = String(interaction.options.getFocused() ?? '').toLowerCase();
            const { settings, forms } = await readConfig(client, interaction.guildId);
            if (settings.enabled) {
                choices = openForms(interaction.guild, forms)
                    .filter((form) => form.name.toLowerCase().includes(typed))
                    .slice(0, 25)
                    .map((form) => ({ name: form.name, value: form.name }));
            }
        } catch (error) {
            logger.warn('Apply autocomplete failed', { guildId: interaction.guildId, code: error?.code });
        }
        await interaction.respond(choices).catch(() => {});
    },
};
