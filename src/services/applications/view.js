// view.js — how role applications look in Discord, and the sentences for refused requests.
//
// Component ids are `app:<action>[:<argument>...]`. They carry everything a handler needs, so a
// button keeps working after the bot restarts and no collector has to be alive for it.

import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, CheckboxBuilder, LabelBuilder,
    ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { plainText } from '../searchLookup.js';
import { LIMITS } from './store.js';
import { checkGrantable, cooldownMs, roleReason } from './service.js';

const seconds = (ms) => Math.floor(ms / 1000);
/** Text a member or an admin typed, as ordinary text: it cannot format itself or hide a link. (Inside an embed a mention notifies nobody.) */
export const shown = (text, limit = 200) => plainText(String(text ?? ''), limit) || '(empty)';

const STATUS = {
    pending: { label: 'In Progress', color: 'warning' },
    approved: { label: 'Accepted', color: 'success' },
    denied: { label: 'Denied', color: 'error' },
};
export const statusOf = (application) => STATUS[application.status] ?? STATUS.pending;
/** "Accepted", or "Accepted (role not given)" while an approval's role is still missing. */
export function statusLabel(application) {
    const base = statusOf(application).label;
    return application.status === 'approved' && application.roleGranted === false ? `${base} (role not given)` : base;
}

/* ------------------------------------------------------------------ refusals */

/** The sentence for a refusal thrown by the service or the store; null when the error is not one. */
export function refusalMessage(error) {
    switch (error?.code) {
        case 'APP_DISABLED': return 'Applications are currently disabled in this server.';
        case 'APP_FORM_MISSING': return 'That application does not exist. Use `/apply list` to see the available applications.';
        case 'APP_FORM_DISABLED': return 'That application is currently closed.';
        case 'APP_ROLE_MISSING': return 'The role for this application no longer exists. Please tell the server staff.';
        case 'APP_HAS_ROLE': return 'You already have the role this application is for.';
        case 'APP_PENDING': return `You already have a pending application (\`${error.application.id}\`). Please wait for it to be reviewed.`;
        case 'APP_COOLDOWN': return `You applied recently. You can submit another application <t:${seconds(error.retryAt)}:R>.`;
        case 'APP_QUESTIONS_CHANGED': return 'The questions of this application were changed while you were filling it in. Nothing was submitted; please run `/apply submit` again.';
        case 'APP_ANSWER_EMPTY': return 'Every question needs an answer.';
        case 'APP_FORBIDDEN': return 'You do not have permission to manage applications.';
        case 'APP_NOT_FOUND': return 'Application not found.';
        case 'APP_REVIEWED': return `This application was already ${error.application.status}${error.application.reviewer ? ` by <@${error.application.reviewer}>` : ''}.`;
        case 'APP_SELF_REVIEW': return 'You cannot review your own application.';
        case 'APP_ROLE_BLOCKED': return `${roleReason(error.reason)} Nothing was changed.`;
        case 'APP_APPLICANT_GONE': return 'The applicant is no longer in this server, so the role cannot be given. The application is still pending; you can deny it.';
        case 'APP_DISCORD': return 'Discord could not be asked whether the applicant is still in this server. Nothing was changed; please try again.';
        case 'APP_FORM_EXISTS': return 'That role already has an application.';
        case 'APP_FORM_LIMIT': return `A server can have at most ${LIMITS.forms} applications.`;
        case 'APP_NAME_EMPTY': return 'The application needs a name.';
        case 'APP_NAME_TAKEN': return 'Another application already has that name.';
        case 'APP_QUESTIONS_EMPTY': return 'An application needs at least one question.';
        case 'APP_MANAGER_ROLE': return 'A manager role must be a role of this server other than @everyone.';
        case 'APP_MANAGER_LIMIT': return `At most ${LIMITS.managerRoles} manager roles can be set.`;
        case 'APP_RETENTION': return `Retention must be a whole number of days between ${LIMITS.retentionMin} and ${LIMITS.retentionMax}.`;
        case 'APP_STALE': return 'The application settings were changed by someone else meanwhile. Nothing was saved; please look at the current settings and try again.';
        default: return null;
    }
}

/** The sentence for a storage failure; null when the error is not one. */
export function storageFailureMessage(error) {
    if (error?.code === 'APP_UNCERTAIN') return 'The database did not confirm the change. It may or may not have been saved; please check before trying again.';
    if (error?.code === 'APP_UNAVAILABLE' || error?.code === 'APP_INVALID') return 'The applications data could not be read or saved right now. Nothing was changed; please try again later.';
    return null;
}

