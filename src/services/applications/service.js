// service.js — the rules of role applications: who may configure and review, which roles
// may be applied for, how an application is submitted and how it is decided.
//
// The database and Discord are not one transaction. The order is fixed:
//   submit   store the application → post the log entry (best effort)
//   approve  check that the role can be given and the applicant is here → store the decision
//            → give the role → record that it was given → tell the applicant → update the log
// The stored decision is the authority. What happened to each later step is returned, so the
// reviewer is told what really happened rather than "approved".

import { createHash } from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import botConfig, { getDefaultApplicationQuestions } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import {
    LIMITS, changeConfig, cleanQuestions, createApplication, decideApplication, fail, isApplicationId, isSnowflake,
    noteApplication, readAll, readConfig,
} from './store.js';

const HOUR = 60 * 60 * 1000;
/** How long a member waits after an application before the next one, in milliseconds. */
export const cooldownMs = () => {
    const hours = Number(botConfig.applications?.applicationCooldown);
    return Number.isFinite(hours) && hours > 0 ? hours * HOUR : 0;
};

function has(holder, name) {
    try {
        return holder?.permissions?.has?.(PermissionFlagsBits[name]) === true;
    } catch {
        return false;
    }
}
const isOwner = (guild, member) => Boolean(guild?.ownerId) && member?.id === guild.ownerId;

/** May this member change application settings and forms? Server owner or Manage Server. */
export const canConfigure = (guild, member) => Boolean(member) && (isOwner(guild, member) || has(member, 'ManageGuild'));

/** May this member read and decide applications? Whoever may configure, and holders of a manager role. */
export function canReview(guild, member, settings) {
    if (!member) return false;
    if (canConfigure(guild, member)) return true;
    return settings.managerRoles.some((roleId) => member.roles?.cache?.has?.(roleId) === true);
}

/**
 * Can the bot give `role` right now? `{ ok: true }` or `{ ok: false, code }`. Never throws.
 * Unlike reward roles, a role with moderation permissions is allowed: applying for staff roles
 * is what this feature is for. Who may offer such a role is decided by `checkFormRole`.
 */
export function checkGrantable(guild, role) {
    if (!role || !isSnowflake(role.id)) return { ok: false, code: 'ROLE_MISSING' };
    if (role.id === guild?.id) return { ok: false, code: 'ROLE_EVERYONE' };
    if (role.managed === true) return { ok: false, code: 'ROLE_MANAGED' };
    const me = guild?.members?.me;
    if (!me || !has(me, 'ManageRoles')) return { ok: false, code: 'BOT_NO_MANAGE_ROLES' };
    const highest = me.roles?.highest;
    if (!highest || !(Number(highest.position) > Number(role.position))) return { ok: false, code: 'ROLE_TOO_HIGH' };
    return { ok: true };
}

/**
 * May `actor` offer `role` through an application form? Approving an application gives the role,
 * so a form must not be a way to hand out a role the actor could not hand out by hand: Discord
 * asks for Manage Roles and a highest role above the role given. The server owner may always.
 */
export function checkFormRole(guild, role, actor) {
    const grantable = checkGrantable(guild, role);
    if (!grantable.ok) return grantable;
    if (isOwner(guild, actor)) return { ok: true };
    if (!has(actor, 'ManageRoles')) return { ok: false, code: 'ACTOR_NO_MANAGE_ROLES' };
    const highest = actor?.roles?.highest;
    if (!highest || !(Number(highest.position) > Number(role.position))) return { ok: false, code: 'ACTOR_TOO_LOW' };
    return { ok: true };
}

const ROLE_REASONS = {
    ROLE_MISSING: 'The role no longer exists.',
    ROLE_EVERYONE: 'The @everyone role cannot be applied for.',
    ROLE_MANAGED: 'The role is managed by an integration and cannot be given to members.',
    BOT_NO_MANAGE_ROLES: 'I do not have the Manage Roles permission.',
    ROLE_TOO_HIGH: 'The role is not below my highest role.',
    ACTOR_NO_MANAGE_ROLES: 'You need the Manage Roles permission to offer a role through an application.',
    ACTOR_TOO_LOW: 'The role is not below your own highest role.',
};
export const roleReason = (code) => ROLE_REASONS[code] ?? 'The role cannot be used.';

/** The questions a form asks: its own, else the server default, else the built-in ones. */
export function questionsOf(form, settings) {
    if (form.questions.length > 0) return form.questions;
    if (settings.questions.length > 0) return settings.questions;
    return cleanQuestions(getDefaultApplicationQuestions());
}

