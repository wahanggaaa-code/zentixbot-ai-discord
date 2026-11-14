import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection } from 'discord.js';
import { createCommunityFixture, guildId, memberId, roleId } from './helpers/community-fixture.js';
import { pgEnabled, onSQLite, isRefused, assertCommitFailureSaid } from './helpers/leveling-postgres-fixture.js';
import interactionCreate from '../src/events/interactionCreate.js';
import applyCommand from '../src/commands/Community/apply.js';
import appAdminCommand from '../src/commands/Community/app-admin.js';
import buttonHandler from '../src/interactions/buttons/applications/app.js';
import selectHandler from '../src/interactions/selectMenus/applications/app.js';
import modalHandler from '../src/interactions/modals/applications/app.js';
import { LIMITS, changeConfig, readAll, readConfig } from '../src/services/applications/store.js';
import { createForm, updateSettings } from '../src/services/applications/service.js';

// Setting up role applications in Discord: `/app-admin setup`, the dashboard and its forms, on a
// disposable PostgreSQL. The last tests go through the real interaction router.
const skip = !pgEnabled;
const WARNING = 0xFEE75C;
const ERROR = 0xED4245;
const STORAGE = /could not be read or saved right now\. Nothing was changed/;
const DENIED = /You do not have permission to manage applications\./;
const GONE = /This button or form is no longer valid\. Open the dashboard again with `\/app-admin dashboard`\./;

const field = (out, name) => out.embed().fields.find((entry) => entry.name.startsWith(name))?.value;
/** The filled-in "new application" form, by default from the server owner (who may offer any role the bot can give). */
const newForm = (fx, values, who = {}) => fx.run(fx.form('app:new', { role_id: fx.staff.id, app_name: 'Staff', app_question_1: 'Why?', ...values }, { member: fx.owner, fromMessage: false, ...who }));

// ---- creating a form ------------------------------------------------------------------------

test('/app-admin setup asks for role, name and questions; the first form is stored and switches applications on', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    const asked = await fx.command('app-admin', { subcommand: 'setup' }, { member: fx.manager });
    const modal = asked.shown[0];
    assert.deepEqual([modal.custom_id, modal.title], ['app:new', 'Set Up New Application']);
    const parts = modal.components.map((label) => label.component);
    assert.deepEqual(parts.map((part) => [part.custom_id, part.required ?? null, part.max_length ?? null]), [
        ['role_id', true, null], ['app_name', true, LIMITS.formName], ['app_question_1', true, LIMITS.question], ['app_question_2', false, LIMITS.question], ['app_question_3', false, LIMITS.question],
    ]);
    assert.equal(asked.replies.length, 0);

    const made = await newForm(fx, { app_name: '  Staff\n *team* ', app_question_1: ' Why   this role? ', app_question_2: '', app_question_3: 'Anything\telse?' });
    assert.equal(made.error, null);
    assert.equal(made.isPrivate(), true);
    assert.equal(made.embed().title, 'Application Dashboard', 'the new form is opened');
    assert.match(made.embed().description, new RegExp(`^\\*\\*Saved\\.\\*\\* Application \\*\\*Staff \\\\\\*team\\\\\\*\\*\\* was created for <@&${fx.staff.id}>\\.\\n\\nConfiguration for \\*\\*Staff \\\\\\*team\\\\\\*\\*\\*$`));
    assert.equal(field(made, 'Questions'), '1. Why this role?\n2. Anything else?');
    assert.equal(field(made, 'Application Status'), '**Open**');
    assert.deepEqual(made.ids(), [`app:cfg:${fx.staff.id}`, `app:toggle:${fx.staff.id}:off`, `app:delete:${fx.staff.id}`, 'app:home']);

    const rows = await fx.stored();
    assert.deepEqual(rows.roles, [{ roleId: fx.staff.id, name: 'Staff *team*', enabled: true }]);
    assert.deepEqual(rows[`role:${fx.staff.id}:settings`], { questions: ['Why this role?', 'Anything else?'], logChannelId: null });
    assert.deepEqual(rows.settings, {
        enabled: true, managerRoles: [], logChannelId: null, questions: [], revision: 1, pendingApplicationRetentionDays: 30, reviewedApplicationRetentionDays: 30,
    });

    // A second form does not switch applications back on by itself.
    await updateSettings(fx.client, fx.guild, fx.manager, { enabled: false });
    const second = await newForm(fx, { role_id: fx.helper.id, app_name: 'Helper' });
    assert.match(second.embed().description, /was created for <@&\d+>\. Applications are disabled for this server, so members cannot apply yet\./);
    assert.equal((await readConfig(fx.client, guildId)).settings.enabled, false);
    assert.equal((await readConfig(fx.client, guildId)).forms.length, 2);
});

