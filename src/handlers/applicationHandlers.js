// Buttons, select menus and forms of role applications. Every id is `app:<action>[:<argument>...]`
// and is handled here whoever presses it and whenever: nothing depends on a collector being alive,
// so each handler checks for itself that the member may do what the component does.

import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { setLogChannel } from '../services/loggingService.js';
import { LIMITS, isApplicationId, isSnowflake, readAll, readConfig } from '../services/applications/store.js';
import {
    canConfigure, canReview, createForm, deleteForm, parseDays, questionsOf, review, submitAnswers, updateForm, updateSettings,
} from '../services/applications/service.js';
import { loggingFor, postSubmissionLog, recordDecisionInLog, tellApplicant } from '../services/applications/notify.js';
import {
    deleteModal, formPayload, logChannelModal, managersModal, newFormModal, overviewPayload, questionsModal, refusalMessage,
    renameModal, retentionModal, reviewPayload, shown, storageFailureMessage, submittedEmbed, verdictEmbed, verdictModal,
} from '../services/applications/view.js';

const PRIVATE = MessageFlags.Ephemeral;

/** The sentence for an error this feature knows; null for anything else. */
function knownMessage(error, where, interaction) {
    const refusal = error?.code === 'APP_REFUSED' ? error.refusal : refusalMessage(error);
    if (refusal) return { message: refusal, type: error.code === 'APP_FORBIDDEN' ? ErrorTypes.PERMISSION : ErrorTypes.VALIDATION };
    const storage = storageFailureMessage(error);
    if (!storage) return null;
    logger.error(`Applications ${where} storage failure (${error.code}): ${error.cause?.message ?? error.message}`, { guildId: interaction.guildId, userId: interaction.user?.id });
    return { message: storage, type: ErrorTypes.DATABASE };
}

/** Answer a known refusal or storage failure privately; pass anything else on to the general handler. */
export async function refuse(interaction, error, where) {
    const known = knownMessage(error, where, interaction);
    if (!known) throw error;
    return replyUserError(interaction, known);
}

/** A refusal decided here rather than by the service. */
const refused = (refusal) => Object.assign(new Error('refused'), { code: 'APP_REFUSED', refusal });
const forbidden = (interaction) => replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: refusalMessage({ code: 'APP_FORBIDDEN' }) });
const gone = (interaction) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'This button or form is no longer valid. Open the dashboard again with `/app-admin dashboard`.' });

/* ------------------------------------------------------------------ dashboard */

/** What the dashboard shows for `scope` (a role id, or `global`), as the data stands now. */
export async function dashboardPayload(client, guild, scope, notice = null) {
    const state = await readAll(client, guild.id);
    const form = scope === 'global' ? null : state.forms.find((entry) => entry.roleId === scope);
    const logging = await loggingFor(client, guild.id, state.settings, form);
    if (!form) return overviewPayload(guild, state, logging, notice);
    return formPayload(guild, form, {
        questions: questionsOf(form, state.settings),
        ownQuestions: form.questions.length > 0,
        pending: state.applications.filter((application) => application.roleId === form.roleId && application.status === 'pending').length,
    }, logging, notice);
}

/** Draw the dashboard into the (already acknowledged) interaction. A failed read is said, not drawn as an empty dashboard. */
export async function showDashboard(interaction, client, scope, notice = null) {
    let payload;
    try {
        payload = await dashboardPayload(client, interaction.guild, scope, notice);
    } catch (error) {
        const known = knownMessage(error, 'dashboard', interaction);
        if (!known) throw error;
        payload = { embeds: [createEmbed({ title: 'Applications Dashboard', description: `${notice ? `${notice}\n\n` : ''}${known.message}`, color: 'error' })], components: [] };
    }
    await interaction.editReply(payload);
}

/** Acknowledge a component or a form: redraw the message it belongs to, or answer privately when it has none. */
async function acknowledge(interaction) {
    if (interaction.deferred || interaction.replied) return;
    if (interaction.isModalSubmit?.() && !interaction.isFromMessage?.()) await interaction.deferReply({ flags: PRIVATE });
    else await interaction.deferUpdate();
}

/**
 * Run a change and show the dashboard afterwards. `work()` returns `{ notice, scope }` (scope
 * optional: which view to show). A refusal or a storage failure becomes the notice; the dashboard
 * then shows what is really stored.
 */