/* ------------------------------------------------------------------ members */

export function listEmbed(guild, forms) {
    const lines = forms.map((form, index) => `**${index + 1}. ${shown(form.name, 80)}** · <@&${form.roleId}>\nApply with \`/apply submit\` and choose **${shown(form.name, 80)}**.`);
    return createEmbed({ title: 'Available Applications', description: `Here are the roles you can apply for:\n\n${lines.join('\n\n')}`.slice(0, 4000) });
}

export function applyModal(form, questions, mark) {
    const modal = new ModalBuilder().setCustomId(`app:apply:${form.roleId}:${mark}`).setTitle(`Application for ${form.name}`.slice(0, 45));
    questions.forEach((question, index) => {
        const input = new TextInputBuilder()
            .setCustomId(`q${index}`)
            .setLabel(question.length > 45 ? `${question.slice(0, 42)}...` : question)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(LIMITS.answer);
        // A label holds 45 characters; a longer question is shown whole inside the field.
        if (question.length > 45) input.setPlaceholder(question.slice(0, 100));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    });
    return modal;
}

export function submittedEmbed(application) {
    const wait = cooldownMs();
    const next = wait > 0 ? `\nYou can apply again <t:${seconds(application.createdAt + wait)}:R>, once this application has been reviewed.` : '';
    return createEmbed({
        title: 'Application Submitted',
        description: `Your application for **${shown(application.roleName, 80)}** has been stored.\n\nApplication ID: \`${application.id}\`\nCheck it with \`/apply status\`.${next}`,
        color: 'success',
    });
}

function reviewLine(application) {
    if (application.status === 'pending') return '';
    const note = application.reviewMessage ? `\n**Note:** ${shown(application.reviewMessage, 500)}` : '';
    return `\n**Reviewed:** <t:${seconds(application.reviewedAt)}:f>${note}`;
}

export function statusEmbed(application) {
    return createEmbed({
        title: `Application - ${shown(application.roleName, 80)}`,
        description: `**Application ID:** \`${application.id}\`\n**Status:** ${statusLabel(application)}\n**Submitted:** <t:${seconds(application.createdAt)}:f>${reviewLine(application)}`,
        color: statusOf(application).color,
    });
}

export function ownListEmbed(applications) {
    const recent = applications.slice(0, 10);
    const embed = createEmbed({ title: 'Your Applications', description: `Showing ${recent.length} of ${applications.length} application(s), newest first.` });
    for (const application of recent) {
        embed.addFields({
            name: `${shown(application.roleName, 80)} (${statusLabel(application)})`,
            value: `**ID:** \`${application.id}\`\n**Submitted:** <t:${seconds(application.createdAt)}:d>`,
            inline: true,
        });
    }
    return embed;
}

/* ------------------------------------------------------------------ review */

/** An answer for an embed field. Answers stored by older versions already had their markdown escaped. */
function shownAnswer(application, entry) {
    const text = application.rawText ? plainText(entry.answer, 1000) : entry.answer.slice(0, 1000);
    return text || '*No answer provided*';
}

export function reviewPayload(application) {
    const embed = createEmbed({
        title: 'Review Application',
        description: `**User:** <@${application.userId}>\n**Application:** ${shown(application.roleName, 80)} (<@&${application.roleId}>)\n**Application ID:** \`${application.id}\`\n`
            + `**Status:** ${statusLabel(application)}${application.reviewer ? ` · by <@${application.reviewer}>` : ''}\n**Submitted:** <t:${seconds(application.createdAt)}:f>${reviewLine(application)}`,
        color: application.status === 'pending' ? 'info' : statusOf(application).color,
    });
    application.answers.slice(0, LIMITS.questions).forEach((entry, index) => {
        const question = application.rawText ? shown(entry.question, 200) : entry.question.slice(0, 200);
        embed.addFields({ name: `Q${index + 1}: ${question}`.slice(0, 256), value: shownAnswer(application, entry), inline: false });
    });
    const components = application.status === 'pending'
        ? [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`app:decide:approve:${application.id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`app:decide:deny:${application.id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
        )]
        : [];
    return { embeds: [embed], components };
}