test('a form is only made for a role its maker could hand out by hand, and that the bot can give', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    // Manage Server and Manage Roles, highest role "Lead" (30).
    const lead = fx.addMember(memberId(41), [fx.lead.id], ['ManageGuild', 'ManageRoles']);
    const refused = async (member, role, pattern) => {
        const out = await newForm(fx, { role_id: role, app_name: `Form ${Math.random()}` }, { member });
        assert.equal(out.embed().title, 'Applications Dashboard');
        assert.match(out.embed().description, pattern);
        assert.match(out.embed().description, /^\*\*Not saved\.\*\*/);
    };

    await refused(lead, fx.adminRole.id, /The role is not below your own highest role\. Nothing was changed\./);
    await refused(lead, fx.lead.id, /The role is not below your own highest role\./);
    // `manager` has Manage Server but not Manage Roles.
    await refused(fx.manager, fx.staff.id, /You need the Manage Roles permission to offer a role through an application\. Nothing was changed\./);
    await refused(lead, fx.aboveBot.id, /The role is not below my highest role\./);
    await refused(fx.owner, fx.aboveBot.id, /The role is not below my highest role\./);
    await refused(fx.owner, fx.booster.id, /managed by an integration/);
    await refused(fx.owner, guildId, /The @everyone role cannot be applied for\./);
    await refused(fx.owner, '553456789012345999', /The role no longer exists\./);
    await refused(fx.owner, [], /The role no longer exists\./);
    assert.deepEqual(await fx.stored(), {}, 'nothing was stored');

    // Below the maker and below the bot: accepted. The owner is not bound by their own roles.
    assert.match((await newForm(fx, { role_id: fx.staff.id, app_name: 'Staff' }, { member: lead })).embed().description, /^\*\*Saved\.\*\*/);
    assert.match((await newForm(fx, { role_id: fx.adminRole.id, app_name: 'Admin' }, { member: fx.owner })).embed().description, /^\*\*Saved\.\*\*/);
    assert.deepEqual((await readConfig(fx.client, guildId)).forms.map((form) => form.name), ['Staff', 'Admin']);
});

test('one form per role, names unique whatever the case, at least one question, at most 25 forms', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    const owner = { member: fx.owner };
    await newForm(fx, {}, owner);
    const notSaved = async (values, pattern) => {
        const out = await newForm(fx, values, owner);
        assert.match(out.embed().description, pattern);
        assert.match(out.embed().description, /^\*\*Not saved\.\*\*/);
        assert.equal(out.embed().title, 'Applications Dashboard', 'the overview, showing what is really stored');
    };
    await notSaved({ app_name: 'Other' }, /That role already has an application\./);
    await notSaved({ role_id: fx.helper.id, app_name: 'sTAFF' }, /Another application already has that name\./);
    await notSaved({ role_id: fx.helper.id, app_name: ' \n ' }, /The application needs a name\./);
    await notSaved({ role_id: fx.helper.id, app_name: 'Helper', app_question_1: '   ' }, /An application needs at least one question\./);
    assert.equal((await readConfig(fx.client, guildId)).forms.length, 1);

    // A name and questions longer than their fields are cut, not refused.
    await newForm(fx, { role_id: fx.helper.id, app_name: 'N'.repeat(80), app_question_1: 'Q'.repeat(150) }, owner);
    const { forms } = await readConfig(fx.client, guildId);
    assert.deepEqual([forms[1].name.length, forms[1].questions[0].length], [LIMITS.formName, LIMITS.question]);

    for (let n = 3; n <= LIMITS.forms; n++) {
        const role = fx.addRole(roleId(100 + n), { name: `Extra ${n}`, position: 5 });
        await createForm(fx.client, fx.guild, fx.owner, { role, name: `Extra ${n}`, questions: ['Why?'] });
    }
    const one = fx.addRole(roleId(190), { name: 'One too many', position: 5 });
    await notSaved({ role_id: one.id, app_name: 'One too many' }, new RegExp(`A server can have at most ${LIMITS.forms} applications\\.`));
    const board = await fx.command('app-admin', { subcommand: 'dashboard' }, owner);
    assert.ok(field(board, `Applications (${LIMITS.forms}/${LIMITS.forms})`));
    const add = board.replies.at(-1).components.at(-1).toJSON().components.find((part) => part.custom_id === 'app:new');
    assert.equal(add.disabled, true);
});

test('a form created while the stored forms cannot be read or written is not created, and replaces nothing', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ forms: [{ role: fx.helper, name: 'Helper', questions: ['One?'] }, { role: fx.reviewerRole, name: 'Recruiter', questions: ['Two?'] }] });
    const before = await fx.stored();

    // The per-server lock is a PostgreSQL statement; SQLite has one writer by design.
    for (const failing of [/SELECT/, /INSERT/, /COMMIT/, ...(onSQLite ? [] : [/pg_advisory_xact_lock/])]) {
        fx.control.failQuery = (sql) => failing.test(sql) && (/temp_data/.test(sql) || !/SELECT/.test(String(failing)));
        const out = await newForm(fx, {}, { member: fx.owner });
        fx.control.failQuery = null;
        assert.equal(out.error, null, String(failing));
        assert.doesNotMatch(JSON.stringify(out.replies), /Saved\.\*\* Application|Application Created/, String(failing));
        assert.deepEqual(await fx.stored(), before, String(failing));
    }

    // Two admins creating forms at the same moment: both are kept.
    const both = await Promise.all([
        newForm(fx, { role_id: fx.staff.id, app_name: 'Staff' }, { member: fx.owner }),
        newForm(fx, { role_id: fx.booster.id === fx.staff.id ? fx.staff.id : fx.adminRole.id, app_name: 'Admin' }, { member: fx.owner }),
    ]);
    assert.ok(both.every((out) => /^\*\*Saved\.\*\*/.test(out.embed().description)));
    assert.deepEqual((await readConfig(fx.client, guildId)).forms.map((form) => form.name).sort(), ['Admin', 'Helper', 'Recruiter', 'Staff']);
});

// ---- the dashboard --------------------------------------------------------------------------