async function dashboardAction(interaction, client, scope, where, work) {
    if (!canConfigure(interaction.guild, interaction.member)) return forbidden(interaction);
    await acknowledge(interaction);
    let notice;
    let next = scope;
    try {
        const done = await work();
        notice = `**Saved.** ${done.notice}`;
        next = done.scope ?? scope;
    } catch (error) {
        const known = knownMessage(error, where, interaction);
        if (!known) throw error;
        notice = `**Not saved.** ${known.message}`;
    }
    await showDashboard(interaction, client, next, notice);
}

/** May the bot post log entries in this channel? Returns the missing permission names. */
function missingLogPermissions(guild, channel) {
    const permissions = channel.permissionsFor?.(guild.members.me);
    const needed = [['View Channel', PermissionFlagsBits.ViewChannel], ['Send Messages', PermissionFlagsBits.SendMessages], ['Embed Links', PermissionFlagsBits.EmbedLinks]];
    return needed.filter(([, bit]) => !permissions?.has?.(bit)).map(([name]) => name);
}

const fieldText = (interaction, id) => {
    try {
        return interaction.fields.getTextInputValue(id) ?? '';
    } catch {
        return '';
    }
};
const pickedIds = (interaction, id) => {
    try {
        return [...(interaction.fields.getField(id)?.values ?? [])].filter(isSnowflake);
    } catch {
        return [];
    }
};

/* ------------------------------------------------------------------ buttons */

async function openReview(interaction, client, id) {
    await interaction.deferReply({ flags: PRIVATE });
    try {
        const { settings, applications } = await readAll(client, interaction.guild.id);
        if (!canReview(interaction.guild, interaction.member, settings)) return await forbidden(interaction);
        const application = isApplicationId(id) ? applications.find((entry) => entry.id === id) : null;
        if (!application) return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: refusalMessage({ code: 'APP_NOT_FOUND' }) });
        await interaction.editReply(reviewPayload(application));
    } catch (error) {
        await refuse(interaction, error, 'review');
    }
}

async function askVerdict(interaction, client, action, id) {
    if (action !== 'approve' && action !== 'deny') return gone(interaction);
    try {
        const { settings, applications } = await readAll(client, interaction.guild.id);
        if (!canReview(interaction.guild, interaction.member, settings)) return await forbidden(interaction);
        const application = isApplicationId(id) ? applications.find((entry) => entry.id === id) : null;
        if (!application) return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: refusalMessage({ code: 'APP_NOT_FOUND' }) });
        if (application.status !== 'pending') return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: refusalMessage({ code: 'APP_REVIEWED', application }) });
        if (application.userId === interaction.user.id) return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: refusalMessage({ code: 'APP_SELF_REVIEW' }) });
    } catch (error) {
        return refuse(interaction, error, 'review');
    }
    await interaction.showModal(verdictModal(action, id));
}

async function askDelete(interaction, client, roleId) {
    if (!canConfigure(interaction.guild, interaction.member)) return forbidden(interaction);
    let form;
    let count;
    try {
        const state = await readAll(client, interaction.guild.id);
        form = state.forms.find((entry) => entry.roleId === roleId);
        count = state.applications.filter((application) => application.roleId === roleId).length;
    } catch (error) {
        return refuse(interaction, error, 'delete');
    }
    if (!form) return gone(interaction);
    await interaction.showModal(deleteModal(form, count));
}

export const applicationButton = {
    name: 'app',
    async execute(interaction, client, args) {
        if (!interaction.inGuild?.() || !interaction.guild) return gone(interaction);
        const [action, first, second] = args;
        const state = (value) => (value === 'on' ? true : value === 'off' ? false : null);
        switch (action) {
            case 'open': return openReview(interaction, client, first);
            case 'decide': return askVerdict(interaction, client, first, second);
            case 'delete': return askDelete(interaction, client, first);
            case 'new':
                if (!canConfigure(interaction.guild, interaction.member)) return forbidden(interaction);
                return interaction.showModal(newFormModal());
            case 'home':
                if (!canConfigure(interaction.guild, interaction.member)) return forbidden(interaction);
                await acknowledge(interaction);
                return showDashboard(interaction, client, 'global');
            case 'switch': {
                const enabled = state(first);
                if (enabled === null) return gone(interaction);
                return dashboardAction(interaction, client, 'global', 'switch', async () => {
                    await updateSettings(client, interaction.guild, interaction.member, { enabled });
                    return { notice: enabled ? 'Applications are now enabled.' : 'Applications are now disabled; members cannot apply.' };
                });
            }
            case 'toggle': {
                const enabled = state(second);
                if (!isSnowflake(first) || enabled === null) return gone(interaction);
                return dashboardAction(interaction, client, first, 'toggle', async () => {
                    const { result } = await updateForm(client, interaction.guild, interaction.member, first, { enabled });
                    return { notice: `**${shown(result.name, 80)}** is now ${enabled ? 'open' : 'closed'}.` };
                });
            }
            default: return gone(interaction);
        }
    },
};

