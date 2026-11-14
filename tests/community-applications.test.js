import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import {
    createCommunityFixture, guildId, memberId, missingPermissions, serverError, unknownMember,
} from './helpers/community-fixture.js';
import { pgEnabled, assertCommitFailureSaid } from './helpers/leveling-postgres-fixture.js';
import applyCommand from '../src/commands/Community/apply.js';
import appAdminCommand from '../src/commands/Community/app-admin.js';
import guildMemberRemove from '../src/events/guildMemberRemove.js';
import { logger } from '../src/utils/logger.js';
import { LIMITS, createApplication, deleteApplicationsOf, isApplicationId, purgeExpired, readAll } from '../src/services/applications/store.js';

// Role applications as members and reviewers use them: the real commands, handlers and store on a
// disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const DAY = 24 * 60 * 60 * 1000;
const WARNING = 0xFEE75C;
const STORAGE = /could not be read or saved right now\. Nothing was changed/;

/** A server with applications on and one form, "Staff", asking one question. */
async function setup(t, { settings = { enabled: true }, forms } = {}) {
    const fx = await createCommunityFixture(t);
    await fx.seedConfig({ settings, forms: forms ?? [{ role: fx.staff, name: 'Staff', questions: ['Why do you want this role?'] }] });
    return fx;
}
/** An application row as an older version stored it. */
const oldRow = (fx, id, member, extra = {}) => fx.seed(id, {
    id, guildId, userId: member.id, roleId: fx.staff.id, roleName: 'Staff', status: 'pending',
    createdAt: Number(id.split('-')[0]), answers: [{ question: 'Why?', answer: 'Because.' }], ...extra,
});
const idAt = (ms, tail = 'seeded') => `${ms}-${tail}`;

// ---- /apply list and the form ---------------------------------------------------------------

test('/apply list shows the open forms publicly; closed forms and forms whose role is gone are left out', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    const gone = { id: '553456789012345999', name: 'Gone' };
    await fx.seedConfig({ forms: [
        { role: fx.staff, name: 'Staff' }, { role: fx.helper, name: 'Helper *team*', enabled: false }, { role: gone, name: 'Ghost' },
    ] });

    const list = await fx.command('apply', { subcommand: 'list' }, { member: fx.alice });
    assert.equal(list.embed().title, 'Available Applications');
    assert.match(list.said(), /\*\*1\. Staff\*\* · <@&\d+>/);
    assert.doesNotMatch(list.said(), /Helper|Ghost/);
    assert.equal(list.isPrivate(), false);

    // The names offered while typing are the same forms.
    const typing = fx.slash('apply', { subcommand: 'submit', focused: '' }, { member: fx.alice });
    await applyCommand.autocomplete(typing.it, fx.client);
    assert.deepEqual(typing.choices, [{ name: 'Staff', value: 'Staff' }]);
    const admin = fx.slash('app-admin', { subcommand: 'dashboard', focused: 'e' }, { member: fx.manager });
    await appAdminCommand.autocomplete(admin.it, fx.client);
    assert.deepEqual(admin.choices.map((choice) => choice.name), ['Helper *team* (closed)']);

    await fx.seedConfig({ forms: [{ role: fx.helper, name: 'Helper', enabled: false }] });
    assert.match((await fx.command('apply', { subcommand: 'list' })).said(), /No applications are currently available\./);

    await fx.seedConfig({ settings: { enabled: false }, forms: [{ role: fx.staff, name: 'Staff' }] });
    assert.match((await fx.command('apply', { subcommand: 'list' })).said(), /Applications are currently disabled in this server\./);
    const off = fx.slash('apply', { subcommand: 'submit', focused: '' });
    await applyCommand.autocomplete(off.it, fx.client);
    assert.deepEqual(off.choices, []);
});

test('a failed read is reported as a failure, never as "disabled" or "nothing configured"', { skip }, async (t) => {
    const fx = await setup(t);
    await fx.applyFor(fx.alice, 'Staff');
    const [application] = await fx.applications();
    fx.control.failQuery = (sql) => /SELECT/.test(sql) && /temp_data/.test(sql);

    for (const [name, options, who] of [
        ['apply', { subcommand: 'list' }, fx.bob],
        ['apply', { subcommand: 'submit', application: 'Staff' }, fx.bob],
        ['apply', { subcommand: 'status' }, fx.alice],
        ['apply', { subcommand: 'status', id: application.id }, fx.alice],
        ['app-admin', { subcommand: 'list' }, fx.manager],
        ['app-admin', { subcommand: 'review', id: application.id }, fx.manager],
    ]) {
        const out = await fx.command(name, options, { member: who });
        assert.equal(out.error, null, `${name} ${options.subcommand}`);
        assert.match(out.said(), STORAGE, `${name} ${options.subcommand}`);
        assert.equal(out.modalId(), null);
    }
    const board = await fx.command('app-admin', { subcommand: 'dashboard' }, { member: fx.manager });
    assert.equal(board.embed().title, 'Applications Dashboard');
    assert.match(board.said(), STORAGE);
    assert.deepEqual(board.ids(), [], 'no controls over data that could not be read');

    const typing = fx.slash('apply', { subcommand: 'submit', focused: '' });
    await applyCommand.autocomplete(typing.it, fx.client);
    assert.deepEqual(typing.choices, []);

    const open = await fx.run(fx.button(`app:open:${application.id}`, { member: fx.manager }));
    assert.match(open.said(), STORAGE);
    const decide = await fx.run(fx.button(`app:decide:approve:${application.id}`, { member: fx.manager }));
    assert.match(decide.said(), STORAGE);
    assert.equal(decide.modalId(), null);
});

test('/apply submit opens the form with its questions: its own, else the server default, else the built-in ones', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    const long = 'Please describe in detail what you did in your previous moderation team, and for how long';
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?', long] }, { role: fx.helper, name: 'Helper' }] });

    const own = await fx.command('apply', { subcommand: 'submit', application: 'staff' }, { member: fx.alice });
    const modal = own.shown[0];
    assert.match(modal.custom_id, new RegExp(`^app:apply:${fx.staff.id}:[0-9a-f]{10}$`));
    assert.equal(modal.title, 'Application for Staff');
    const inputs = modal.components.map((row) => row.components[0]);
    assert.deepEqual(inputs.map((input) => [input.custom_id, input.label, input.required, input.max_length]), [
        ['q0', 'Why?', true, 1000], ['q1', `${long.slice(0, 42)}...`, true, 1000],
    ]);
    assert.equal(inputs[1].placeholder, long, 'a question longer than a label is shown whole in the field');
    assert.equal(own.replies.length, 0, 'the form is the first and only answer');

    const builtIn = await fx.command('apply', { subcommand: 'submit', application: 'Helper' }, { member: fx.alice });
    assert.deepEqual(builtIn.shown[0].components.map((row) => row.components[0].label), ['What is your name?', 'How old are you?', 'Why do you want to join?']);

    await fx.seed('settings', { enabled: true, questions: ['Server question one?', '  ', 'Server question two?'] });
    const server = await fx.command('apply', { subcommand: 'submit', application: 'Helper' }, { member: fx.alice });
    assert.deepEqual(server.shown[0].components.map((row) => row.components[0].label), ['Server question one?', 'Server question two?']);
    assert.notEqual(server.modalId(), builtIn.modalId(), 'other questions, other mark');

    // More stored questions than a form can hold: the first five are asked.
    await fx.seed(`role:${fx.staff.id}:settings`, { questions: ['One?', 'Two?', 'Three?', 'Four?', 'Five?', 'Six?'] });
    const six = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });
    assert.equal(six.shown[0].components.length, 5);
});