test('the dashboard shows what is stored and what stands in the way; every control carries what it does', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    const empty = await fx.command('app-admin', { subcommand: 'dashboard' }, { member: fx.manager });
    assert.equal(empty.isPrivate(), true);
    assert.equal(empty.color(), WARNING);
    assert.deepEqual(empty.embed().fields.map((entry) => [entry.name, entry.value]), [
        ['Applications', '**Disabled** (members cannot apply)'],
        ['Retention', 'Pending: **30d** · Reviewed: **30d**'],
        ['Manager Roles', '`None` (only members with Manage Server can review)'],
        ['Log Channel', '`Not set` (new applications are not posted anywhere)'],
        [`Applications (0/${LIMITS.forms})`, 'None yet. Use **Add Application**.'],
    ]);
    assert.deepEqual(empty.ids(), ['app:cfg:global', 'app:switch:on', 'app:new']);
    assert.deepEqual(await fx.stored(), {}, 'opening the dashboard stores nothing');

    await fx.seedConfig({
        settings: { enabled: true, managerRoles: [fx.reviewerRole.id], logChannelId: fx.reports.id, pendingApplicationRetentionDays: 14, reviewedApplicationRetentionDays: 90 },
        forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }, { role: fx.aboveBot, name: 'Founder *x*', enabled: false }],
    });
    await fx.applyFor(fx.alice, 'Staff', ['x']);
    const board = await fx.command('app-admin', { subcommand: 'dashboard' }, { member: fx.manager });
    assert.equal(field(board, 'Applications'), '**Enabled**');
    assert.equal(field(board, 'Retention'), 'Pending: **14d** · Reviewed: **90d**');
    assert.equal(field(board, 'Manager Roles'), `<@&${fx.reviewerRole.id}>`);
    assert.equal(field(board, 'Log Channel'), `<#${fx.reports.id}>\nLogging is switched off for this server, so nothing is posted. Switch it on with \`/logging dashboard\`.`);
    assert.equal(field(board, 'Applications ('), `1. **Staff** · <@&${fx.staff.id}> · open\n2. **Founder \\*x\\*** · <@&${fx.aboveBot.id}> · closed · role cannot be given`);
    assert.deepEqual(board.ids(), ['app:pick', 'app:cfg:global', 'app:switch:off', 'app:new']);
    const pick = board.replies.at(-1).components[0].toJSON().components[0];
    assert.deepEqual(pick.options.map((option) => [option.label, option.value, option.description]), [['Staff', fx.staff.id, 'Open'], ['Founder *x*', fx.aboveBot.id, 'Closed']]);

    await fx.logTo(fx.reports, { enabledEvents: { 'application.submit': false, 'application.review': false } });
    const muted = await fx.command('app-admin', { subcommand: 'dashboard' }, { member: fx.manager });
    assert.match(field(muted, 'Log Channel'), /Application events are switched off in the logging settings, so nothing is posted\./);
    await fx.logTo(fx.reports);
    assert.equal(field(await fx.command('app-admin', { subcommand: 'dashboard' }, { member: fx.manager }), 'Log Channel'), `<#${fx.reports.id}>`);

    // One form, by name or from the menu; a form whose role cannot be given says so.
    const staff = await fx.command('app-admin', { subcommand: 'dashboard', application: 'staff' }, { member: fx.manager });
    assert.deepEqual([staff.embed().title, field(staff, 'Pending'), field(staff, 'Questions'), field(staff, 'Log Channel (server-wide)')], ['Application Dashboard', '1', '1. Why?', `<#${fx.reports.id}>`]);
    const founder = await fx.run(fx.select('app:pick', fx.aboveBot.id));
    assert.equal(founder.updated, true, 'the dashboard message itself is redrawn');
    assert.equal(founder.color(), ERROR);
    assert.equal(field(founder, 'Approvals will be refused'), 'The role is not below my highest role.');
    assert.equal(field(founder, 'Questions (defaults)'), '1. What is your name?\n2. How old are you?\n3. Why do you want to join?');
    assert.deepEqual(founder.ids(), [`app:cfg:${fx.aboveBot.id}`, `app:toggle:${fx.aboveBot.id}:on`, `app:delete:${fx.aboveBot.id}`, 'app:home']);
    const home = await fx.run(fx.button('app:home'));
    assert.equal(home.embed().title, 'Applications Dashboard');
    const unknown = await fx.command('app-admin', { subcommand: 'dashboard', application: 'nothing' }, { member: fx.manager });
    assert.match(unknown.embed().description, /^There is no application with that name; this is the overview\./);
});