/** A short fingerprint of a set of questions, so answers are never paired with questions that changed meanwhile. */
export const questionsMark = (questions) => createHash('sha256').update(JSON.stringify(questions)).digest('hex').slice(0, 10);

/** An answer as typed: line breaks kept, other control characters and runs of blank lines removed. */
export function cleanAnswer(value) {
    return String(value ?? '')
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, LIMITS.answer);
}

/** A form name or question as one line of at most `limit` characters. */
export const cleanLine = (value, limit) => String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/**
 * What a member needs before the form is shown: the form, its questions and their mark.
 * Throws APP_DISABLED, APP_FORM_MISSING, APP_FORM_DISABLED, APP_ROLE_MISSING, APP_HAS_ROLE,
 * APP_PENDING (with `application`) or APP_COOLDOWN (with `retryAt`).
 */
export async function openForm(client, guild, member, name, now = Date.now()) {
    const { settings, forms, applications } = await readAll(client, guild.id, now);
    if (!settings.enabled) throw fail('Applications are switched off', 'APP_DISABLED');
    const wanted = cleanLine(name, LIMITS.formName);
    const form = forms.find((entry) => sameName(entry.name, wanted));
    if (!form) throw fail('No such application form', 'APP_FORM_MISSING');
    if (!form.enabled) throw fail('Application form is switched off', 'APP_FORM_DISABLED');
    if (!guild.roles.cache.get(form.roleId)) throw fail('Role of the form is gone', 'APP_ROLE_MISSING');
    if (member.roles?.cache?.has?.(form.roleId)) throw fail('Member already has the role', 'APP_HAS_ROLE');
    const own = applications.filter((application) => application.userId === member.id);
    const pending = own.find((application) => application.status === 'pending');
    if (pending) throw fail('Member already has a pending application', 'APP_PENDING', { application: pending });
    const wait = cooldownMs();
    if (own[0] && wait > 0 && now - own[0].createdAt < wait) throw fail('Member applied too recently', 'APP_COOLDOWN', { retryAt: own[0].createdAt + wait });
    const questions = questionsOf(form, settings);
    return { form, questions, mark: questionsMark(questions) };
}

/**
 * Store the answers of a filled-in form. `read(index)` returns what the member typed for question `index`.
 * Throws what `openForm` throws, plus APP_QUESTIONS_CHANGED and APP_ANSWER_EMPTY.
 */
export async function submitAnswers(client, guild, member, roleId, mark, read, now = Date.now()) {
    const { settings, forms } = await readConfig(client, guild.id);
    if (!settings.enabled) throw fail('Applications are switched off', 'APP_DISABLED');
    const form = forms.find((entry) => entry.roleId === roleId);
    if (!form) throw fail('No such application form', 'APP_FORM_MISSING');
    if (!form.enabled) throw fail('Application form is switched off', 'APP_FORM_DISABLED');
    if (!guild.roles.cache.get(form.roleId)) throw fail('Role of the form is gone', 'APP_ROLE_MISSING');
    if (member.roles?.cache?.has?.(form.roleId)) throw fail('Member already has the role', 'APP_HAS_ROLE');
    const questions = questionsOf(form, settings);
    if (questionsMark(questions) !== mark) throw fail('Questions changed while the form was open', 'APP_QUESTIONS_CHANGED');
    const answers = questions.map((question, index) => ({ question, answer: cleanAnswer(read(index)) }));
    if (answers.some((entry) => entry.answer === '')) throw fail('An answer is empty', 'APP_ANSWER_EMPTY');
    const application = await createApplication(client, {
        guildId: guild.id,
        userId: member.id,
        username: member.user?.tag ?? member.user?.username ?? null,
        roleId,
        answers,
        cooldownMs: cooldownMs(),
        now,
    });
    logger.info('Application submitted', { applicationId: application.id, userId: member.id, guildId: guild.id, roleId });
    return { application, form };
}

const UNKNOWN_MEMBER = 10007;

/**
 * Decide an application and carry out what follows from the decision.
 *
 * Refusals (thrown, nothing changed): APP_FORBIDDEN, APP_NOT_FOUND, APP_REVIEWED (with
 * `application`), APP_SELF_REVIEW, and for an approval APP_ROLE_BLOCKED (with `reason`),
 * APP_APPLICANT_GONE, APP_DISCORD (the applicant could not be looked up).
 *
 * Returns `{ application, role: 'given' | 'failed' | null, roleError }`. `role` is null for a denial.
 */