test('/apply submit refuses without a form: disabled, unknown, closed, role gone, role held, pending, too soon', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    const gone = { id: '553456789012345999', name: 'Gone' };
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff' }, { role: fx.helper, name: 'Helper', enabled: false }, { role: gone, name: 'Ghost' }] });
    const refused = async (member, name, pattern) => {
        const out = await fx.command('apply', { subcommand: 'submit', application: name }, { member });
        assert.equal(out.modalId(), null, name);
        assert.match(out.said(), pattern, name);
        assert.equal(out.isPrivate(), true, name);
        return out;
    };

    await refused(fx.alice, 'Nothing', /That application does not exist\. Use `\/apply list`/);
    await refused(fx.alice, 'Helper', /That application is currently closed\./);
    await refused(fx.alice, 'Ghost', /The role for this application no longer exists\./);
    fx.bob.roles.cache.set(fx.staff.id, fx.staff);
    await refused(fx.bob, 'Staff', /You already have the role this application is for\./);

    const first = await fx.applyFor(fx.alice, 'Staff', ['a', 'b', 'c']);
    await refused(fx.alice, 'Staff', new RegExp(`You already have a pending application \\(\`${first.application.id}\`\\)`));

    // Decided an hour ago: the wait counts from the submission, and says when it ends.
    const now = Date.now();
    await oldRow(fx, idAt(now - 3_600_000), fx.carol, { status: 'denied', reviewedAt: new Date(now).toISOString() });
    const soon = await refused(fx.carol, 'Staff', /You applied recently\. You can submit another application <t:(\d+):R>\./);
    assert.equal(Number(soon.said().match(/<t:(\d+):R>/)[1]), Math.floor((now - 3_600_000 + DAY) / 1000));

    await fx.seed('settings', { enabled: false });
    await refused(fx.carol, 'Staff', /Applications are currently disabled in this server\./);
    assert.equal((await fx.applications()).length, 2, 'only what was really submitted');
});

// ---- submitting -----------------------------------------------------------------------------

test('a submission is stored as typed, confirmed privately with its id, and short answers are fine', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Name?', 'Age?', 'Why?'] }] });
    const before = Date.now();
    const { sent, application } = await fx.applyFor(fx.alice, 'Staff', ['Budi', '17', ' first line\r\nsecond *line*\u0007\n\n\n\nlast [x](https://example.invalid) ']);

    assert.equal(sent.error, null);
    assert.equal(sent.embed().title, 'Application Submitted');
    assert.match(sent.said(), new RegExp(`Your application for \\*\\*Staff\\*\\* has been stored\\.\\n\\nApplication ID: \`${application.id}\``));
    assert.match(sent.said(), /You can apply again <t:\d+:R>, once this application has been reviewed\./);
    assert.equal(sent.isPrivate(), true);

    const rows = await fx.stored();
    const row = rows[application.id];
    assert.match(application.id, /^\d{13}-[0-9a-f]{10}$/);
    assert.ok(row.createdAt >= before && row.createdAt <= Date.now());
    assert.deepEqual(row, {
        id: application.id, guildId, userId: fx.alice.id, username: fx.alice.user.tag, roleId: fx.staff.id, roleName: 'Staff',
        answers: [
            { question: 'Name?', answer: 'Budi' }, { question: 'Age?', answer: '17' },
            { question: 'Why?', answer: 'first line\nsecond *line*\n\nlast [x](https://example.invalid)' },
        ],
        rawText: true, status: 'pending', createdAt: row.createdAt, updatedAt: row.createdAt, reviewer: null, reviewedAt: null, reviewMessage: '',
    });
    assert.equal(rows[`users:${fx.alice.id}`], undefined, 'no index row any more');

    // What the reviewer sees cannot format itself or hide a link.
    const review = await fx.command('app-admin', { subcommand: 'review', id: application.id }, { member: fx.manager });
    const answer = review.embed().fields[2].value;
    assert.equal(answer, 'first line\nsecond \\*line\\*\n\nlast \\[x](https://example.invalid)');
    assert.equal(review.isPrivate(), true);
});

test('an answer longer than a field is cut, an empty one refused, and nothing half-filled is stored', { skip }, async (t) => {
    const fx = await setup(t);
    const open = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });
    const empty = await fx.run(fx.form(open.modalId(), { q0: ' \n\t ' }, { member: fx.alice, fromMessage: false }));
    assert.match(empty.said(), /Every question needs an answer\./);
    assert.equal((await fx.applications()).length, 0);

    // 600 underscores were refused as "too long" when answers were stored escaped.
    const long = await fx.run(fx.form(open.modalId(), { q0: '_'.repeat(600) }, { member: fx.alice, fromMessage: false }));
    assert.equal(long.embed().title, 'Application Submitted');
    assert.equal((await fx.applications())[0].answers[0].answer, '_'.repeat(600));

    const other = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.bob });
    await fx.run(fx.form(other.modalId(), { q0: 'x'.repeat(LIMITS.answer + 50) }, { member: fx.bob, fromMessage: false }));
    const stored = (await fx.applications()).find((entry) => entry.userId === fx.bob.id);
    assert.equal(stored.answers[0].answer.length, LIMITS.answer);
});

test('answers are never paired with questions that changed while the form was open', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Favourite colour?', 'Favourite food?'] }] });
    const open = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });
    await fx.seed(`role:${fx.staff.id}:settings`, { questions: ['How old are you?', 'What is your home address?'] });

    const sent = await fx.run(fx.form(open.modalId(), { q0: 'Blue', q1: 'Fried rice' }, { member: fx.alice, fromMessage: false }));
    assert.match(sent.said(), /questions of this application were changed while you were filling it in\. Nothing was submitted; please run `\/apply submit` again\./);
    assert.equal((await fx.applications()).length, 0);

    // A made-up or missing mark is refused the same way.
    for (const id of [`app:apply:${fx.staff.id}:0000000000`, `app:apply:${fx.staff.id}`]) {
        const forged = await fx.run(fx.form(id, { q0: 'a', q1: 'b' }, { member: fx.alice, fromMessage: false }));
        assert.match(forged.said(), /questions of this application were changed/);
    }
    const bad = await fx.run(fx.form('app:apply:not-a-role:0000000000', { q0: 'a' }, { member: fx.alice, fromMessage: false }));
    assert.match(bad.said(), /no longer valid/);
    assert.equal((await fx.applications()).length, 0);
});