test('buttons say the state they set, so a second press or a second open dashboard cannot flip it back', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ settings: { enabled: false }, forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }] });

    for (let press = 0; press < 3; press++) {
        const on = await fx.run(fx.button('app:switch:on'));
        assert.match(on.embed().description, /^\*\*Saved\.\*\* Applications are now enabled\./);
        assert.equal((await readConfig(fx.client, guildId)).settings.enabled, true);
        assert.ok(on.ids().includes('app:switch:off'));
    }
    const off = await fx.run(fx.button('app:switch:off'));
    assert.match(off.embed().description, /Applications are now disabled; members cannot apply\./);
    assert.equal((await readConfig(fx.client, guildId)).settings.enabled, false);

    for (let press = 0; press < 2; press++) {
        const closed = await fx.run(fx.button(`app:toggle:${fx.staff.id}:off`));
        assert.match(closed.embed().description, /^\*\*Saved\.\*\* \*\*Staff\*\* is now closed\./);
        assert.equal(field(closed, 'Application Status'), '**Closed**');
        assert.equal((await readConfig(fx.client, guildId)).forms[0].enabled, false);
    }
    const opened = await fx.run(fx.button(`app:toggle:${fx.staff.id}:on`));
    assert.match(opened.embed().description, /\*\*Staff\*\* is now open\./);

    // A form that was deleted meanwhile, and ids that mean nothing.
    const missing = await fx.run(fx.button(`app:toggle:${fx.helper.id}:off`));
    assert.match(missing.embed().description, /^\*\*Not saved\.\*\* That application does not exist\./);
    for (const id of ['app:switch:maybe', `app:toggle:${fx.staff.id}:maybe`, 'app:toggle:nothing:on', 'app:switch']) {
        assert.match((await fx.run(fx.button(id))).said(), GONE, id);
    }
    for (const [id, value] of [['app:pick', 'nothing'], ['app:cfg:nothing', 'log'], ['app:cfg:global', 'questions'], [`app:cfg:${fx.staff.id}`, 'managers'], [`app:cfg:${fx.helper.id}`, 'rename'], [`app:cfg:${fx.helper.id}`, 'log'], ['app:other', 'x']]) {
        const out = await fx.run(fx.select(id, value));
        assert.match(out.said(), GONE, `${id} ${value}`);
        assert.equal(out.modalId(), null);
    }
    assert.equal((await readConfig(fx.client, guildId)).forms[0].enabled, true);
});

test('questions and name of a form are changed through forms that show what is stored now', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff' }, { role: fx.helper, name: 'Helper', questions: ['Old?'] }] });

    // A form without questions of its own shows the ones it really asks.
    const asked = await fx.run(fx.select(`app:cfg:${fx.staff.id}`, 'questions'));
    const modal = asked.shown[0];
    assert.equal(modal.custom_id, `app:questions:${fx.staff.id}`);
    assert.deepEqual(modal.components.map((row) => [row.components[0].custom_id, row.components[0].value ?? null, row.components[0].required]), [
        ['q1', 'What is your name?', true], ['q2', 'How old are you?', false], ['q3', 'Why do you want to join?', false], ['q4', null, false], ['q5', null, false],
    ]);
    const saved = await fx.run(fx.form(modal.custom_id, { q1: ' First? ', q2: '', q3: 'Third?', q4: '', q5: 'Fifth\nline?' }));
    assert.equal(saved.updated, true);
    assert.match(saved.embed().description, /^\*\*Saved\.\*\* 3 question\(s\) saved\./);
    assert.equal(field(saved, 'Questions'), '1. First?\n2. Third?\n3. Fifth line?');
    assert.deepEqual((await fx.stored())[`role:${fx.staff.id}:settings`].questions, ['First?', 'Third?', 'Fifth line?']);
    const none = await fx.run(fx.form(modal.custom_id, { q1: ' ' }));
    assert.match(none.embed().description, /^\*\*Not saved\.\*\* An application needs at least one question\./);
    assert.equal((await readConfig(fx.client, guildId)).forms[0].questions.length, 3);

    const rename = await fx.run(fx.select(`app:cfg:${fx.staff.id}`, 'rename'));
    assert.deepEqual([rename.shown[0].custom_id, rename.shown[0].components[0].components[0].value], [`app:rename:${fx.staff.id}`, 'Staff']);
    const renamed = await fx.run(fx.form(rename.modalId(), { app_name: 'Moderator' }));
    assert.match(renamed.embed().description, /^\*\*Saved\.\*\* The application is now called \*\*Moderator\*\*\./);
    assert.match((await fx.run(fx.form(rename.modalId(), { app_name: 'helper' }))).embed().description, /^\*\*Not saved\.\*\* Another application already has that name\./);
    // Keeping its own name, in another case, is not a clash with itself.
    assert.match((await fx.run(fx.form(rename.modalId(), { app_name: 'MODERATOR' }))).embed().description, /^\*\*Saved\.\*\*/);
    assert.deepEqual((await readConfig(fx.client, guildId)).forms.map((form) => form.name), ['MODERATOR', 'Helper']);

    // Members apply under the new name; an application already made keeps the name it was made under.
    assert.ok((await fx.command('apply', { subcommand: 'submit', application: 'Moderator' }, { member: fx.alice })).modalId());
});