export async function review(client, guild, reviewer, id, action, reason, now = Date.now()) {
    if (!isApplicationId(id)) throw fail('No such application', 'APP_NOT_FOUND');
    const { settings, applications } = await readAll(client, guild.id, now);
    if (!canReview(guild, reviewer, settings)) throw fail('Member may not review applications', 'APP_FORBIDDEN');
    const current = applications.find((entry) => entry.id === id);
    if (!current) throw fail('No such application', 'APP_NOT_FOUND');
    if (current.status !== 'pending') throw fail('Application already reviewed', 'APP_REVIEWED', { application: current });
    if (current.userId === reviewer.id) throw fail('Members cannot review their own application', 'APP_SELF_REVIEW');

    let applicant = null;
    if (action === 'approve') {
        const grantable = checkGrantable(guild, guild.roles.cache.get(current.roleId));
        if (!grantable.ok) throw fail('Role cannot be given', 'APP_ROLE_BLOCKED', { reason: grantable.code });
        try {
            applicant = await guild.members.fetch(current.userId);
        } catch (error) {
            if (error?.code === UNKNOWN_MEMBER) throw fail('Applicant left the server', 'APP_APPLICANT_GONE');
            throw fail('Applicant could not be looked up', 'APP_DISCORD', { cause: error });
        }
    }

    const application = await decideApplication(client, { guildId: guild.id, id, action, reason, reviewerId: reviewer.id, now });
    logger.info('Application reviewed', { applicationId: id, guildId: guild.id, status: application.status, reviewerId: reviewer.id, userId: application.userId });
    if (action !== 'approve') return { application, role: null, roleError: null };

    try {
        await applicant.roles.add(application.roleId, `Application ${id} approved by ${reviewer.id}`);
    } catch (error) {
        logger.error('Approved application: the role could not be given', { applicationId: id, guildId: guild.id, roleId: application.roleId, error: error?.message, code: error?.code });
        return { application, role: 'failed', roleError: error };
    }
    try {
        return { application: (await noteApplication(client, guild.id, id, { roleGranted: true })) ?? { ...application, roleGranted: true }, role: 'given', roleError: null };
    } catch (error) {
        // The role is on the member; only the note that it is could not be stored.
        logger.error('Approved application: could not record that the role was given', { applicationId: id, guildId: guild.id, code: error?.code });
        return { application, role: 'given', roleError: null };
    }
}

/* ------------------------------------------------------------------ configuration */

/** One line in the bot's log per stored configuration change: who, what, and from where (`discord` or `dashboard`). */
function noteChange(guild, actor, change, details, options) {
    logger.info('Application settings changed', { guildId: guild.id, actorId: actor.id, source: options.source ?? 'discord', change, ...details });
}

/** Throws APP_FORBIDDEN unless `actor` may configure applications. */
function mustConfigure(guild, actor) {
    if (!canConfigure(guild, actor)) throw fail('Member may not configure applications', 'APP_FORBIDDEN');
}

function questionsFrom(input) {
    const questions = cleanQuestions((Array.isArray(input) ? input : []).map((entry) => cleanLine(entry, LIMITS.question)));
    if (questions.length === 0) throw fail('At least one question is needed', 'APP_QUESTIONS_EMPTY');
    return questions;
}

function nameFrom(input, forms, exceptRoleId = null) {
    const name = cleanLine(input, LIMITS.formName);
    if (!name) throw fail('A form needs a name', 'APP_NAME_EMPTY');
    // `/apply submit` finds a form by its name; two forms with one name would make the second unreachable.
    if (forms.some((form) => form.roleId !== exceptRoleId && sameName(form.name, name))) throw fail('Form name already in use', 'APP_NAME_TAKEN');
    return name;
}

/**
 * Create a form for `role`. The first form of a server also switches applications on.
 * Throws APP_FORBIDDEN, APP_ROLE_BLOCKED (with `reason`), APP_FORM_EXISTS, APP_FORM_LIMIT,
 * APP_NAME_EMPTY, APP_NAME_TAKEN, APP_QUESTIONS_EMPTY, APP_STALE.
 * `options`: `revision` (the revision the caller last saw; a different stored one is APP_STALE) and
 * `source` (`dashboard` for the web; default `discord`). The same for the three functions below.
 */