test('what changed while the form was open decides: closed, disabled, deleted, role held, role gone', { skip }, async (t) => {
    const fx = await setup(t);
    const cases = [
        [async () => fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why do you want this role?'], enabled: false }] }), /currently closed/],
        [async () => fx.seedConfig({ settings: { enabled: false }, forms: [{ role: fx.staff, name: 'Staff', questions: ['Why do you want this role?'] }] }), /currently disabled/],
        [async () => fx.seedConfig({ forms: [] }), /does not exist/],
        [async () => { fx.alice.roles.cache.set(fx.staff.id, fx.staff); }, /already have the role/],
        [async () => { fx.roles.delete(fx.staff.id); }, /no longer exists/],
    ];
    for (const [change, pattern] of cases) {
        fx.alice.roles.cache.delete(fx.staff.id);
        await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why do you want this role?'] }] });
        const open = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });
        assert.ok(open.modalId(), String(pattern));
        await change();
        const sent = await fx.run(fx.form(open.modalId(), { q0: 'Because.' }, { member: fx.alice, fromMessage: false }));
        assert.match(sent.said(), pattern);
    }
    assert.equal((await fx.applications()).length, 0);
});

test('one pending application per member, also when two forms are sent at once; the wait is per server', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }, { role: fx.helper, name: 'Helper', questions: ['Why?'] }] });
    const staff = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });
    const helper = await fx.command('apply', { subcommand: 'submit', application: 'Helper' }, { member: fx.alice });

    const both = await Promise.all([
        fx.run(fx.form(staff.modalId(), { q0: 'one' }, { member: fx.alice, fromMessage: false })),
        fx.run(fx.form(helper.modalId(), { q0: 'two' }, { member: fx.alice, fromMessage: false })),
    ]);
    const titles = both.map((out) => out.embed().title).sort();
    assert.deepEqual(titles, ['Application Submitted', 'Invalid Input']);
    assert.match(both.find((out) => out.embed().title !== 'Application Submitted').said(), /You already have a pending application/);
    assert.equal((await fx.applications()).length, 1);

    // The store decides again under the lock, whatever was checked before the form was sent.
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }, { role: fx.helper, name: 'Helper', questions: ['Why?'], enabled: false }] });
    const direct = (roleId) => createApplication(fx.client, { guildId, userId: fx.carol.id, roleId, answers: [] }).then(() => 'stored', (error) => error.code);
    assert.deepEqual([await direct(fx.helper.id), await direct(fx.reviewerRole.id), await direct('nothing')], ['APP_FORM_DISABLED', 'APP_FORM_MISSING', 'APP_INVALID']);
    assert.equal((await fx.applications()).length, 1);

    // An application in another server is not a reason to wait here.
    const elsewhere = '993456789012345678';
    await createApplication(fx.client, { guildId: elsewhere, userId: fx.bob.id, roleId: fx.staff.id, answers: [], cooldownMs: DAY })
        .then(() => assert.fail('the other server has no form'), (error) => assert.equal(error.code, 'APP_DISABLED'));
    await fx.seedRow(`guild:${elsewhere}:applications:${idAt(Date.now() - 1000)}`, { userId: fx.bob.id, roleId: fx.staff.id, status: 'approved', guildId: elsewhere });
    const bob = await fx.applyFor(fx.bob, 'Staff', ['here']);
    assert.equal(bob.sent.embed().title, 'Application Submitted');
    assert.deepEqual((await readAll(fx.client, guildId)).applications.map((entry) => entry.userId).sort(), [fx.alice.id, fx.bob.id].sort());
});

test('a submission that could not be stored says so and leaves nothing behind', { skip }, async (t) => {
    const fx = await setup(t);
    await fx.logTo(fx.reports);
    const open = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });

    fx.control.failQuery = (sql) => /INSERT/.test(sql) && /temp_data/.test(sql);
    const failed = await fx.run(fx.form(open.modalId(), { q0: 'Because.' }, { member: fx.alice, fromMessage: false }));
    assert.equal(failed.error, null);
    assert.match(failed.said(), STORAGE);
    assert.doesNotMatch(failed.said(), /Submitted/);

    fx.control.failQuery = (sql) => /COMMIT/.test(sql);
    const unsure = await fx.run(fx.form(open.modalId(), { q0: 'Because.' }, { member: fx.alice, fromMessage: false }));
    assertCommitFailureSaid(unsure.said(), /did not confirm the change\. It may or may not have been saved; please check before trying again\./, STORAGE);

    fx.control.failQuery = null;
    assert.equal((await fx.applications()).length, 0);
    assert.equal(fx.postedIn(fx.reports).length, 0, 'nothing announced that was not stored');

    // PostgreSQL not usable at all: the same answer, no request made.
    const isAvailable = fx.client.db.isAvailable;
    t.after(() => { fx.client.db.isAvailable = isAvailable; });
    fx.client.db.isAvailable = () => false;
    const down = await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice });
    assert.match(down.said(), STORAGE);
});

// ---- log channel ----------------------------------------------------------------------------

test('a new application is posted in the log channel with a Review button; the form\'s own channel comes first', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    const own = fx.makeChannel({ id: '443456789012345731', name: 'staff-apps' });
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff', questions: ['Why?'] }, { role: fx.helper, name: 'Helper *x*', questions: ['Why?'], logChannelId: own.id }] });
    await fx.logTo(fx.reports);

    const { application } = await fx.applyFor(fx.alice, 'Staff', ['Because.']);
    const [entry] = fx.postedIn(fx.reports);
    assert.equal(entry.title, 'Application Submitted');
    assert.match(entry.description, new RegExp(`> \\*\\*Applicant:\\*\\* <@${fx.alice.id}>`));
    assert.match(entry.description, new RegExp(`> \\*\\*Application ID:\\*\\* \`${application.id}\``));
    assert.deepEqual(entry.fields.map((field) => [field.name, field.value]), [['Status', 'In Progress']]);
    assert.doesNotMatch(JSON.stringify(entry), /Because\./, 'answers are not posted in the channel');
    const sent = fx.calls.send.at(-1).payload;
    assert.deepEqual(sent.components.map((row) => row.toJSON().components.map((part) => [part.custom_id, part.label])), [[[`app:open:${application.id}`, 'Review']]]);
    const row = (await fx.stored())[application.id];
    assert.equal(row.logChannelId, fx.reports.id);
    assert.ok(fx.reports.messages.cache.has(row.logMessageId));

    await fx.applyFor(fx.bob, 'Helper *x*', ['Because.']);
    assert.equal(fx.postedIn(own).length, 1);
    assert.match(fx.postedIn(own)[0].description, /> \*\*Application:\*\* Helper \\\*x\\\*/);
    assert.equal(fx.postedIn(fx.reports).length, 1);
});