test('manager roles: the selection is the list; roles of this server only, @everyone never, ten at most', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ settings: { enabled: true, managerRoles: [fx.reviewerRole.id, '553456789012345999'] } });
    const asked = await fx.run(fx.select('app:cfg:global', 'managers'));
    const picker = asked.shown[0].components[0].component;
    assert.deepEqual([asked.shown[0].custom_id, picker.custom_id, picker.min_values, picker.max_values], ['app:managers', 'manager_roles', 0, LIMITS.managerRoles]);
    assert.deepEqual(picker.default_values, [{ id: fx.reviewerRole.id, type: 'role' }], 'a role that no longer exists is not preselected');

    const saved = await fx.run(fx.form('app:managers', { manager_roles: [fx.helper.id, fx.staff.id, fx.helper.id] }));
    assert.match(saved.embed().description, new RegExp(`^\\*\\*Saved\\.\\*\\* Manager roles: <@&${fx.helper.id}>, <@&${fx.staff.id}>\\.`));
    assert.deepEqual((await readConfig(fx.client, guildId)).settings.managerRoles, [fx.helper.id, fx.staff.id]);

    for (const [roles, pattern] of [
        [[fx.helper.id, guildId], /A manager role must be a role of this server other than @everyone\./],
        [[fx.helper.id, '553456789012345999'], /A manager role must be a role of this server other than @everyone\./],
    ]) {
        const out = await fx.run(fx.form('app:managers', { manager_roles: roles }));
        assert.match(out.embed().description, pattern);
        assert.match(out.embed().description, /^\*\*Not saved\.\*\*/);
    }
    const many = Array.from({ length: LIMITS.managerRoles + 1 }, (unused, n) => fx.addRole(roleId(200 + n), { name: `M${n}`, position: 3 }).id);
    await updateSettings(fx.client, fx.guild, fx.owner, { managerRoles: many }).then(() => assert.fail('eleven roles'), (error) => assert.equal(error.code, 'APP_MANAGER_LIMIT'));
    assert.deepEqual((await readConfig(fx.client, guildId)).settings.managerRoles, [fx.helper.id, fx.staff.id]);

    const cleared = await fx.run(fx.form('app:managers', { manager_roles: [] }));
    assert.match(cleared.embed().description, /^\*\*Saved\.\*\* No manager roles are set\./);
    assert.deepEqual((await readConfig(fx.client, guildId)).settings.managerRoles, []);
});

test('retention takes whole days from 1 to 3650 and nothing else; another open dashboard cannot put old values back', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    const asked = await fx.run(fx.select('app:cfg:global', 'retention'));
    assert.deepEqual(asked.shown[0].components.map((label) => [label.component.custom_id, label.component.value]), [['pending_days', '30'], ['reviewed_days', '30']]);

    for (const [pending, reviewed] of [['12abc', '30'], ['30', '1.5'], ['0', '30'], ['30', '3651'], ['', '30'], ['-5', '30'], ['1e2', '30'], ['30', ' ']]) {
        const out = await fx.run(fx.form('app:retention', { pending_days: pending, reviewed_days: reviewed }));
        assert.match(out.embed().description, /^\*\*Not saved\.\*\* Retention must be a whole number of days between 1 and 3650\./, `${pending}/${reviewed}`);
    }
    assert.deepEqual(await fx.stored(), {}, 'a refused value stores nothing, not even the other field');

    const saved = await fx.run(fx.form('app:retention', { pending_days: ' 7 ', reviewed_days: '3650' }));
    assert.match(saved.embed().description, /^\*\*Saved\.\*\* Pending applications are kept for \*\*7 days\*\*, reviewed ones for \*\*3650 days\*\*\./);
    assert.equal(field(saved, 'Retention'), 'Pending: **7d** · Reviewed: **3650d**');

    // A second dashboard, opened before the change, saves something else: retention stays.
    await fx.run(fx.form('app:managers', { manager_roles: [fx.helper.id] }));
    await fx.run(fx.button('app:switch:on'));
    const { settings } = await readConfig(fx.client, guildId);
    assert.deepEqual([settings.pendingDays, settings.reviewedDays, settings.managerRoles, settings.enabled], [7, 3650, [fx.helper.id], true]);
    assert.equal(settings.revision, 3, 'one revision per stored change');
});

test('the log channel must be a text channel the bot can post in; setting it says when logging gets switched on', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }] });
    const voice = fx.makeChannel({ id: '443456789012345741', name: 'voice', type: ChannelType.GuildVoice });
    const closed = fx.makeChannel({ id: '443456789012345742', name: 'closed' });
    fx.setBotPermissions(closed.id, ['ViewChannel', 'SendMessages']);

    const asked = await fx.run(fx.select('app:cfg:global', 'log'));
    const picker = asked.shown[0].components[0].component;
    assert.deepEqual([asked.shown[0].custom_id, picker.custom_id, picker.min_values, picker.max_values, picker.channel_types], ['app:log:global', 'log_channel', 0, 1, [ChannelType.GuildText]]);
    assert.equal(picker.default_values, undefined);

    for (const [channelId, pattern] of [
        [voice.id, /Log entries can only go to a text channel of this server\./],
        ['443456789012345999', /Log entries can only go to a text channel of this server\./],
        [closed.id, new RegExp(`I cannot post in <#${closed.id}>\\. Missing there: Embed Links\\.`)],
    ]) {
        const out = await fx.run(fx.form('app:log:global', { log_channel: channelId }));
        assert.match(out.embed().description, pattern);
        assert.match(out.embed().description, /^\*\*Not saved\.\*\*/);
    }
    assert.equal((await readConfig(fx.client, guildId)).settings.logChannelId, null);

    const saved = await fx.run(fx.form('app:log:global', { log_channel: fx.reports.id }));
    assert.match(saved.embed().description, new RegExp(`^\\*\\*Saved\\.\\*\\* New applications are now posted in <#${fx.reports.id}>\\. Logging was switched off for this server and is now \\*\\*on\\*\\*; every log type that has a channel is posted again\\.`));
    assert.equal(field(saved, 'Log Channel'), `<#${fx.reports.id}>`);
    const config = (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config;
    assert.deepEqual([config.logging.enabled, config.logging.channels.applications], [true, fx.reports.id]);
    await fx.applyFor(fx.alice, 'Staff', ['x']);
    assert.equal(fx.postedIn(fx.reports).length, 1);

    // Logging already on: nothing to announce. The picker now starts on the channel in use.
    const again = await fx.run(fx.form('app:log:global', { log_channel: fx.general.id }));
    assert.doesNotMatch(again.embed().description, /switched off/);
    assert.deepEqual((await fx.run(fx.select('app:cfg:global', 'log'))).shown[0].components[0].component.default_values, [{ id: fx.general.id, type: 'channel' }]);

    // One form can have a channel of its own; an empty picker goes back to the server-wide one.
    const own = await fx.run(fx.form(`app:log:${fx.staff.id}`, { log_channel: fx.reports.id }));
    assert.match(own.embed().description, new RegExp(`^\\*\\*Saved\\.\\*\\* This application is now logged in <#${fx.reports.id}>\\.`));
    assert.equal(field(own, 'Log Channel (this application)'), `<#${fx.reports.id}>`);
    const back = await fx.run(fx.form(`app:log:${fx.staff.id}`, { log_channel: [] }));
    assert.match(back.embed().description, /This application now uses the server-wide log channel\./);
    assert.equal(field(back, 'Log Channel (server-wide)'), `<#${fx.general.id}>`);

    const cleared = await fx.run(fx.form('app:log:global', { log_channel: [] }));
    assert.match(cleared.embed().description, /^\*\*Saved\.\*\* The server-wide log channel was cleared\./);
    assert.equal(field(cleared, 'Log Channel'), '`Not set` (new applications are not posted anywhere)');
    assert.equal((await readConfig(fx.client, guildId)).settings.logChannelId, null);
});

