import { createUtilityFixture, guildId, memberId } from './utility-fixture.js';
import applyCommand from '../../src/commands/Community/apply.js';
import appAdminCommand from '../../src/commands/Community/app-admin.js';
import { applicationButton, applicationModal, applicationSelect } from '../../src/handlers/applicationHandlers.js';
import { roleId } from './reactroles-fixture.js';

export { guildId, memberId, roleId };
export { missingPermissions, serverError } from './reactroles-fixture.js';
export { unknownMember } from './leveling-postgres-fixture.js';

const json = (part) => (typeof part?.toJSON === 'function' ? part.toJSON() : part);

export const PREFIX = `guild:${guildId}:applications:`;

/**
 * The Utility fixture plus what role applications need: roles of different standing, direct
 * messages, buttons, select menus and forms with `app:` ids, and the stored rows.
 *
 * Roles: `staff` and `helper` can be given by the bot; `adminRole` carries Administrator;
 * `aboveBot` sits above the bot; `booster` is managed by an integration.
 * Members: `alice`, `bob`, `carol` (ordinary), `manager` (Manage Server, top role `lead`),
 * `reviewer` (no permission, holds `reviewerRole`), `admin` (Administrator), `owner`.
 *
 * `hooks.dm(userId, payload)`, `hooks.fetchUser(userId)`, `hooks.showModal(modal)` and
 * `hooks.editReply(payload)` run before the call takes effect and may throw.
 */