test('the log entry is extra: logging off, an unusable channel or a failed post never fail the submission', { skip }, async (t) => {
    const fx = await setup(t);
    // The older place for the channel, with logging never switched on.
    await fx.seed('settings', { enabled: true, logChannelId: fx.reports.id });
    const quiet = await fx.applyFor(fx.alice, 'Staff');
    assert.equal(quiet.sent.embed().title, 'Application Submitted');
    assert.equal(fx.postedIn(fx.reports).length, 0);

    await fx.setLogging({ enabled: true, channels: {} });
    const older = await fx.applyFor(fx.bob, 'Staff');
    assert.equal(fx.postedIn(fx.reports).length, 1, 'with logging on, the older setting still decides the channel');
    assert.equal(older.sent.embed().title, 'Application Submitted');

    fx.hooks.send = async () => { throw missingPermissions(); };
    const failing = await fx.applyFor(fx.carol, 'Staff');
    assert.equal(failing.sent.error, null);
    assert.equal(failing.sent.embed().title, 'Application Submitted');
    assert.equal(failing.application.logMessageId, undefined);
    assert.equal((await fx.applications()).length, 3);

    // Not even knowing where the entry belongs fails a stored submission.
    fx.hooks.send = null;
    const attempts = fx.calls.send.length;
    fx.control.failQuery = (sql) => /SELECT config FROM/.test(sql);
    const blind = await fx.applyFor(fx.addMember(memberId(30)), 'Staff');
    fx.control.failQuery = null;
    assert.equal(blind.sent.error, null);
    assert.equal(blind.sent.embed().title, 'Application Submitted');
    assert.equal((await fx.applications()).length, 4);
    assert.equal(fx.calls.send.length, attempts, 'nothing is posted when the log settings cannot be read');
});

// ---- /apply status --------------------------------------------------------------------------

test('/apply status shows a member their own applications only, also while applications are disabled', { skip }, async (t) => {
    const fx = await setup(t);
    const now = Date.now();
    const mine = idAt(now - 5 * DAY, 'mine');
    const theirs = idAt(now - 4 * DAY, 'theirs');
    await oldRow(fx, mine, fx.alice, { status: 'approved', reviewer: fx.manager.id, reviewedAt: new Date(now - DAY).toISOString(), reviewMessage: 'Welcome @everyone *aboard*', roleName: 'Staff *1*' });
    await oldRow(fx, theirs, fx.bob);
    await fx.seed('settings', { enabled: false });

    const one = await fx.command('apply', { subcommand: 'status', id: mine }, { member: fx.alice });
    assert.equal(one.embed().title, 'Application - Staff \\*1\\*');
    assert.equal(one.embed().description, [
        `**Application ID:** \`${mine}\``, '**Status:** Accepted', `**Submitted:** <t:${Math.floor((now - 5 * DAY) / 1000)}:f>`,
        `**Reviewed:** <t:${Math.floor((now - DAY) / 1000)}:f>`, '**Note:** Welcome @everyone \\*aboard\\*',
    ].join('\n'));
    assert.equal(one.isPrivate(), true);

    const all = await fx.command('apply', { subcommand: 'status' }, { member: fx.alice });
    assert.equal(all.embed().title, 'Your Applications');
    assert.deepEqual(all.embed().fields.map((field) => field.name), ['Staff \\*1\\* (Accepted)']);
    assert.match(all.embed().fields[0].value, new RegExp(`\\*\\*ID:\\*\\* \`${mine}\`\\n\\*\\*Submitted:\\*\\* <t:\\d+:d>`));
    assert.doesNotMatch(all.said(), /theirs/);

    // Someone else's id, an id that does not exist and the names of the settings rows: one answer.
    const answers = [];
    for (const id of [theirs, idAt(now, 'nothing'), 'settings', 'roles', `role:${fx.staff.id}:settings`, `users:${fx.bob.id}`]) {
        const out = await fx.command('apply', { subcommand: 'status', id }, { member: fx.alice });
        answers.push(out.said());
        assert.equal(out.isPrivate(), true);
    }
    assert.deepEqual([...new Set(answers)], ['Invalid Input\nApplication not found. Use `/apply status` without an ID to see your applications.']);
    assert.match((await fx.command('apply', { subcommand: 'status' }, { member: fx.carol })).said(), /You have not submitted any applications yet\./);
});