test('deleting a form needs the ticked box and takes every application made with it, however many', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff *x*', questions: ['Why?'], logChannelId: fx.reports.id }, { role: fx.helper, name: 'Helper', questions: ['Why?'] }] });
    const now = Date.now();
    for (let n = 0; n < 60; n++) {
        await fx.seed(`${now - n * 1000}-staff${n}`, { userId: memberId(300 + n), roleId: fx.staff.id, status: n % 2 ? 'pending' : 'denied', reviewedAt: new Date(now).toISOString(), answers: [] });
    }
    await fx.seed(`${now}-helper`, { userId: fx.alice.id, roleId: fx.helper.id, status: 'pending', answers: [] });

    const asked = await fx.run(fx.button(`app:delete:${fx.staff.id}`));
    const modal = asked.shown[0];
    assert.equal(modal.custom_id, `app:delete:${fx.staff.id}`);
    assert.match(JSON.stringify(modal), /This deletes the application \*\*Staff \\\\\*x\\\\\*\*\*, its questions and settings, and \*\*60\*\* submitted application\(s\) made with it\. Roles already given are not taken back\./);

    const unticked = await fx.run(fx.form(modal.custom_id, {}));
    assert.match(unticked.embed().description, /^\*\*Not saved\.\*\* The confirmation box was not ticked\./);
    assert.equal(unticked.embed().title, 'Application Dashboard', 'still on the form');
    assert.equal((await fx.applications()).length, 61);

    const done = await fx.run(fx.form(modal.custom_id, { confirm_delete: true }));
    assert.match(done.embed().description, /^\*\*Saved\.\*\* Application \*\*Staff \\\*x\\\*\*\* was deleted, together with 60 submitted application\(s\)\./);
    assert.equal(done.embed().title, 'Applications Dashboard');
    const rows = await fx.stored();
    assert.deepEqual(Object.keys(rows).sort(), [`${now}-helper`, 'role:' + fx.helper.id + ':settings', 'roles', 'settings'].sort());
    assert.deepEqual(rows.roles, [{ roleId: fx.helper.id, name: 'Helper', enabled: true }]);

    // Pressed again on an old dashboard: the form is gone, nothing else is.
    assert.match((await fx.run(fx.button(`app:delete:${fx.staff.id}`))).said(), GONE);
    assert.match((await fx.run(fx.form(modal.custom_id, { confirm_delete: true }))).embed().description, /^\*\*Not saved\.\*\* That application does not exist\./);
    assert.equal((await fx.applications()).length, 1);
});

test('settings that could not be saved are shown as not saved, with the dashboard drawn from what is stored', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ settings: { enabled: false }, forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }] });
    const before = await fx.stored();
    const attempts = [
        () => fx.button('app:switch:on'),
        () => fx.button(`app:toggle:${fx.staff.id}:off`),
        () => fx.form(`app:questions:${fx.staff.id}`, { q1: 'New?' }),
        () => fx.form(`app:rename:${fx.staff.id}`, { app_name: 'New' }),
        () => fx.form('app:managers', { manager_roles: [fx.helper.id] }),
        () => fx.form('app:retention', { pending_days: '5', reviewed_days: '5' }),
        () => fx.form(`app:log:${fx.staff.id}`, { log_channel: fx.reports.id }),
        () => fx.form('app:log:global', { log_channel: fx.reports.id }),
        () => fx.form(`app:delete:${fx.staff.id}`, { confirm_delete: true }),
    ];
    for (const [index, make] of attempts.entries()) {
        fx.control.failQuery = (sql) => /INSERT|DELETE/.test(sql) && /temp_data/.test(sql);
        const out = await fx.run(make());
        fx.control.failQuery = null;
        assert.equal(out.error, null, `attempt ${index}`);
        assert.match(out.embed().description, /^\*\*Not saved\.\*\* The applications data could not be read or saved right now\. Nothing was changed/, `attempt ${index}`);
        assert.match(field(out, 'Applications') ?? field(out, 'Application Status'), /Disabled|Open/, `attempt ${index}: drawn from what is stored`);
    }
    fx.control.failQuery = (sql) => /COMMIT/.test(sql);
    const unsure = await fx.run(fx.button('app:switch:on'));
    fx.control.failQuery = null;
    assertCommitFailureSaid(unsure.embed().description, /^\*\*Not saved\.\*\* The database did not confirm the change\. It may or may not have been saved; please check before trying again\./, /^\*\*Not saved\.\*\* The applications data could not be read or saved right now\. Nothing was changed/);
    assert.deepEqual(await fx.stored(), before);
    const config = (await fx.query('SELECT config FROM guilds WHERE id = $1', [guildId])).rows[0].config;
    assert.equal(config.logging?.channels?.applications, undefined, 'the logging settings were not written for a channel that was not stored');

    // Nothing can be read at all: the failure is said; no controls over nothing.
    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    const blind = await fx.run(fx.button('app:switch:on'));
    assert.match(blind.said(), STORAGE);
    assert.deepEqual(blind.ids(), []);
    for (const out of [await fx.run(fx.select('app:cfg:global', 'retention')), await fx.run(fx.button(`app:delete:${fx.staff.id}`))]) {
        assert.match(out.said(), STORAGE);
        assert.equal(out.modalId(), null);
    }
});