export async function createCommunityFixture(t) {
    const fx = await createUtilityFixture(t);
    const { client, guild, hooks } = fx;

    const helper = fx.addRole(roleId(31), { name: 'Helper', position: 12 });
    const staff = fx.addRole(roleId(32), { name: 'Staff', position: 20, permissions: ['KickMembers'] });
    const reviewerRole = fx.addRole(roleId(33), { name: 'Recruiter', position: 15 });
    const lead = fx.addRole(roleId(34), { name: 'Lead', position: 30, permissions: ['ManageGuild'] });
    const adminRole = fx.addRole(roleId(35), { name: 'Admin', position: 40, permissions: ['Administrator'] });
    const aboveBot = fx.addRole(roleId(36), { name: 'Founder', position: 60 });
    const booster = fx.addRole(roleId(37), { name: 'Booster', position: 13, managed: true });
    // A member's highest role, as discord.js computes it.
    const withHighest = (member) => {
        Object.defineProperty(member.roles, 'highest', {
            configurable: true,
            get: () => [...member.roles.cache.values()].reduce((top, role) => ((role.position ?? 0) > (top.position ?? 0) ? role : top), fx.roles.get(guildId)),
        });
        return member;
    };
    for (const member of fx.members.values()) withHighest(member);
    const manager = fx.manager;
    manager.roles.cache.set(lead.id, lead);
    const reviewer = withHighest(fx.addMember(memberId(11), [reviewerRole.id]));
    // The reaction roles fixture's `admin` owns the server.
    const owner = fx.admin;
    const admin = withHighest(fx.addMember(memberId(12), [adminRole.id], ['Administrator']));

    /** A further member, with `roles.highest` like the others. */
    const addMember = (id, roleIds = [], permissions = []) => withHighest(fx.addMember(id, roleIds, permissions));

    const dms = [];
    client.users = {
        fetch: async (id) => {
            await hooks.fetchUser?.(id);
            return {
                id,
                tag: `user${id.slice(-3)}`,
                send: async (payload) => {
                    await hooks.dm?.(id, payload);
                    dms.push({ userId: id, embed: json(payload.embeds?.[0]) ?? {}, payload });
                },
            };
        },
    };

    /** What a submitted modal holds. Role and channel pickers take an id or a list of ids. */
    const fieldsOf = (values = {}) => ({
        getTextInputValue: (name) => (typeof values[name] === 'string' ? values[name] : ''),
        getCheckbox: (name) => values[name] === true,
        getField: (name) => ({ values: [].concat(values[name] ?? []) }),
    });

    /** What every interaction of this feature needs on top of the Utility fixture's. */
    function finish(out, kind) {
        const { it } = out;
        it.token = 'token';
        out.shown = [];
        it.isButton = () => kind === 'button';
        it.isStringSelectMenu = () => kind === 'select';
        it.isModalSubmit = () => kind === 'form';
        it.isChatInputCommand = () => kind === 'slash';
        it.isAutocomplete = () => false;
        it.showModal = async (built) => {
            if (it.replied || it.deferred) throw Object.assign(new Error('Interaction has already been acknowledged.'), { code: 40060 });
            await hooks.showModal?.(built);
            out.shown.push(json(built));
            it.replied = true;
        };
        it.deferUpdate = async () => {
            if (it.replied || it.deferred) throw Object.assign(new Error('Interaction has already been acknowledged.'), { code: 40060 });
            it.deferred = true;
            out.updated = true;
        };
        const editReply = it.editReply;
        it.editReply = async (payload) => {
            await hooks.editReply?.(payload);
            return editReply(payload);
        };
        /** Custom ids of the components of the last answer. */
        out.ids = () => (out.replies.at(-1)?.components ?? []).map(json).flatMap((row) => row.components ?? []).map((part) => part.custom_id);
        /** The id of the modal that was shown, if one was. */
        out.modalId = () => out.shown.at(-1)?.custom_id ?? null;
        out.color = () => out.embed().color;
        return out;
    }

    /** A slash command. */
    function slash(commandName, options = {}, { member = fx.alice, channel = fx.general } = {}) {
        const out = fx.slash(commandName, options, { member, channel });
        const value = (name) => options[name] ?? null;
        Object.assign(out.it.options, { getNumber: value, getRole: value, getFocused: () => options.focused ?? '' });
        out.it.respond = async (choices) => { out.choices = choices; };
        return finish(out, 'slash');
    }
    /** A button press on a message of the bot. */
    const button = (customId, { member = fx.manager, channel = fx.general, message = { id: 'dashboard' } } = {}) => finish(fx.button(customId, { member, channel, message }), 'button');
    /** A choice in a select menu. */
    function select(customId, value, { member = fx.manager, channel = fx.general } = {}) {
        const out = finish(fx.button(customId, { member, channel, message: { id: 'dashboard' } }), 'select');
        out.it.values = [value];
        return out;
    }
    /** A submitted form. `fromMessage: false` is a form opened by a slash command. */
    function form(customId, values = {}, { member = fx.manager, channel = fx.general, fromMessage = true } = {}) {
        const out = finish(fx.modal(customId, {}, { member, channel, message: fromMessage ? { id: 'dashboard' } : null }), 'form');
        out.it.fields = fieldsOf(values);
        return out;
    }

    /** Every stored row of the feature, by the part of the key after `guild:<id>:applications:`. */
    async function stored() {
        const result = await fx.query('SELECT key, value FROM temp_data WHERE key LIKE $1 ORDER BY key', [`${PREFIX}%`]);
        return Object.fromEntries(result.rows.map((row) => [row.key.slice(PREFIX.length), row.value]));
    }
    const seed = (name, value) => fx.seedRow(`${PREFIX}${name}`, value);
    /** The stored applications (not settings, roles or indexes), oldest first. */
    async function applications() {
        const all = await stored();
        return Object.entries(all).filter(([name, value]) => /^\d+-[a-z0-9]+$/.test(name) && value && typeof value === 'object')
            .map(([, value]) => value).sort((a, b) => a.createdAt - b.createdAt);
    }
    /**
     * Hand a button, select menu or form to its handler the way the router does: the id is split on
     * `:` and the rest are the arguments. What the handler throws ends up in `out.error`.
     */
    async function run(out) {
        const [, ...args] = out.it.customId.split(':');
        const handler = out.it.isButton() ? applicationButton : out.it.isStringSelectMenu() ? applicationSelect : applicationModal;
        out.error = await handler.execute(out.it, client, args).then(() => null, (error) => error);
        return out;
    }
    /** Run a slash command of this feature. */
    async function command(name, options = {}, who = {}) {
        const out = slash(name, options, who);
        const target = name === 'apply' ? applyCommand : appAdminCommand;
        out.error = await target.execute(out.it, {}, client).then(() => null, (error) => error);
        return out;
    }

    /**
     * Store settings and forms directly, without the code under test.
     * `forms`: `[{ role, name, enabled, questions, logChannelId }]`.
     */
    async function seedConfig({ settings = { enabled: true }, forms = [] } = {}) {
        await seed('settings', settings);
        await seed('roles', forms.map((form) => ({ roleId: form.role.id, name: form.name ?? form.role.name, enabled: form.enabled !== false })));
        for (const form of forms) {
            if (form.questions || form.logChannelId) await seed(`role:${form.role.id}:settings`, { questions: form.questions ?? [], logChannelId: form.logChannelId ?? null });
        }
    }

    /** `/apply submit` for `name`, then the filled-in form. `open` is the command, `sent` the form (null when no form was shown). */
    async function applyFor(member, name, answers = ['Because I want to help.']) {
        const open = await command('apply', { subcommand: 'submit', application: name }, { member });
        if (!open.modalId()) return { open, sent: null, application: null };
        const sent = await run(form(open.modalId(), Object.fromEntries(answers.map((answer, index) => [`q${index}`, answer])), { member, fromMessage: false }));
        const mine = (await applications()).filter((application) => application.userId === member.id);
        return { open, sent, application: mine.at(-1) ?? null };
    }

    /** Press Approve or Deny on a review and submit the reason form. `asked` is the button, `done` the form (null when no form was shown). */
    async function decide(member, id, action, reason = '') {
        const asked = await run(button(`app:decide:${action}:${id}`, { member }));
        if (!asked.modalId()) return { asked, done: null };
        const done = await run(form(asked.modalId(), { review_reason: reason }, { member }));
        return { asked, done };
    }

    /** Switch logging on with an applications channel. */
    const logTo = (channel = fx.reports, extra = {}) => fx.setLogging({ enabled: true, channels: { applications: channel.id }, ...extra });

    return {
        ...fx, helper, staff, reviewerRole, lead, adminRole, aboveBot, booster, manager, reviewer, owner, admin, dms,
        addMember, slash, button, select, form, fieldsOf, stored, seed, applications, logTo, run, command, seedConfig, applyFor, decide,
    };
}