test('/apply status for a member with many applications is one query, and shows the newest ten', { skip }, async (t) => {
    const fx = await setup(t);
    const now = Date.now();
    for (let n = 0; n < 12; n++) await oldRow(fx, idAt(now - (n + 1) * 60_000, `n${n}`), fx.alice, { status: 'denied', reviewedAt: new Date(now).toISOString() });
    let queries = 0;
    fx.control.delayQuery = (sql) => { if (/temp_data/.test(sql)) queries += 1; return 0; };
    const all = await fx.command('apply', { subcommand: 'status' }, { member: fx.alice });
    fx.control.delayQuery = null;
    assert.equal(queries, 1);
    assert.match(all.said(), /Showing 10 of 12 application\(s\), newest first\./);
    assert.deepEqual(all.embed().fields.map((field) => field.value.match(/-(n\d+)`/)[1]), ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
});

// ---- who may review -------------------------------------------------------------------------

test('reading and deciding applications is for Manage Server, the owner and the manager roles; everyone else is refused everywhere', { skip }, async (t) => {
    const fx = await setup(t);
    await fx.seed('settings', { enabled: true, managerRoles: [fx.reviewerRole.id] });
    const { application } = await fx.applyFor(fx.alice, 'Staff', ['My secret answer']);
    const DENIED = /You do not have permission to manage applications\./;

    for (const member of [fx.bob, fx.alice]) {
        const outs = [
            await fx.command('app-admin', { subcommand: 'review', id: application.id }, { member }),
            await fx.command('app-admin', { subcommand: 'list' }, { member }),
            await fx.run(fx.button(`app:open:${application.id}`, { member })),
            await fx.run(fx.button(`app:decide:approve:${application.id}`, { member })),
            await fx.run(fx.form(`app:verdict:approve:${application.id}`, { review_reason: '' }, { member })),
        ];
        for (const out of outs) {
            assert.doesNotMatch(JSON.stringify(out.replies), /secret answer/);
            assert.equal(out.modalId(), null);
        }
        for (const out of outs.slice(0, 4)) assert.match(out.said(), DENIED);
        assert.match(outs[4].said(), /Not reviewed\n.*do not have permission/);
    }
    assert.equal((await fx.applications())[0].status, 'pending');
    assert.equal(fx.calls.give.length, 0);

    for (const member of [fx.reviewer, fx.manager, fx.owner, fx.admin]) {
        const review = await fx.command('app-admin', { subcommand: 'review', id: application.id }, { member });
        assert.match(review.said(), /My secret answer/, member.id);
        assert.deepEqual(review.ids(), [`app:decide:approve:${application.id}`, `app:decide:deny:${application.id}`]);
        const list = await fx.command('app-admin', { subcommand: 'list' }, { member });
        assert.equal(list.embed().title, 'Submitted Applications');
        const open = await fx.run(fx.button(`app:open:${application.id}`, { member }));
        assert.match(open.said(), /My secret answer/);
        assert.equal(open.isPrivate(), true, 'opened from the log channel, shown to the reviewer only');
    }

    // A manager role reviews; it does not configure.
    for (const out of [
        await fx.command('app-admin', { subcommand: 'setup' }, { member: fx.reviewer }),
        await fx.command('app-admin', { subcommand: 'dashboard' }, { member: fx.reviewer }),
    ]) {
        assert.match(out.said(), DENIED);
        assert.equal(out.modalId(), null);
    }
    // Taking the role out of the settings ends the access.
    await fx.seed('settings', { enabled: true, managerRoles: [] });
    assert.match((await fx.command('app-admin', { subcommand: 'review', id: application.id }, { member: fx.reviewer })).said(), DENIED);
});

// ---- deciding -------------------------------------------------------------------------------

test('approving stores the decision, gives the role, tells the applicant and updates the log entry', { skip }, async (t) => {
    const fx = await setup(t);
    await fx.logTo(fx.reports);
    const { application } = await fx.applyFor(fx.alice, 'Staff');
    const before = Date.now();
    const { asked, done } = await fx.decide(fx.manager, application.id, 'approve', '  Welcome\n*aboard*  ');

    assert.deepEqual([asked.shown[0].custom_id, asked.shown[0].title], [`app:verdict:approve:${application.id}`, 'Approve Application - Reason']);
    assert.equal(asked.shown[0].components[0].components[0].required, false);
    assert.equal(done.error, null);
    assert.equal(done.embed().title, 'Application approved');
    assert.equal(done.embed().description, `The application of <@${fx.alice.id}> has been **approved** and <@&${fx.staff.id}> was given.\n<@${fx.alice.id}> was told by direct message.`);
    assert.deepEqual(done.replies.at(-1).components, [], 'the buttons are gone from the review');

    const row = (await fx.stored())[application.id];
    assert.deepEqual([row.status, row.reviewer, row.reviewMessage, row.roleGranted], ['approved', fx.manager.id, 'Welcome *aboard*', true]);
    assert.ok(Date.parse(row.reviewedAt) >= before);
    assert.deepEqual(fx.calls.give.map((call) => [call.userId, call.roleId]), [[fx.alice.id, fx.staff.id]]);
    assert.match(fx.calls.give[0].reason, new RegExp(`Application ${application.id} approved by ${fx.manager.id}`));
    assert.ok(fx.alice.roles.cache.has(fx.staff.id));

    assert.equal(fx.dms.length, 1);
    assert.deepEqual([fx.dms[0].userId, fx.dms[0].embed.title], [fx.alice.id, 'Application Accepted']);
    assert.equal(fx.dms[0].embed.description, 'Your application for **Staff** in **Home** has been **approved**.\nYou have been given the role.\n**Note:** Welcome \\*aboard\\*');

    // The entry in the log channel now shows the decision and has no button left.
    const message = fx.reports.messages.cache.get(row.logMessageId);
    assert.deepEqual(message.embeds[0].fields.map((field) => [field.name, field.value]), [['Status', `Accepted · by <@${fx.manager.id}>`]]);
    assert.deepEqual(message.components, []);
    assert.equal(fx.postedIn(fx.reports).length, 1, 'no second entry');

    // Decided is decided: the review shows it without buttons, and a late press changes nothing.
    const again = await fx.command('app-admin', { subcommand: 'review', id: application.id }, { member: fx.admin });
    assert.match(again.said(), new RegExp(`\\*\\*Status:\\*\\* Accepted · by <@${fx.manager.id}>`));
    assert.deepEqual(again.ids(), []);
    const late = await fx.decide(fx.admin, application.id, 'deny');
    assert.equal(late.done, null);
    assert.match(late.asked.said(), new RegExp(`This application was already approved by <@${fx.manager.id}>\\.`));
    const forged = await fx.run(fx.form(`app:verdict:deny:${application.id}`, { review_reason: '' }, { member: fx.admin }));
    assert.match(forged.said(), /Not reviewed\n.*already approved/);
    assert.equal((await fx.applications())[0].status, 'approved');
    assert.equal(fx.dms.length, 1);
});

test('denying gives no role; the note reaches the applicant as ordinary text; without a log entry the decision gets one', { skip }, async (t) => {
    const fx = await setup(t);
    const { application } = await fx.applyFor(fx.alice, 'Staff');
    await fx.logTo(fx.reports); // switched on after the application was posted nowhere
    const errors = [];
    t.mock.method(logger, 'error', (...args) => { errors.push(args[0]); });
    const { done } = await fx.decide(fx.manager, application.id, 'deny', 'Not yet @everyone [docs](https://example.invalid)');
    logger.error.mock.restore();

    assert.deepEqual(errors, [], 'a denial attempts no role change, so it reports no failed one');
    assert.equal(done.embed().title, 'Application denied');
    assert.match(done.said(), new RegExp(`The application of <@${fx.alice.id}> for \\*\\*Staff\\*\\* has been \\*\\*denied\\*\\*\\.`));
    const row = (await fx.stored())[application.id];
    assert.deepEqual([row.status, 'roleGranted' in row], ['denied', false]);
    assert.equal(fx.calls.give.length, 0);
    assert.equal(fx.dms[0].embed.title, 'Application Denied');
    assert.equal(fx.dms[0].embed.description, 'Your application for **Staff** in **Home** has been **denied**.\n**Note:** Not yet @everyone \\[docs](https://example.invalid)');

    const [entry] = fx.postedIn(fx.reports);
    assert.equal(entry.title, 'Application Reviewed');
    assert.match(entry.description, new RegExp(`> \\*\\*Reviewer:\\*\\* <@${fx.manager.id}>`));
    assert.deepEqual(entry.fields.map((field) => field.value), ['Denied']);

    // Denied members wait from their submission, like everyone.
    assert.match((await fx.command('apply', { subcommand: 'submit', application: 'Staff' }, { member: fx.alice })).said(), /You applied recently/);
});

test('an approval is refused, and nothing is stored, when the role cannot be given or the applicant is gone', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    await fx.seedConfig({ forms: [
        { role: fx.staff, name: 'Staff', questions: ['Why?'] }, { role: fx.aboveBot, name: 'Founder', questions: ['Why?'] }, { role: fx.booster, name: 'Booster', questions: ['Why?'] },
    ] });
    const refusedApproval = async (id, pattern) => {
        const { asked, done } = await fx.decide(fx.manager, id, 'approve');
        assert.ok(done, 'the reason form is shown; the check runs when it is sent');
        assert.equal(asked.modalId(), `app:verdict:approve:${id}`);
        assert.equal(done.embed().title, 'Not reviewed');
        assert.match(done.said(), pattern);
        assert.equal(done.isPrivate(), true);
        assert.equal((await fx.applications()).find((entry) => entry.id === id).status, 'pending');
    };

    const founder = await fx.applyFor(fx.alice, 'Founder', ['x']);
    await refusedApproval(founder.application.id, /The role is not below my highest role\. Nothing was changed\./);
    const booster = await fx.applyFor(fx.bob, 'Booster', ['x']);
    await refusedApproval(booster.application.id, /managed by an integration and cannot be given to members\. Nothing was changed\./);

    const staff = await fx.applyFor(fx.carol, 'Staff', ['x']);
    const all = fx.me.permissions;
    fx.me.permissions = new PermissionsBitField(all.bitfield & ~PermissionsBitField.Flags.ManageRoles & ~PermissionsBitField.Flags.Administrator);
    await refusedApproval(staff.application.id, /I do not have the Manage Roles permission\. Nothing was changed\./);
    fx.me.permissions = all;

    fx.hooks.fetchMember = async (id) => { if (id === fx.carol.id) throw unknownMember(); };
    await refusedApproval(staff.application.id, /The applicant is no longer in this server, so the role cannot be given\. The application is still pending; you can deny it\./);
    fx.hooks.fetchMember = async () => { throw serverError(); };
    await refusedApproval(staff.application.id, /Discord could not be asked whether the applicant is still in this server\. Nothing was changed; please try again\./);
    fx.hooks.fetchMember = null;

    fx.roles.delete(fx.staff.id);
    await refusedApproval(staff.application.id, /The role no longer exists\. Nothing was changed\./);

    assert.equal(fx.calls.give.length, 0);
    assert.equal(fx.dms.length, 0, 'nobody was told anything');
    // Such an application can still be denied.
    const denied = await fx.decide(fx.manager, staff.application.id, 'deny');
    assert.equal(denied.done.embed().title, 'Application denied');
});

test('when Discord refuses the role after the approval was stored, the reviewer and the applicant are told exactly that', { skip }, async (t) => {
    const fx = await setup(t);
    await fx.logTo(fx.reports);
    const { application } = await fx.applyFor(fx.alice, 'Staff');
    fx.hooks.giveRole = async () => { throw missingPermissions(); };
    const { done } = await fx.decide(fx.manager, application.id, 'approve');

    assert.equal(done.embed().title, 'Approved, but the role was not given');
    assert.equal(done.color(), WARNING);
    assert.match(done.said(), new RegExp(`The approval of <@${fx.alice.id}> is stored, but <@&${fx.staff.id}> could \\*\\*not\\*\\* be given\\. Discord refused: I lack the permission or the role is above mine\\.\\nPlease give the role by hand\\.`));
    const row = (await fx.stored())[application.id];
    assert.deepEqual([row.status, row.roleGranted], ['approved', false]);
    assert.ok(!fx.alice.roles.cache.has(fx.staff.id));
    assert.match(fx.dms[0].embed.description, /has been \*\*approved\*\*\.\nThe role could not be given automatically; the staff has been told to give it to you\./);
    assert.doesNotMatch(fx.dms[0].embed.description, /You have been given the role/);

    // Everywhere the application is shown, it says that the role is still missing.
    const message = fx.reports.messages.cache.get(row.logMessageId);
    assert.equal(message.embeds[0].fields[0].value, `Accepted (role not given) · by <@${fx.manager.id}>`);
    assert.match((await fx.command('apply', { subcommand: 'status', id: application.id }, { member: fx.alice })).said(), /\*\*Status:\*\* Accepted \(role not given\)/);
    assert.match((await fx.command('app-admin', { subcommand: 'list', status: 'approved' }, { member: fx.manager })).embed().fields[0].name, /Staff \(Accepted \(role not given\)\)/);

    // Another kind of failure is not described as a permission problem.
    const second = await fx.applyFor(fx.bob, 'Staff');
    fx.hooks.giveRole = async () => { throw serverError(); };
    const other = await fx.decide(fx.manager, second.application.id, 'approve');
    assert.match(other.done.said(), /could \*\*not\*\* be given\. Discord did not accept the request\./);
});

test('approve and deny pressed together: one decision is stored and carried out, the other reviewer is told who won', { skip }, async (t) => {
    const fx = await setup(t);
    const { application } = await fx.applyFor(fx.alice, 'Staff');
    const approve = await fx.run(fx.button(`app:decide:approve:${application.id}`, { member: fx.manager }));
    const deny = await fx.run(fx.button(`app:decide:deny:${application.id}`, { member: fx.admin }));
    // Both read "pending" before either writes.
    fx.control.delayQuery = (sql) => (/pg_advisory_xact_lock/.test(sql) ? 40 : 0);
    const outs = await Promise.all([
        fx.run(fx.form(approve.modalId(), { review_reason: '' }, { member: fx.manager })),
        fx.run(fx.form(deny.modalId(), { review_reason: '' }, { member: fx.admin })),
    ]);
    fx.control.delayQuery = null;

    const [stored] = await fx.applications();
    const winner = outs.find((out) => out.embed().title !== 'Not reviewed');
    const loser = outs.find((out) => out.embed().title === 'Not reviewed');
    assert.ok(winner && loser, 'exactly one decision');
    assert.equal(winner.embed().title, stored.status === 'approved' ? 'Application approved' : 'Application denied');
    assert.match(loser.said(), new RegExp(`This application was already ${stored.status} by <@${stored.reviewer}>\\.`));
    assert.equal(fx.dms.length, 1);
    assert.equal(fx.dms[0].embed.title, stored.status === 'approved' ? 'Application Accepted' : 'Application Denied');
    assert.equal(fx.calls.give.length, stored.status === 'approved' ? 1 : 0);
    assert.equal(fx.alice.roles.cache.has(fx.staff.id), stored.status === 'approved');
});

test('a decision that could not be stored gives no role, sends no message and leaves the application pending', { skip }, async (t) => {
    const fx = await setup(t);
    const { application } = await fx.applyFor(fx.alice, 'Staff');
    const asked = await fx.run(fx.button(`app:decide:approve:${application.id}`, { member: fx.manager }));

    fx.control.failQuery = (sql) => /INSERT/.test(sql) && /temp_data/.test(sql);
    const failed = await fx.run(fx.form(asked.modalId(), { review_reason: '' }, { member: fx.manager }));
    assert.equal(failed.error, null);
    assert.equal(failed.embed().title, 'Not reviewed');
    assert.match(failed.said(), STORAGE);
    fx.control.failQuery = (sql) => /COMMIT/.test(sql);
    const unsure = await fx.run(fx.form(asked.modalId(), { review_reason: '' }, { member: fx.manager }));
    assertCommitFailureSaid(unsure.said(), /did not confirm the change/, STORAGE);
    fx.control.failQuery = null;

    assert.equal((await fx.applications())[0].status, 'pending');
    assert.equal(fx.calls.give.length, 0);
    assert.equal(fx.dms.length, 0);

    // Once the role is given, a failure to note it does not undo or misreport the approval.
    let writes = 0;
    fx.control.failQuery = (sql) => /INSERT/.test(sql) && /temp_data/.test(sql) && (writes += 1) === 2;
    const done = await fx.run(fx.form(asked.modalId(), { review_reason: '' }, { member: fx.manager }));
    fx.control.failQuery = null;
    assert.equal(done.embed().title, 'Application approved');
    assert.ok(fx.alice.roles.cache.has(fx.staff.id));
    assert.match(fx.dms[0].embed.description, /You have been given the role/);
});

test('nobody decides their own application, and a closed direct message does not undo a decision', { skip }, async (t) => {
    const fx = await setup(t);
    const own = await fx.applyFor(fx.manager, 'Staff');
    const asked = await fx.run(fx.button(`app:decide:approve:${own.application.id}`, { member: fx.manager }));
    assert.equal(asked.modalId(), null);
    assert.match(asked.said(), /You cannot review your own application\./);
    const forged = await fx.run(fx.form(`app:verdict:approve:${own.application.id}`, { review_reason: '' }, { member: fx.manager }));
    assert.match(forged.said(), /Not reviewed\n.*cannot review your own application/);
    assert.equal((await fx.applications())[0].status, 'pending');
    assert.equal(fx.calls.give.length, 0);

    // Someone else can; the applicant has direct messages closed.
    fx.hooks.dm = async () => { throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }); };
    const { done } = await fx.decide(fx.admin, own.application.id, 'approve');
    assert.equal(done.embed().title, 'Application approved');
    assert.match(done.said(), new RegExp(`<@${fx.manager.id}> could \\*\\*not\\*\\* be told by direct message`));
    assert.equal((await fx.applications())[0].status, 'approved');
    assert.ok(fx.manager.roles.cache.has(fx.staff.id));
});

test('ids that are not applications are never looked up or decided', { skip }, async (t) => {
    const fx = await setup(t);
    await fx.applyFor(fx.alice, 'Staff');
    for (const id of ['settings', 'roles', `role:${fx.staff.id}:settings`, `users:${fx.alice.id}`, '', '1-', '%', `${Date.now()}-nothing`]) {
        if (!id.endsWith('-nothing')) assert.equal(isApplicationId(id), false, id);
        const review = await fx.command('app-admin', { subcommand: 'review', id }, { member: fx.manager });
        assert.match(review.said(), /^Invalid Input\nApplication not found\.$/, id);
        const open = await fx.run(fx.button(`app:open:${id}`, { member: fx.manager }));
        assert.match(open.said(), /Application not found\./, id);
        const asked = await fx.run(fx.button(`app:decide:approve:${id}`, { member: fx.manager }));
        assert.equal(asked.modalId(), null, id);
        const sent = await fx.run(fx.form(`app:verdict:approve:${id}`, { review_reason: '' }, { member: fx.manager }));
        assert.match(sent.said(), /Not reviewed\nApplication not found\./, id);
    }
    for (const bad of ['app:decide:promote:1-a', 'app:verdict:promote:1-a', 'app:unknown']) {
        const out = await fx.run(bad.startsWith('app:verdict') ? fx.form(bad, {}, { member: fx.manager }) : fx.button(bad, { member: fx.manager }));
        assert.match(out.said(), /This button or form is no longer valid\./, bad);
    }
    const rows = await fx.stored();
    assert.deepEqual(rows.settings, { enabled: true }, 'the settings row was not touched');
});

// ---- /app-admin list ------------------------------------------------------------------------

test('/app-admin list filters by status, member and role, privately, without asking Discord for members', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    await fx.seedConfig({ forms: [{ role: fx.staff, name: 'Staff' }, { role: fx.helper, name: 'Helper' }] });
    const now = Date.now();
    await oldRow(fx, idAt(now - 1000, 'a1'), fx.alice);
    await oldRow(fx, idAt(now - 2000, 'b1'), fx.bob, { roleId: fx.helper.id, roleName: 'Helper' });
    await oldRow(fx, idAt(now - 3000, 'c1'), fx.carol, { status: 'denied', reviewedAt: new Date(now).toISOString() });
    let fetches = 0;
    fx.hooks.fetchMember = async () => { fetches += 1; };
    const list = async (options) => fx.command('app-admin', { subcommand: 'list', ...options }, { member: fx.manager });
    const idsOf = (out) => (out.embed().fields ?? []).map((field) => field.value.match(/-(\w+)`/)[1]);

    const pending = await list({});
    assert.deepEqual(idsOf(pending), ['a1', 'b1']);
    assert.match(pending.said(), /Showing 2 of 2 application\(s\) \(pending\), newest first\.\nOpen one with `\/app-admin review`\./);
    assert.equal(pending.isPrivate(), true);
    assert.match(pending.embed().fields[0].value, new RegExp(`\\*\\*User:\\*\\* <@${fx.alice.id}>\\n\\*\\*Submitted:\\*\\* <t:\\d+:f>`));

    assert.deepEqual(idsOf(await list({ status: 'denied' })), ['c1']);
    assert.deepEqual(idsOf(await list({ user: fx.bob.user })), ['b1']);
    assert.deepEqual(idsOf(await list({ role: fx.helper.id })), ['b1']);
    assert.deepEqual(idsOf(await list({ role: `<@&${fx.helper.id}>` })), ['b1']);
    assert.deepEqual(idsOf(await list({ role: 'helper' })), ['b1']);
    assert.deepEqual(idsOf(await list({ limit: 1 })), ['a1']);
    assert.match((await list({ limit: 1 })).said(), /Showing 1 of 2/);
    assert.match((await list({ role: 'no-such-role' })).said(), /^Invalid Input\nNo pending applications found for this filter\.$/);
    assert.match((await list({ status: 'approved' })).said(), /^Invalid Input\nNo approved applications found\.$/);

    assert.equal(fetches, 0);
    assert.equal((await fx.applications()).length, 3, 'listing deletes nothing that is still kept');

    await fx.seedConfig({ forms: [] });
    assert.match((await list({ status: 'approved' })).said(), /No application is set up yet\. Use `\/app-admin setup` to create one\./);
});

// ---- retention and leaving ------------------------------------------------------------------

test('applications past the retention the server chose are not shown, and are deleted on the next list or submission', { skip }, async (t) => {
    const fx = await setup(t, { settings: { enabled: true, pendingApplicationRetentionDays: 2, reviewedApplicationRetentionDays: 5 } });
    const now = Date.now();
    const oldPending = idAt(now - 3 * DAY, 'oldpending');
    const freshPending = idAt(now - DAY, 'freshpending');
    const oldReviewed = idAt(now - 20 * DAY, 'oldreviewed');
    const freshReviewed = idAt(now - 19 * DAY, 'freshreviewed');
    await oldRow(fx, oldPending, fx.alice);
    await oldRow(fx, freshPending, fx.bob);
    // Reviewed applications count from the review, not from the submission.
    await oldRow(fx, oldReviewed, fx.carol, { status: 'denied', reviewedAt: new Date(now - 6 * DAY).toISOString() });
    await oldRow(fx, freshReviewed, fx.carol, { status: 'approved', reviewedAt: new Date(now - 4 * DAY).toISOString() });

    assert.deepEqual((await readAll(fx.client, guildId)).applications.map((entry) => entry.id), [freshPending, freshReviewed]);
    assert.match((await fx.command('apply', { subcommand: 'status', id: oldPending }, { member: fx.alice })).said(), /Application not found/);
    assert.equal((await fx.applications()).length, 4, 'reading deletes nothing');

    // Alice's expired application no longer blocks a new one; submitting removes what expired.
    const again = await fx.applyFor(fx.alice, 'Staff');
    assert.equal(again.sent.embed().title, 'Application Submitted');
    assert.deepEqual((await fx.applications()).map((entry) => entry.id).sort(), [freshPending, freshReviewed, again.application.id].sort());

    await oldRow(fx, oldPending, fx.alice, { userId: memberId(77) });
    await fx.command('app-admin', { subcommand: 'list' }, { member: fx.manager });
    for (let n = 0; n < 50 && (await fx.applications()).length > 3; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await fx.applications()).length, 3);
    assert.equal(await purgeExpired(fx.client, guildId), 0);
});