test('every control and form of the dashboard refuses members who may not configure, manager roles included', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ settings: { enabled: true, managerRoles: [fx.reviewerRole.id] }, forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }] });
    const before = await fx.stored();
    for (const member of [fx.alice, fx.reviewer]) {
        const outs = [
            await fx.run(fx.button('app:switch:off', { member })),
            await fx.run(fx.button(`app:toggle:${fx.staff.id}:off`, { member })),
            await fx.run(fx.button(`app:delete:${fx.staff.id}`, { member })),
            await fx.run(fx.button('app:new', { member })),
            await fx.run(fx.button('app:home', { member })),
            await fx.run(fx.select('app:pick', fx.staff.id, { member })),
            await fx.run(fx.select('app:cfg:global', 'managers', { member })),
            await fx.run(fx.select(`app:cfg:${fx.staff.id}`, 'questions', { member })),
            await fx.run(fx.form('app:new', { role_id: fx.helper.id, app_name: 'Helper', app_question_1: 'Why?' }, { member })),
            await fx.run(fx.form(`app:questions:${fx.staff.id}`, { q1: 'Mine?' }, { member })),
            await fx.run(fx.form(`app:rename:${fx.staff.id}`, { app_name: 'Mine' }, { member })),
            await fx.run(fx.form('app:managers', { manager_roles: [fx.helper.id] }, { member })),
            await fx.run(fx.form('app:retention', { pending_days: '1', reviewed_days: '1' }, { member })),
            await fx.run(fx.form('app:log:global', { log_channel: fx.reports.id }, { member })),
            await fx.run(fx.form(`app:log:${fx.staff.id}`, { log_channel: fx.reports.id }, { member })),
            await fx.run(fx.form(`app:delete:${fx.staff.id}`, { confirm_delete: true }, { member })),
        ];
        for (const [index, out] of outs.entries()) {
            assert.match(out.said(), DENIED, `${member.id} #${index}`);
            assert.equal(out.modalId(), null, `${member.id} #${index}`);
            assert.equal(out.isPrivate(), true, `${member.id} #${index}`);
            assert.notEqual(out.updated, true, `${member.id} #${index}: the dashboard of someone else is not redrawn`);
        }
    }
    assert.deepEqual(await fx.stored(), before);

    // The service refuses too, whoever calls it.
    await updateSettings(fx.client, fx.guild, fx.reviewer, { enabled: false }).then(() => assert.fail('reviewer'), (error) => assert.equal(error.code, 'APP_FORBIDDEN'));
    await createForm(fx.client, fx.guild, fx.alice, { role: fx.helper, name: 'Helper', questions: ['Why?'] }).then(() => assert.fail('alice'), (error) => assert.equal(error.code, 'APP_FORBIDDEN'));
});

test('the rows of this feature are written by its own store only; a stale revision is refused', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }] });
    const before = await fx.stored();
    for (const key of ['settings', 'roles', `role:${fx.staff.id}:settings`, `${Date.now()}-abc`, `users:${fx.alice.id}`]) {
        const full = `guild:${guildId}:applications:${key}`;
        assert.equal(await isRefused(fx.client.db.set(full, { enabled: false })), true, key);
        assert.equal(await isRefused(fx.client.db.delete(full)), true, key);
        await assert.rejects(fx.client.db.increment(full), { code: onSQLite ? 'APPLICATION_WRITE_DISABLED' : 'CONFIG_WRITE_DISABLED' }, key);
    }
    assert.deepEqual(await fx.stored(), before);

    const { settings } = await readConfig(fx.client, guildId);
    const changed = await changeConfig(fx.client, guildId, (draft) => { draft.settings.enabled = false; }, { revision: settings.revision });
    assert.equal(changed.settings.revision, settings.revision + 1);
    await changeConfig(fx.client, guildId, (draft) => { draft.settings.enabled = true; }, { revision: settings.revision })
        .then(() => assert.fail('stale'), (error) => assert.deepEqual([error.code, error.revision], ['APP_STALE', settings.revision + 1]));
    assert.equal((await readAll(fx.client, guildId)).settings.enabled, false);
});

// ---- through the real router ----------------------------------------------------------------