export function verdictModal(action, id) {
    const modal = new ModalBuilder().setCustomId(`app:verdict:${action}:${id}`).setTitle(`${action === 'approve' ? 'Approve' : 'Deny'} Application - Reason`);
    modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('review_reason').setLabel('Reason (optional)').setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Shown to the applicant.').setMaxLength(LIMITS.reason).setRequired(false),
    ));
    return modal;
}

/** What the reviewer is told after a decision was stored. */
export function verdictEmbed(outcome, { dmSent }) {
    const { application } = outcome;
    const who = `<@${application.userId}>`;
    const dm = dmSent ? `${who} was told by direct message.` : `${who} could **not** be told by direct message (direct messages closed or the user is unreachable).`;
    if (application.status === 'denied') {
        return createEmbed({ title: 'Application denied', description: `The application of ${who} for **${shown(application.roleName, 80)}** has been **denied**.\n${dm}`, color: 'success' });
    }
    if (outcome.role === 'given') {
        return createEmbed({ title: 'Application approved', description: `The application of ${who} has been **approved** and <@&${application.roleId}> was given.\n${dm}`, color: 'success' });
    }
    const why = outcome.roleError?.code === 50013 ? 'Discord refused: I lack the permission or the role is above mine.' : 'Discord did not accept the request.';
    return createEmbed({
        title: 'Approved, but the role was not given',
        description: `The approval of ${who} is stored, but <@&${application.roleId}> could **not** be given. ${why}\nPlease give the role by hand.\n${dm}`,
        color: 'warning',
    });
}

export function applicantDm(guild, outcome) {
    const { application } = outcome;
    const approved = application.status === 'approved';
    const role = approved
        ? (outcome.role === 'given' ? '\nYou have been given the role.' : '\nThe role could not be given automatically; the staff has been told to give it to you.')
        : '';
    const note = application.reviewMessage ? `\n**Note:** ${shown(application.reviewMessage, 500)}` : '';
    return createEmbed({
        title: `Application ${statusOf(application).label}`,
        description: `Your application for **${shown(application.roleName, 80)}** in **${shown(guild.name, 100)}** has been **${application.status}**.${role}${note}`,
        color: statusOf(application).color,
    });
}

export function adminListEmbed(applications, { total, filters }) {
    const embed = createEmbed({
        title: 'Submitted Applications',
        description: `Showing ${applications.length} of ${total} application(s)${filters.length ? ` (${filters.join(', ')})` : ''}, newest first.\nOpen one with \`/app-admin review\`.`,
    });
    for (const application of applications) {
        embed.addFields({
            name: `${shown(application.roleName, 80)} (${statusLabel(application)})`.slice(0, 256),
            value: `**ID:** \`${application.id}\`\n**User:** <@${application.userId}>\n**Submitted:** <t:${seconds(application.createdAt)}:f>`,
            inline: true,
        });
    }
    return embed;
}

/** The button under a log entry that opens the application for whoever may review. */
export const logEntryButtons = (id) => [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`app:open:${id}`).setLabel('Review').setStyle(ButtonStyle.Primary),
)];

/* ------------------------------------------------------------------ dashboard */

function logChannelText(channelId, logging) {
    if (!channelId) return '`Not set` (new applications are not posted anywhere)';
    if (!logging.enabled) return `<#${channelId}>\nLogging is switched off for this server, so nothing is posted. Switch it on with \`/logging dashboard\`.`;
    if (!logging.applicationEvents) return `<#${channelId}>\nApplication events are switched off in the logging settings, so nothing is posted.`;
    return `<#${channelId}>`;
}

const questionList = (questions) => questions.map((question, index) => `${index + 1}. ${shown(question, 110)}`).join('\n');

/**
 * The overview: server-wide settings and the list of forms.
 * `logging` is `{ enabled, applicationEvents, channelId }` as the logging settings stand.
 */