test('stored retention that is not a sensible number of days never deletes early', { skip }, async (t) => {
    const fx = await setup(t, { settings: { enabled: true, pendingApplicationRetentionDays: 0.0001, reviewedApplicationRetentionDays: 'abc' } });
    const now = Date.now();
    await oldRow(fx, idAt(now - 3 * 3_600_000, 'hours'), fx.alice);
    await oldRow(fx, idAt(now - 29 * DAY, 'reviewed'), fx.bob, { status: 'denied', reviewedAt: new Date(now - 29 * DAY).toISOString() });

    const { settings, applications } = await readAll(fx.client, guildId);
    assert.deepEqual([settings.pendingDays, settings.reviewedDays], [1, 30]);
    assert.equal(applications.length, 2);
    await fx.command('app-admin', { subcommand: 'list' }, { member: fx.manager });
    assert.equal(await purgeExpired(fx.client, guildId), 0);
    assert.equal((await fx.applications()).length, 2);
});

test('a member who leaves takes their applications with them, whatever an old index row says', { skip }, async (t) => {
    const fx = await setup(t);
    const mine = await fx.applyFor(fx.alice, 'Staff');
    const theirs = await fx.applyFor(fx.bob, 'Staff');
    await fx.seed(`users:${fx.alice.id}`, []); // an index row of an older version that lists nothing

    fx.alice.client = fx.client;
    await guildMemberRemove.execute(fx.alice);
    const rows = await fx.stored();
    assert.equal(rows[mine.application.id], undefined);
    assert.equal(rows[`users:${fx.alice.id}`], undefined);
    assert.ok(rows[theirs.application.id]);
    assert.ok(rows.settings && rows.roles);

    assert.equal(await deleteApplicationsOf(fx.client, guildId, fx.alice.id), 0);
    assert.equal(await deleteApplicationsOf(fx.client, guildId, 'settings'), 0);
    assert.equal((await fx.applications()).length, 1);

    // The leave event carries on when the applications cannot be removed.
    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    fx.bob.client = fx.client;
    await guildMemberRemove.execute(fx.bob);
    fx.control.failQuery = null;
    assert.equal((await fx.applications()).length, 1);
});