/* ------------------------------------------------------------------ select menus */

export const applicationSelect = {
    name: 'app',
    async execute(interaction, client, args) {
        if (!interaction.inGuild?.() || !interaction.guild) return gone(interaction);
        if (!canConfigure(interaction.guild, interaction.member)) return forbidden(interaction);
        const [action, scope] = args;
        const choice = interaction.values?.[0];
        if (action === 'pick') {
            if (!isSnowflake(choice)) return gone(interaction);
            await acknowledge(interaction);
            return showDashboard(interaction, client, choice);
        }
        if (action !== 'cfg' || (scope !== 'global' && !isSnowflake(scope))) return gone(interaction);

        let modal = null;
        try {
            const { settings, forms } = await readConfig(client, interaction.guild.id);
            const form = scope === 'global' ? null : forms.find((entry) => entry.roleId === scope);
            if (scope !== 'global' && !form) return await gone(interaction);
            if (choice === 'log') {
                const logging = await loggingFor(client, interaction.guild.id, settings, null);
                modal = logChannelModal(scope, form ? form.logChannelId : logging.channelId);
            } else if (choice === 'managers' && !form) modal = managersModal(settings.managerRoles.filter((id) => interaction.guild.roles.cache.has(id)));
            else if (choice === 'retention' && !form) modal = retentionModal(settings);
            else if (choice === 'questions' && form) modal = questionsModal(form.roleId, questionsOf(form, settings));
            else if (choice === 'rename' && form) modal = renameModal(form);
        } catch (error) {
            return refuse(interaction, error, 'settings');
        }
        if (!modal) return gone(interaction);
        await interaction.showModal(modal);
    },
};

/* ------------------------------------------------------------------ forms */

async function submitted(interaction, client, roleId, mark) {
    await interaction.deferReply({ flags: PRIVATE });
    let done;
    try {
        done = await submitAnswers(client, interaction.guild, interaction.member, roleId, mark, (index) => fieldText(interaction, `q${index}`));
    } catch (error) {
        return refuse(interaction, error, 'submit');
    }
    await interaction.editReply({ embeds: [submittedEmbed(done.application)] });
    // Stored and confirmed to the member; the log entry is extra.
    const { settings } = await readConfig(client, interaction.guild.id).catch(() => ({ settings: null }));
    if (settings) await postSubmissionLog(client, interaction.guild, done.application, done.form, settings);
}

async function verdict(interaction, client, action, id) {
    await acknowledge(interaction);
    const reason = fieldText(interaction, 'review_reason').replace(/\s+/g, ' ').trim().slice(0, LIMITS.reason);
    let outcome;
    try {
        outcome = await review(client, interaction.guild, interaction.member, id, action, reason);
    } catch (error) {
        const known = knownMessage(error, 'review', interaction);
        if (!known) throw error;
        // The review message stays as it is: after most refusals the application can still be decided.
        return interaction.followUp({ embeds: [createEmbed({ title: 'Not reviewed', description: known.message, color: 'error' })], flags: PRIVATE });
    }
    const dmSent = await tellApplicant(client, interaction.guild, outcome);
    await interaction.editReply({ embeds: [verdictEmbed(outcome, { dmSent })], components: [] });
    const state = await readConfig(client, interaction.guild.id).catch(() => null);
    if (state) await recordDecisionInLog(client, interaction.guild, outcome, state.settings, state.forms.find((form) => form.roleId === outcome.application.roleId) ?? null);
}

async function saveLogChannel(interaction, client, scope) {
    const guild = interaction.guild;
    const channelId = pickedIds(interaction, 'log_channel')[0] ?? null;
    if (channelId) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) return { notice: null, refusal: 'Log entries can only go to a text channel of this server.' };
        const missing = missingLogPermissions(guild, channel);
        if (missing.length) return { notice: null, refusal: `I cannot post in <#${channelId}>. Missing there: ${missing.join(', ')}.` };
    }
    if (scope !== 'global') {
        await updateForm(client, guild, interaction.member, scope, { logChannelId: channelId });
        return { notice: channelId ? `This application is now logged in <#${channelId}>.` : 'This application now uses the server-wide log channel.' };
    }
    const before = await loggingFor(client, guild.id, { logChannelId: null });
    // The older place this setting was kept in is written first; the logging settings decide.
    await updateSettings(client, guild, interaction.member, { logChannelId: channelId });
    if (!await setLogChannel(client, guild.id, 'applications', channelId)) return { notice: null, refusal: 'The logging settings could not be saved. The channel shown below is the one in effect.' };
    if (!channelId) return { notice: 'The server-wide log channel was cleared.' };
    // Choosing a log channel switches logging on, here as in `/logging`. Say so: other log types start being posted too.
    const switchedOn = before.enabled ? '' : ' Logging was switched off for this server and is now **on**; every log type that has a channel is posted again.';
    return { notice: `New applications are now posted in <#${channelId}>.${switchedOn}` };
}