export function overviewPayload(guild, { settings, forms }, logging, notice = null) {
    const formLines = forms.map((form, index) => {
        const problem = checkGrantable(guild, guild.roles.cache.get(form.roleId));
        return `${index + 1}. **${shown(form.name, 60)}** · <@&${form.roleId}> · ${form.enabled ? 'open' : 'closed'}${problem.ok ? '' : ' · role cannot be given'}`;
    });
    const embed = createEmbed({
        title: 'Applications Dashboard',
        description: `${notice ? `${notice}\n\n` : ''}Settings for every application of this server. Choose an application below to change its questions or log channel.`,
        color: settings.enabled ? 'success' : 'warning',
        fields: [
            { name: 'Applications', value: settings.enabled ? '**Enabled**' : '**Disabled** (members cannot apply)', inline: true },
            { name: 'Retention', value: `Pending: **${settings.pendingDays}d** · Reviewed: **${settings.reviewedDays}d**`, inline: true },
            { name: 'Manager Roles', value: settings.managerRoles.length ? settings.managerRoles.map((id) => `<@&${id}>`).join(', ') : '`None` (only members with Manage Server can review)', inline: false },
            { name: 'Log Channel', value: logChannelText(logging.channelId, logging), inline: false },
            { name: `Applications (${forms.length}/${LIMITS.forms})`, value: (formLines.join('\n') || 'None yet. Use **Add Application**.').slice(0, 1024), inline: false },
        ],
    });
    const rows = [];
    if (forms.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('app:pick').setPlaceholder('Open an application...')
                .addOptions(forms.map((form) => ({ label: form.name.slice(0, 100), value: form.roleId, description: form.enabled ? 'Open' : 'Closed' }))),
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('app:cfg:global').setPlaceholder('Change a server-wide setting...').addOptions(
            { label: 'Log Channel', value: 'log', description: 'Where new applications are posted' },
            { label: 'Manager Roles', value: 'managers', description: 'Roles that may review applications' },
            { label: 'Retention Period', value: 'retention', description: 'How long applications are kept' },
        ),
    ));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`app:switch:${settings.enabled ? 'off' : 'on'}`).setLabel(settings.enabled ? 'Disable Applications' : 'Enable Applications').setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('app:new').setLabel('Add Application').setStyle(ButtonStyle.Primary).setDisabled(forms.length >= LIMITS.forms),
    ));
    return { embeds: [embed], components: rows };
}

/** One form. `questions` are the ones it really asks; `ownQuestions` says whether they are its own. */
export function formPayload(guild, form, { questions, ownQuestions, pending }, logging, notice = null) {
    const problem = checkGrantable(guild, guild.roles.cache.get(form.roleId));
    const fields = [
        { name: 'Role', value: `<@&${form.roleId}>`, inline: true },
        { name: 'Application Status', value: form.enabled ? '**Open**' : '**Closed**', inline: true },
        { name: 'Pending', value: String(pending), inline: true },
        { name: ownQuestions ? 'Questions' : 'Questions (defaults)', value: questionList(questions).slice(0, 1024) || 'None', inline: false },
        { name: form.logChannelId ? 'Log Channel (this application)' : 'Log Channel (server-wide)', value: logChannelText(logging.channelId, logging), inline: false },
    ];
    if (!problem.ok) fields.push({ name: 'Approvals will be refused', value: roleReason(problem.code), inline: false });
    const embed = createEmbed({
        title: 'Application Dashboard',
        description: `${notice ? `${notice}\n\n` : ''}Configuration for **${shown(form.name, 80)}**`,
        color: problem.ok ? (form.enabled ? 'success' : 'warning') : 'error',
        fields,
    });
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId(`app:cfg:${form.roleId}`).setPlaceholder('Change this application...').addOptions(
                    { label: 'Edit Questions', value: 'questions', description: 'The questions members answer' },
                    { label: 'Log Channel', value: 'log', description: 'A separate log channel for this application' },
                    { label: 'Rename', value: 'rename', description: 'The name members choose in /apply submit' },
                ),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`app:toggle:${form.roleId}:${form.enabled ? 'off' : 'on'}`).setLabel(form.enabled ? 'Close Application' : 'Open Application').setStyle(form.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`app:delete:${form.roleId}`).setLabel('Delete Application').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('app:home').setLabel('All Applications').setStyle(ButtonStyle.Secondary),
            ),
        ],
    };
}

/* ------------------------------------------------------------------ dashboard forms */

const questionInput = (index, value, required) => {
    const input = new TextInputBuilder().setCustomId(`q${index + 1}`).setLabel(`Question ${index + 1} (${required ? 'required' : 'optional'})`)
        .setStyle(TextInputStyle.Short).setMaxLength(LIMITS.question).setRequired(required);
    if (value) input.setValue(value);
    return new ActionRowBuilder().addComponents(input);
};