/** The real `interactionCreate` with the real handler files registered the way the loader does. */
function route(fx) {
    fx.client.commands = new Collection([['apply', applyCommand], ['app-admin', appAdminCommand]]);
    fx.client.buttons = new Collection([[buttonHandler.name, buttonHandler]]);
    fx.client.selectMenus = new Collection([[selectHandler.name, selectHandler]]);
    fx.client.modals = new Collection([[modalHandler.name, modalHandler]]);
    fx.client.cooldowns = new Collection();
    return async (out) => {
        // The per-command cooldown of the router is not what these tests are about.
        fx.client.cooldowns.clear();
        out.it.isAutocomplete ??= () => false;
        out.it.isContextMenuCommand ??= () => false;
        out.it.isAnySelectMenu ??= () => out.it.isStringSelectMenu();
        await interactionCreate.execute(out.it, fx.client);
        return out;
    };
}

test('router: a member applies, a manager-role holder reviews by command and approves, all by ids the bot handed out', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ settings: { enabled: true, managerRoles: [fx.reviewerRole.id] }, forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }] });
    await fx.logTo(fx.reports);
    const send = route(fx);

    const open = await send(fx.slash('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice }));
    assert.match(open.modalId() ?? '', /^app:apply:/);
    const sent = await send(fx.form(open.modalId(), { q0: 'Because.' }, { member: fx.alice, fromMessage: false }));
    assert.equal(sent.embed().title, 'Application Submitted');
    const [application] = await fx.applications();

    // The Review button under the log entry, pressed long after it was posted.
    const entry = fx.calls.send.at(-1).payload.components[0].toJSON().components[0].custom_id;
    const opened = await send(fx.button(entry, { member: fx.reviewer }));
    assert.match(opened.said(), /Because\./);

    // Discord shows /app-admin to Manage Server; a server may allow the manager role under Integrations.
    // The bot's own guard then lets review and list through, and still stops setup and dashboard.
    const review = await send(fx.slash('app-admin', { subcommand: 'review', id: application.id }, { member: fx.reviewer }));
    assert.equal(review.embed().title, 'Review Application');
    assert.equal((await send(fx.slash('app-admin', { subcommand: 'list' }, { member: fx.reviewer }))).embed().title, 'Submitted Applications');
    for (const subcommand of ['setup', 'dashboard']) {
        const stopped = await send(fx.slash('app-admin', { subcommand }, { member: fx.reviewer }));
        assert.match(stopped.said(), /Permission Denied/);
        assert.match(stopped.said(), /You do not have permission to use this command\./, 'stopped by the router, before the command runs');
        assert.equal(stopped.modalId(), null);
    }
    // Without the role, the guard's own check of review and list is the command's: refused there.
    for (const subcommand of ['review', 'list', 'setup', 'dashboard']) {
        const stopped = await send(fx.slash('app-admin', { subcommand, id: application.id }, { member: fx.bob }));
        assert.match(stopped.said(), /Permission Denied|do not have permission/, subcommand);
        assert.doesNotMatch(JSON.stringify(stopped.replies), /Because\./);
        assert.equal(stopped.modalId(), null);
    }

    const asked = await send(fx.button(review.ids()[0], { member: fx.reviewer }));
    const done = await send(fx.form(asked.modalId(), { review_reason: 'Welcome' }, { member: fx.reviewer }));
    assert.equal(done.embed().title, 'Application approved');
    assert.ok(fx.alice.roles.cache.has(fx.staff.id));
    assert.equal((await fx.applications())[0].reviewer, fx.reviewer.id);
});

test('router: the dashboard works press by press, and names are offered while typing', { skip }, async (t) => {
    const fx = await createCommunityFixture(t);
    const send = route(fx);
    const owner = { member: fx.owner };

    const setup = await send(fx.slash('app-admin', { subcommand: 'setup' }, owner));
    const made = await send(fx.form(setup.modalId(), { role_id: fx.staff.id, app_name: 'Staff', app_question_1: 'Why?' }, { ...owner, fromMessage: false }));
    assert.match(made.embed().description, /^\*\*Saved\.\*\*/);

    const closed = await send(fx.button(made.ids().find((id) => id.startsWith('app:toggle:')), owner));
    assert.equal(field(closed, 'Application Status'), '**Closed**');
    const home = await send(fx.button('app:home', owner));
    const picked = await send(fx.select(home.ids()[0], fx.staff.id, owner));
    assert.equal(picked.embed().title, 'Application Dashboard');
    const asked = await send(fx.select(picked.ids()[0], 'rename', owner));
    const renamed = await send(fx.form(asked.modalId(), { app_name: 'Moderator' }, owner));
    assert.match(renamed.embed().description, /now called \*\*Moderator\*\*/);
    assert.deepEqual((await readConfig(fx.client, guildId)).forms, [{ roleId: fx.staff.id, name: 'Moderator', enabled: false, questions: ['Why?'], logChannelId: null }]);

    for (const [name, options, member, expected] of [
        ['apply', { subcommand: 'submit', focused: 'mod' }, fx.alice, []],
        ['app-admin', { subcommand: 'dashboard', focused: 'mod' }, fx.owner, [{ name: 'Moderator (closed)', value: 'Moderator' }]],
    ]) {
        const typing = fx.slash(name, options, { member });
        typing.it.isAutocomplete = () => true;
        typing.it.isChatInputCommand = () => false;
        await send(typing);
        assert.deepEqual(typing.choices, expected, name);
    }
});