export async function createForm(client, guild, actor, { role, name, questions }, options = {}) {
    mustConfigure(guild, actor);
    const allowed = checkFormRole(guild, role, actor);
    if (!allowed.ok) throw fail('Role cannot be offered', 'APP_ROLE_BLOCKED', { reason: allowed.code });
    const asked = questionsFrom(questions);
    const done = await changeConfig(client, guild.id, (draft) => {
        if (draft.forms.some((form) => form.roleId === role.id)) throw fail('Role already has a form', 'APP_FORM_EXISTS');
        const form = { roleId: role.id, name: nameFrom(name, draft.forms), enabled: true, questions: asked, logChannelId: null };
        const first = draft.forms.length === 0;
        draft.forms.push(form);
        if (first) draft.settings.enabled = true;
        return form;
    }, options);
    noteChange(guild, actor, 'form created', { roleId: role.id }, options);
    return done;
}

/**
 * Change one form. `patch` may hold `name`, `enabled`, `questions`, `logChannelId` (null clears it).
 * Throws APP_FORBIDDEN, APP_FORM_MISSING, APP_NAME_EMPTY, APP_NAME_TAKEN, APP_QUESTIONS_EMPTY, APP_STALE.
 */
export async function updateForm(client, guild, actor, roleId, patch, options = {}) {
    mustConfigure(guild, actor);
    const done = await changeConfig(client, guild.id, (draft) => {
        const form = draft.forms.find((entry) => entry.roleId === roleId);
        if (!form) throw fail('No such application form', 'APP_FORM_MISSING');
        if ('name' in patch) form.name = nameFrom(patch.name, draft.forms, roleId);
        if ('enabled' in patch) form.enabled = patch.enabled === true;
        if ('questions' in patch) form.questions = questionsFrom(patch.questions);
        if ('logChannelId' in patch) form.logChannelId = isSnowflake(patch.logChannelId) ? patch.logChannelId : null;
        return form;
    }, options);
    noteChange(guild, actor, 'form changed', { roleId, fields: Object.keys(patch) }, options);
    return done;
}

/** Delete a form together with its settings and every application made with it. Throws APP_FORBIDDEN, APP_FORM_MISSING, APP_STALE. */
export async function deleteForm(client, guild, actor, roleId, options = {}) {
    mustConfigure(guild, actor);
    const done = await changeConfig(client, guild.id, (draft) => {
        const at = draft.forms.findIndex((entry) => entry.roleId === roleId);
        if (at === -1) throw fail('No such application form', 'APP_FORM_MISSING');
        return draft.forms.splice(at, 1)[0];
    }, options);
    noteChange(guild, actor, 'form deleted', { roleId, removedApplications: done.removedApplications }, options);
    return done;
}

/**
 * Change server-wide settings. `patch` may hold `enabled`, `managerRoles`, `pendingDays`, `reviewedDays`,
 * `logChannelId` (the older copy of the server-wide log channel; the logging settings come first).
 * Manager roles must be roles of this server other than @everyone: a manager role lets its holders
 * read every application and decide it.
 * Throws APP_FORBIDDEN, APP_MANAGER_ROLE (with `roleId`), APP_MANAGER_LIMIT, APP_RETENTION, APP_STALE.
 */
export async function updateSettings(client, guild, actor, patch, options = {}) {
    mustConfigure(guild, actor);
    const next = {};
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('logChannelId' in patch) next.logChannelId = isSnowflake(patch.logChannelId) ? patch.logChannelId : null;
    if ('managerRoles' in patch) {
        const ids = [...new Set(Array.isArray(patch.managerRoles) ? patch.managerRoles : [])];
        if (ids.length > LIMITS.managerRoles) throw fail('Too many manager roles', 'APP_MANAGER_LIMIT');
        for (const roleId of ids) {
            const role = isSnowflake(roleId) ? guild.roles.cache.get(roleId) : null;
            if (!role || role.id === guild.id) throw fail('Not a usable manager role', 'APP_MANAGER_ROLE', { roleId });
        }
        next.managerRoles = ids;
    }
    for (const field of ['pendingDays', 'reviewedDays']) {
        if (!(field in patch)) continue;
        const value = patch[field];
        if (!Number.isSafeInteger(value) || value < LIMITS.retentionMin || value > LIMITS.retentionMax) throw fail('Retention out of range', 'APP_RETENTION');
        next[field] = value;
    }
    const done = await changeConfig(client, guild.id, (draft) => {
        Object.assign(draft.settings, next);
    }, options);
    noteChange(guild, actor, 'settings changed', { fields: Object.keys(next) }, options);
    return done;
}

/** Days from a form field: whole digits only, so "12abc" is refused instead of read as 12. */
export function parseDays(text) {
    const trimmed = String(text ?? '').trim();
    return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : null;
}