export function questionsModal(roleId, questions) {
    const modal = new ModalBuilder().setCustomId(`app:questions:${roleId}`).setTitle('Edit Application Questions');
    for (let index = 0; index < LIMITS.questions; index++) modal.addComponents(questionInput(index, questions[index], index === 0));
    return modal;
}

export function newFormModal() {
    const role = new LabelBuilder().setLabel('Application Role').setDescription('The role members apply for and receive when approved')
        .setRoleSelectMenuComponent(new RoleSelectMenuBuilder().setCustomId('role_id').setPlaceholder('Select the role users will apply for').setRequired(true));
    const text = (id, label, placeholder, required, max) => {
        const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(required);
        if (placeholder) input.setPlaceholder(placeholder);
        return new LabelBuilder().setLabel(label).setTextInputComponent(input);
    };
    return new ModalBuilder().setCustomId('app:new').setTitle('Set Up New Application').addLabelComponents(
        role,
        text('app_name', 'Application Name', 'e.g., Moderator, Helper, Developer', true, LIMITS.formName),
        text('app_question_1', 'Question 1 (required)', 'Why do you want this role?', true, LIMITS.question),
        text('app_question_2', 'Question 2 (optional)', 'What experience do you have?', false, LIMITS.question),
        text('app_question_3', 'Question 3 (optional)', null, false, LIMITS.question),
    );
}

export function renameModal(form) {
    return new ModalBuilder().setCustomId(`app:rename:${form.roleId}`).setTitle('Rename Application').addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('app_name').setLabel('Application Name').setStyle(TextInputStyle.Short).setMaxLength(LIMITS.formName).setRequired(true).setValue(form.name),
    ));
}

/** `scope` is a role id or `global`. Leaving the picker empty clears the channel. */
export function logChannelModal(scope, currentChannelId) {
    const select = new ChannelSelectMenuBuilder().setCustomId('log_channel').setPlaceholder('Select a text channel...')
        .setMinValues(0).setMaxValues(1).addChannelTypes(ChannelType.GuildText).setRequired(false);
    if (currentChannelId) select.setDefaultChannels(currentChannelId);
    const label = new LabelBuilder().setLabel('Log Channel')
        .setDescription(scope === 'global' ? 'Where new applications are posted. Leave empty to clear.' : 'Only for this application. Leave empty to use the server-wide channel.')
        .setChannelSelectMenuComponent(select);
    return new ModalBuilder().setCustomId(`app:log:${scope}`).setTitle('Configure Log Channel').addLabelComponents(label);
}

/** The selection is the list: what is chosen here replaces the manager roles. */
export function managersModal(current) {
    const select = new RoleSelectMenuBuilder().setCustomId('manager_roles').setPlaceholder('Select the roles that may review...')
        .setMinValues(0).setMaxValues(LIMITS.managerRoles).setRequired(false);
    if (current.length) select.setDefaultRoles(...current);
    const label = new LabelBuilder().setLabel('Manager Roles').setDescription('These roles can read and decide every application. Leave empty for none.')
        .setRoleSelectMenuComponent(select);
    return new ModalBuilder().setCustomId('app:managers').setTitle('Configure Manager Roles').addLabelComponents(label);
}

export function retentionModal(settings) {
    const field = (id, label, value) => new LabelBuilder().setLabel(label).setDescription(`Whole days, ${LIMITS.retentionMin}-${LIMITS.retentionMax}`).setTextInputComponent(
        new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true).setValue(String(value)),
    );
    return new ModalBuilder().setCustomId('app:retention').setTitle('Application Retention Periods').addLabelComponents(
        field('pending_days', 'Pending retention (days)', settings.pendingDays),
        field('reviewed_days', 'Reviewed retention (days)', settings.reviewedDays),
    );
}

export function deleteModal(form, applicationCount) {
    const warning = new TextDisplayBuilder().setContent(
        `This deletes the application **${shown(form.name, 80)}**, its questions and settings, and **${applicationCount}** submitted application(s) made with it. Roles already given are not taken back.`,
    );
    const checkbox = new LabelBuilder().setLabel('I confirm — this cannot be undone').setCheckboxComponent(new CheckboxBuilder().setCustomId('confirm_delete'));
    return new ModalBuilder().setCustomId(`app:delete:${form.roleId}`).setTitle('Confirm Application Deletion').addTextDisplayComponents(warning).addLabelComponents(checkbox);
}