export const applicationModal = {
    name: 'app',
    async execute(interaction, client, args) {
        if (!interaction.inGuild?.() || !interaction.guild) return gone(interaction);
        const [action, first, second] = args;
        const { guild, member } = interaction;
        switch (action) {
            case 'apply':
                if (!isSnowflake(first)) return gone(interaction);
                return submitted(interaction, client, first, second ?? '');
            case 'verdict':
                if (first !== 'approve' && first !== 'deny') return gone(interaction);
                return verdict(interaction, client, first, second);
            case 'new':
                return dashboardAction(interaction, client, 'global', 'setup', async () => {
                    const roleId = pickedIds(interaction, 'role_id')[0];
                    const { result, settings } = await createForm(client, guild, member, {
                        role: roleId ? guild.roles.cache.get(roleId) ?? null : null,
                        name: fieldText(interaction, 'app_name'),
                        questions: [1, 2, 3].map((n) => fieldText(interaction, `app_question_${n}`)),
                    });
                    const off = settings.enabled ? '' : ' Applications are disabled for this server, so members cannot apply yet.';
                    return { notice: `Application **${shown(result.name, 80)}** was created for <@&${result.roleId}>.${off}`, scope: result.roleId };
                });
            case 'questions':
                if (!isSnowflake(first)) return gone(interaction);
                return dashboardAction(interaction, client, first, 'questions', async () => {
                    const { result } = await updateForm(client, guild, member, first, { questions: [1, 2, 3, 4, 5].map((n) => fieldText(interaction, `q${n}`)) });
                    return { notice: `${result.questions.length} question(s) saved.` };
                });
            case 'rename':
                if (!isSnowflake(first)) return gone(interaction);
                return dashboardAction(interaction, client, first, 'rename', async () => {
                    const { result } = await updateForm(client, guild, member, first, { name: fieldText(interaction, 'app_name') });
                    return { notice: `The application is now called **${shown(result.name, 80)}**.` };
                });
            case 'log':
                if (first !== 'global' && !isSnowflake(first)) return gone(interaction);
                return dashboardAction(interaction, client, first, 'log channel', async () => {
                    const saved = await saveLogChannel(interaction, client, first);
                    if (saved.refusal) throw refused(saved.refusal);
                    return saved;
                });
            case 'managers':
                return dashboardAction(interaction, client, 'global', 'manager roles', async () => {
                    const { settings } = await updateSettings(client, guild, member, { managerRoles: pickedIds(interaction, 'manager_roles') });
                    return { notice: settings.managerRoles.length ? `Manager roles: ${settings.managerRoles.map((id) => `<@&${id}>`).join(', ')}.` : 'No manager roles are set.' };
                });
            case 'retention':
                return dashboardAction(interaction, client, 'global', 'retention', async () => {
                    const pendingDays = parseDays(fieldText(interaction, 'pending_days'));
                    const reviewedDays = parseDays(fieldText(interaction, 'reviewed_days'));
                    const { settings } = await updateSettings(client, guild, member, { pendingDays, reviewedDays });
                    return { notice: `Pending applications are kept for **${settings.pendingDays} days**, reviewed ones for **${settings.reviewedDays} days**.` };
                });
            case 'delete':
                if (!isSnowflake(first)) return gone(interaction);
                return dashboardAction(interaction, client, first, 'delete', async () => {
                    let confirmed = false;
                    try {
                        confirmed = interaction.fields.getCheckbox('confirm_delete') === true;
                    } catch {
                        confirmed = false;
                    }
                    if (!confirmed) throw refused('The confirmation box was not ticked.');
                    const { result, removedApplications } = await deleteForm(client, guild, member, first);
                    return { notice: `Application **${shown(result.name, 80)}** was deleted, together with ${removedApplications} submitted application(s).`, scope: 'global' };
                });
            default: return gone(interaction);
        }
    },
};