test('rows of older versions are read as they are: wrapped values, text statuses, escaped answers', { skip }, async (t) => {
    const fx = await setup(t, { forms: [] });
    await fx.seed('settings', { ok: true, value: { enabled: true, managerRoles: [fx.reviewerRole.id, 'nonsense', fx.reviewerRole.id] } });
    await fx.seed('roles', [{ roleId: fx.staff.id, name: '  Staff   team ', enabled: true }, { roleId: fx.staff.id, name: 'Twice' }, { roleId: 'x', name: 'Bad' }, 'junk']);
    const now = Date.now();
    const id = idAt(now - 1000, 'legacy');
    await oldRow(fx, id, fx.alice, { status: 'APPROVED', reviewer: fx.manager.id, updatedAt: now - 500, createdAt: new Date(now - 1000).toISOString(), answers: [{ question: 'Why?', answer: 'my\\_name is \\*Alice\\*' }, 'junk'] });
    await fx.seed(idAt(now, 'foreign'), { userId: fx.bob.id, roleId: fx.staff.id, guildId: '993456789012345678', status: 'pending' });
    await fx.seed(idAt(now, 'strange'), { userId: fx.bob.id, roleId: fx.staff.id, status: 'archived' });

    const { settings, forms, applications } = await readAll(fx.client, guildId);
    assert.deepEqual([settings.enabled, settings.managerRoles, settings.revision], [true, [fx.reviewerRole.id], 0]);
    assert.deepEqual(forms, [{ roleId: fx.staff.id, name: 'Staff team', enabled: true, questions: [], logChannelId: null }]);
    assert.deepEqual(applications.map((entry) => [entry.id, entry.status, entry.createdAt, entry.reviewedAt, entry.rawText]), [[id, 'approved', now - 1000, now - 500, false]]);

    // Escaped once when stored, shown as stored: not escaped a second time.
    const review = await fx.command('app-admin', { subcommand: 'review', id }, { member: fx.reviewer });
    assert.deepEqual(review.embed().fields.map((field) => [field.name, field.value]), [['Q1: Why?', 'my\\_name is \\*Alice\\*']]);
});
