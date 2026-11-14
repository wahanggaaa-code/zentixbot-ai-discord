import test from 'node:test';
import assert from 'node:assert/strict';
import { ComponentType, PermissionsBitField } from 'discord.js';
import {
    createReactRolesFixture, guildId, memberId, roleId, missingPermissions, serverError,
} from './helpers/reactroles-fixture.js';
import { pgEnabled, onSQLite, isRefused } from './helpers/leveling-postgres-fixture.js';
import command from '../src/commands/Reaction_roles/reactroles.js';
import messageDelete from '../src/events/messageDelete.js';
import { handleReactionRolesSelectMenu } from '../src/handlers/interactionHandlers/reactionRolesSelectMenu.js';
import { reconcileReactionRolePanelHealth } from '../src/services/panelHealthService.js';
import {
    addPanelRole, applyMemberChoice, checkPanelRole, createPanel, deletePanel, inspectPanels, panelErrorMessage, repostPanel,
} from '../src/services/reactionRoles/manage.js';
import { decodePanel, mutatePanels, readPanel, readPanels, revisionOf } from '../src/services/reactionRoles/store.js';

// Real tables on the disposable PostgreSQL; Discord is an in-memory stand-in.
const skip = !pgEnabled;
const SUCCESS = 0x57F287;
const ERROR = 0xED4245;
const WARNING = 0xFEE75C;
const code = (expected) => (error) => {
    assert.equal(error.code, expected);
    return true;
};
const tail = (ids) => ids.map((id) => id.slice(-1)).join('');
const panelReads = (sql) => /SELECT key, value FROM/.test(sql);
const panelWrites = (sql) => /INSERT INTO/.test(sql) && /temp_data/.test(sql);

async function setup(fx, extra = {}, who = {}) {
    const i = fx.command({ subcommand: 'setup', channel: fx.panelChannel, title: 'Pick roles', description: 'Choose below', role1: fx.R[1], ...extra }, who);
    await command.execute(i.it);
    return i;
}
const open = (fx, options = {}, who = {}) => fx.openDashboard(command.execute, options, who);
async function act(fx, root, value, who = {}) {
    const pressed = fx.component({ customId: `rr_opts_${guildId}`, values: [value], ...who });
    pressed.handled = await fx.press(pressed, root);
    return pressed;
}
async function button(fx, root, name, { modal, ...who } = {}) {
    const pressed = fx.component({ customId: `rr_${name}_${guildId}`, type: ComponentType.Button, modal, ...who });
    pressed.handled = await fx.press(pressed, root);
    return pressed;
}
const pickRole = (fx, prompt, role, who = {}) => fx.answer(prompt, { customId: 'rr_add_role_pick', type: ComponentType.RoleSelect, roles: [role], ...who });
const pickRemoval = (fx, prompt, id, who = {}) => fx.answer(prompt, { customId: 'rr_remove_role_pick', values: [id], ...who });
const storedRoles = async (fx, messageId) => tail((await fx.stored())[messageId]?.roles ?? []);

// ---- storage ------------------------------------------------------------------

test('panels are read from the current and the old key, in both stored forms', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const current = '830000000000000101';
    const old = '830000000000000102';
    await fx.store(current, { guildId, channelId: fx.panelChannel.id, messageId: current, roles: [roleId(1)], createdAt: '2026-01-02T00:00:00.000Z', title: ' Colours ' });
    // Written by an older version: old key, roles as an emoji → role object.
    await fx.store(old, { guildId, channelId: fx.panelChannel.id, messageId: old, roles: { '🎭': roleId(2), '🎮': roleId(3) } }, `reaction_roles:${guildId}:${old}`);
    // Not usable: no channel, and a record that names another message.
    await fx.store('830000000000000103', { roles: [roleId(1)] });
    await fx.store('830000000000000104', { channelId: fx.panelChannel.id, messageId: current, roles: [roleId(1)] });

    const { panels, rejected } = await readPanels(fx.client, guildId);
    assert.equal(rejected, 2);
    assert.deepEqual(panels.map((panel) => [panel.messageId, tail(panel.roles), panel.title ?? null]), [[old, '23', null], [current, '1', 'Colours']]);
    assert.equal(tail((await readPanel(fx.client, guildId, old)).roles), '23');
    assert.equal(await readPanel(fx.client, guildId, '830000000000000199'), null);
    assert.equal(await readPanel(fx.client, guildId, 'not-an-id'), null);

    assert.equal(decodePanel({ channelId: fx.panelChannel.id, roles: Array.from({ length: 26 }, (_, n) => roleId(n + 1)) }, guildId, current), null);
    assert.equal(decodePanel('{broken', guildId, current), null);
    assert.notEqual(revisionOf(panels[0]), revisionOf({ ...panels[0], roles: [roleId(2)] }));
});

test('a failed read is an error, never "no panels"', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    await fx.seedPanel();
    fx.control.failQuery = panelReads;
    await assert.rejects(readPanels(fx.client, guildId), /injected database failure/);
    await assert.rejects(readPanel(fx.client, guildId, '830000000000000000'), /injected database failure/);
    fx.control.failQuery = null;

    fx.client.db.db.isConnected = false;
    await assert.rejects(readPanels(fx.client, guildId), code('REACTROLES_UNAVAILABLE'));
    await assert.rejects(mutatePanels(fx.client, guildId, () => ({ write: false })), code('REACTROLES_UNAVAILABLE'));
    fx.client.db.db.isConnected = true;
});

test('a change is one transaction: the limit holds, a throw changes nothing, unreadable rows stay', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const panel = (n) => ({ guildId, channelId: fx.panelChannel.id, messageId: String(830000000000000200n + BigInt(n)), roles: [roleId(1)], createdAt: new Date(n * 1000).toISOString() });
    await fx.store('830000000000000299', { broken: true });
    const legacy = panel(1);
    await fx.store(legacy.messageId, legacy, `reaction_roles:${guildId}:${legacy.messageId}`);

    // Ten writers at once, one panel stored: only four more fit.
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => mutatePanels(fx.client, guildId, () => ({ put: [panel(n + 2)] }))));
    assert.equal(results.filter((entry) => entry.status === 'fulfilled').length, 4);
    assert.ok(results.filter((entry) => entry.status === 'rejected').every((entry) => entry.reason.code === 'REACTROLES_LIMIT'));
    assert.equal((await readPanels(fx.client, guildId)).panels.length, 5);

    // A throw inside the change rolls everything back.
    await assert.rejects(mutatePanels(fx.client, guildId, (panels) => {
        panels[0].roles.push(roleId(2));
        throw new Error('stop');
    }), /stop/);
    await assert.rejects(mutatePanels(fx.client, guildId, async () => ({ write: false })), code('REACTROLES_INVALID'));
    await assert.rejects(mutatePanels(fx.client, guildId, () => ({ put: [{ ...legacy, roles: [] }] })), code('REACTROLES_INVALID'));
    await assert.rejects(mutatePanels(fx.client, guildId, () => ({ put: [{ ...legacy, roles: ['x'] }] })), code('REACTROLES_INVALID'));
    assert.equal(tail((await readPanel(fx.client, guildId, legacy.messageId)).roles), '1');

    // Writing a panel that sat under the old key moves it to the current key.
    await mutatePanels(fx.client, guildId, (panels) => {
        const mine = panels.find((entry) => entry.messageId === legacy.messageId);
        mine.roles.push(roleId(2));
        return { put: [mine] };
    });
    const keys = (await fx.query('SELECT key FROM temp_data WHERE key LIKE $1', [`%${legacy.messageId}`])).rows.map((row) => row.key);
    assert.deepEqual(keys, [`guild:${guildId}:reaction_roles:${legacy.messageId}`]);

    // Removing one frees a place; the unreadable row was never touched.
    await mutatePanels(fx.client, guildId, () => ({ remove: [legacy.messageId], put: [panel(50)] }));
    assert.equal((await readPanels(fx.client, guildId)).panels.length, 5);
    assert.deepEqual((await fx.stored())['830000000000000299'], { broken: true });
});

test('the generic key-value layer may read panels but not write or delete them', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const key = `guild:${guildId}:reaction_roles:${message.id}`;
    assert.equal(await isRefused(fx.client.db.set(key, { roles: [] })), true);
    assert.equal(await isRefused(fx.client.db.set(`reaction_roles:${guildId}:${message.id}`, { roles: [] })), true);
    assert.equal(await isRefused(fx.client.db.delete(key)), true);
    assert.equal(await storedRoles(fx, message.id), '12');
    assert.equal(tail((await fx.client.db.get(key)).roles), '12');
});

// ---- /reactroles setup ----------------------------------------------------------

test('setup posts the panel, stores it with its text and says so', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const i = await setup(fx, { role2: fx.R[2], role3: fx.R[2] });
    const [message] = [...fx.panelChannel.messages.cache.values()];
    assert.deepEqual(fx.menuRoles(message), [fx.R[1].id, fx.R[2].id]);
    assert.equal(message.embeds[0].title, 'Pick roles');
    const stored = (await fx.stored())[message.id];
    assert.deepEqual([stored.channelId, tail(stored.roles), stored.title, stored.description], [fx.panelChannel.id, '12', 'Pick roles', 'Choose below']);
    // The role given twice is named; the panel was still created.
    assert.match(i.last(), /Panel created[\s\S]*left out[\s\S]*Role 2\*\* - This role was selected more than once/);
    assert.equal(i.colors().at(-1), WARNING);

    const plain = await setup(fx);
    assert.match(plain.last(), /^Success\n.*Reaction role panel created/);
    assert.equal(plain.colors().at(-1), SUCCESS);
});

test('setup refuses roles that must not be handed out, and names the reason', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const admin = fx.addRole(roleId(20), { name: 'Admin', position: 20, permissions: ['Administrator'] });
    const pinger = fx.addRole(roleId(21), { name: 'Pinger', position: 21, permissions: ['MentionEveryone'] });
    const managed = fx.addRole(roleId(22), { name: 'Booster', position: 22, managed: true });
    const high = fx.addRole(roleId(23), { name: 'High', position: 60 });
    const everyone = fx.roles.get(guildId);

    const i = await setup(fx, { role1: admin, role2: pinger, role3: managed, role4: high, role5: everyone });
    assert.match(i.last(), /None of the selected roles can be offered/);
    assert.match(i.last(), /Admin\*\* - It grants server management/);
    assert.match(i.last(), /Pinger\*\* - It grants server management, moderation or @everyone mention/);
    assert.match(i.last(), /Booster\*\* - It is managed/);
    assert.match(i.last(), /High\*\* - It is not below my highest role/);
    assert.match(i.last(), /@everyone\*\* - @everyone cannot be used/);
    assert.equal(fx.calls.send.length, 0);
    assert.deepEqual(await fx.stored(), {});

    // The service refuses as well, whoever calls it.
    await assert.rejects(createPanel(fx.client, fx.guild, { channel: fx.panelChannel, title: 'T', description: 'D', roles: [fx.R[1], pinger] }), (error) => {
        assert.equal(error.code, 'REACTROLES_ROLE_REFUSED');
        assert.equal(error.reason, 'ROLE_DANGEROUS');
        return true;
    });
    assert.equal(checkPanelRole(fx.guild, fx.R[1]).ok, true);
    fx.me.permissions = new PermissionsBitField([]);
    assert.equal(checkPanelRole(fx.guild, fx.R[1]).code, 'BOT_NO_MANAGE_ROLES');
});

test('a member may only offer roles below their own highest role', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const mod = fx.addMember(memberId(9), [], ['ManageRoles']);
    mod.roles.highest = fx.R[3];

    const refused = await setup(fx, { role1: fx.R[3], role2: fx.R[5] }, { member: mod });
    assert.match(refused.last(), /Role 3\*\* - It is not below your own highest role/);
    assert.match(refused.last(), /Role 5\*\* - It is not below your own highest role/);
    assert.equal(fx.calls.send.length, 0);

    const allowed = await setup(fx, { role1: fx.R[2] }, { member: mod });
    assert.match(allowed.last(), /Reaction role panel created/);
    const [message] = [...fx.panelChannel.messages.cache.values()];
    await assert.rejects(addPanelRole(fx.client, fx.guild, message.id, fx.R[4], { actor: mod }), code('REACTROLES_ROLE_REFUSED'));
    assert.equal(await storedRoles(fx, message.id), '2');

    // Without Manage Roles the command does nothing at all.
    const nobody = fx.addMember(memberId(10));
    const denied = await setup(fx, {}, { member: nobody });
    assert.match(denied.last(), /You need the \*\*Manage Roles\*\* permission/);
    const dashboard = await open(fx, {}, { member: nobody });
    assert.match(dashboard.last(), /You need the \*\*Manage Roles\*\* permission/);
    assert.equal(fx.calls.send.length, 1);
});

test('setup checks the channel and the text before anything is posted', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    fx.setBotPermissions(fx.panelChannel.id, ['ViewChannel', 'SendMessages']);
    const noEmbed = await setup(fx);
    assert.match(noEmbed.last(), /I need \*\*View Channel\*\*, \*\*Send Messages\*\* and \*\*Embed Links\*\*/);

    const elsewhere = { ...fx.panelChannel, id: '443456789012345999' };
    await assert.rejects(createPanel(fx.client, fx.guild, { channel: elsewhere, title: 'T', description: 'D', roles: [fx.R[1]] }), code('REACTROLES_CHANNEL'));
    await assert.rejects(createPanel(fx.client, fx.guild, { channel: fx.adminChannel, title: ' ', description: 'D', roles: [fx.R[1]] }), code('REACTROLES_TITLE'));
    await assert.rejects(createPanel(fx.client, fx.guild, { channel: fx.adminChannel, title: 'T', description: 'x'.repeat(2049), roles: [fx.R[1]] }), code('REACTROLES_DESCRIPTION'));
    await assert.rejects(createPanel(fx.client, fx.guild, { channel: fx.adminChannel, title: 'T', description: 'D', roles: [] }), code('REACTROLES_NO_ROLES'));
    assert.equal(fx.calls.send.length, 0);
});

test('at the limit a failed read does not let another panel through', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    for (let n = 0; n < 5; n++) await fx.seedPanel();
    fx.control.failQuery = panelReads;
    const failed = await setup(fx);
    fx.control.failQuery = null;
    assert.match(failed.last(), /could not be created\. Nothing was changed/);
    assert.equal(failed.colors().at(-1), ERROR);

    const full = await setup(fx);
    assert.match(full.last(), /maximum of 5 reaction role panels/);
    assert.equal(fx.calls.send.length, 0);
    assert.equal(Object.keys(await fx.stored()).length, 5);
});

test('a panel that cannot be saved is not reported as created and its message is removed', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    fx.control.failQuery = panelWrites;
    const failed = await setup(fx);
    assert.match(failed.last(), /could not be created\. Nothing was changed/);
    assert.doesNotMatch(failed.text(), /Success|injected/);
    assert.equal(fx.panelChannel.messages.cache.size, 0);

    // The message cannot be removed either: the reply says where it is.
    fx.hooks.deleteMessage = () => { throw missingPermissions(); };
    const left = await setup(fx);
    fx.control.failQuery = null;
    const [message] = [...fx.panelChannel.messages.cache.values()];
    assert.match(left.last(), /could not be saved and its new message could not be removed again/);
    assert.ok(left.last().includes(message.url));
    assert.deepEqual(await fx.stored(), {});
});

test('three setups at once with four panels stored: one more panel, two refusals, no stray message', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    for (let n = 0; n < 4; n++) await fx.seedPanel();
    const all = await Promise.all([setup(fx), setup(fx), setup(fx)]);
    assert.equal(all.filter((i) => /Reaction role panel created/.test(i.last())).length, 1);
    assert.equal(all.filter((i) => /maximum of 5 reaction role panels/.test(i.last())).length, 2);
    assert.equal(Object.keys(await fx.stored()).length, 5);
    assert.equal(fx.panelChannel.messages.cache.size, 5);
});

test('Discord refusing the panel message leaves nothing behind', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    fx.hooks.send = () => { throw missingPermissions(); };
    const i = await setup(fx);
    assert.match(i.last(), /Discord refused the request\. Nothing was changed/);
    assert.deepEqual(await fx.stored(), {});
});

// ---- a member's choice ----------------------------------------------------------

test('a member gets the selected roles and loses the unselected ones', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2], fx.R[3]]);
    const member = fx.addMember(memberId(1), [fx.R[2].id, fx.R[6].id]);

    const first = fx.choose(message, [fx.R[1].id, fx.R[4].id], member);
    await handleReactionRolesSelectMenu(first.it, fx.client);
    assert.deepEqual(fx.rolesOf(member.id).map((id) => id.slice(-1)), ['1', '6']);
    assert.match(first.last(), /Roles updated successfully![\s\S]*Added:\*\* \*\*Role 1\*\*[\s\S]*Removed:\*\* \*\*Role 2\*\*/);
    assert.equal(first.colors().at(-1), SUCCESS);
    // Role 4 is not on this panel and Role 6 was never part of it.
    assert.deepEqual(fx.calls.give.map((call) => call.roleId.slice(-1)), ['1']);
    assert.deepEqual(fx.calls.take.map((call) => call.roleId.slice(-1)), ['2']);
    assert.equal(fx.calls.give[0].reason, 'Reaction roles panel');

    const again = fx.choose(message, [fx.R[1].id], member);
    await handleReactionRolesSelectMenu(again.it, fx.client);
    assert.match(again.last(), /No changes were made to your roles/);
    assert.equal(fx.calls.give.length, 1);
});

test('a refused role change is reported as a failure, not as "updated successfully"', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const member = fx.addMember(memberId(1));
    fx.hooks.giveRole = (who, role) => { if (role.id === fx.R[1].id) throw missingPermissions(); };

    const none = fx.choose(message, [fx.R[1].id], member);
    await handleReactionRolesSelectMenu(none.it, fx.client);
    assert.match(none.last(), /Your roles could not be updated[\s\S]*Could not add:\*\* \*\*Role 1\*\* — Discord refused/);
    assert.doesNotMatch(none.last(), /successfully/);
    assert.equal(none.colors().at(-1), ERROR);

    const some = fx.choose(message, [fx.R[1].id, fx.R[2].id], member);
    await handleReactionRolesSelectMenu(some.it, fx.client);
    assert.match(some.last(), /Some of your roles were updated[\s\S]*Added:\*\* \*\*Role 2\*\*[\s\S]*Could not add:\*\* \*\*Role 1\*\*/);
    assert.equal(some.colors().at(-1), WARNING);
});

test('a panel role that became protected is left alone in both directions', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2], fx.R[3], fx.R[4]]);
    const holder = fx.addMember(memberId(1), [fx.R[1].id, fx.R[2].id, fx.R[3].id]);
    fx.R[1].managed = true;
    fx.R[2].permissions = new PermissionsBitField([PermissionsBitField.Flags.KickMembers]);
    fx.R[4].permissions = new PermissionsBitField([PermissionsBitField.Flags.MentionEveryone]);

    const i = fx.choose(message, [fx.R[4].id], holder);
    await handleReactionRolesSelectMenu(i.it, fx.client);
    // Only the ordinary role was taken; nothing protected was given or taken.
    assert.deepEqual(fx.calls.take.map((call) => call.roleId.slice(-1)), ['3']);
    assert.equal(fx.calls.give.length, 0);
    assert.match(i.last(), /Some of your roles were updated/);
    assert.match(i.last(), /Not changed:\*\* \*\*Role 1\*\* — It is managed/);
    assert.match(i.last(), /Not changed:\*\* \*\*Role 2\*\* — It grants server management/);
    assert.match(i.last(), /Not changed:\*\* \*\*Role 4\*\* — It grants server management/);

    // A role at or above the bot's highest role, and a bot without Manage Roles.
    fx.R[3].position = 50;
    const other = fx.addMember(memberId(2));
    const high = fx.choose(message, [fx.R[3].id], other);
    await handleReactionRolesSelectMenu(high.it, fx.client);
    assert.match(high.last(), /Your roles could not be updated[\s\S]*Role 3\*\* — It is not below my highest role/);
    fx.R[3].position = 13;
    fx.me.permissions = new PermissionsBitField([]);
    const noPermission = fx.choose(message, [fx.R[3].id], other);
    await handleReactionRolesSelectMenu(noPermission.it, fx.client);
    assert.match(noPermission.last(), /I do not have the Manage Roles permission/);
    assert.equal(fx.calls.give.length, 0);
});

test('a database problem is not answered with "no longer active"', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const member = fx.addMember(memberId(1));
    fx.control.failQuery = (sql) => /temp_data/.test(sql);
    const failed = fx.choose(message, [fx.R[1].id], member);
    await handleReactionRolesSelectMenu(failed.it, fx.client);
    fx.control.failQuery = null;
    assert.match(failed.last(), /could not be changed right now\. Nothing was changed\. Please try again/);
    assert.doesNotMatch(failed.text(), /no longer active|injected/);
    assert.equal(fx.calls.give.length, 0);

    // No record for the message: that is what "no longer active" is for.
    const stray = fx.makeMessage(fx.panelChannel, { embeds: [], components: [] });
    const inactive = fx.choose(stray, [fx.R[1].id], member);
    await handleReactionRolesSelectMenu(inactive.it, fx.client);
    assert.match(inactive.last(), /This reaction role message is no longer active/);
});

test('roles are looked up at Discord when the cache has none, and a deleted role is named', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2], fx.R[3]]);
    const member = fx.addMember(memberId(1));
    // Role 1 is not cached but exists; Role 2 was deleted; Role 3 cannot be looked up right now.
    const one = fx.R[1];
    fx.roles.delete(fx.R[1].id);
    fx.roles.delete(fx.R[2].id);
    const three = fx.R[3];
    fx.roles.delete(fx.R[3].id);
    fx.guild.roles.fetch = async (id) => {
        if (id === one.id) return one;
        if (id === three.id) throw serverError();
        throw Object.assign(new Error('Unknown Role'), { code: 10011 });
    };
    const outcome = await applyMemberChoice(fx.client, fx.guild, member, message.id, [one.id, fx.R[2].id, three.id]);
    assert.deepEqual(outcome.added.map((entry) => entry.name), ['Role 1']);
    assert.deepEqual(outcome.skipped.map((entry) => entry.reason), ['ROLE_MISSING', 'ROLE_UNKNOWN']);
    assert.equal(await applyMemberChoice(fx.client, fx.guild, member, '830000000000000999', [one.id]), null);
});

test('two quick choices of one member are applied one after the other', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2]]);
    const member = fx.addMember(memberId(1));
    const order = [];
    fx.hooks.giveRole = async (who, role) => {
        order.push(`give${role.id.slice(-1)}`);
        await new Promise((resolve) => setTimeout(resolve, 40));
        order.push(`given${role.id.slice(-1)}`);
    };
    fx.hooks.takeRole = async (who, role) => { order.push(`take${role.id.slice(-1)}`); };
    await Promise.all([
        applyMemberChoice(fx.client, fx.guild, member, message.id, [fx.R[1].id]),
        applyMemberChoice(fx.client, fx.guild, member, message.id, [fx.R[2].id]),
    ]);
    // The second choice starts after the first finished, so it sees Role 1 and takes it again.
    assert.deepEqual(order, ['give1', 'given1', 'take1', 'give2', 'given2']);
    assert.deepEqual(fx.rolesOf(member.id).map((id) => id.slice(-1)), ['2']);
});

// ---- /reactroles dashboard ------------------------------------------------------

test('two open dashboards add a role each and both are kept', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const a = await open(fx);
    const b = await open(fx);
    const promptA = await act(fx, a, 'add_role');
    const promptB = await act(fx, b, 'add_role');
    assert.deepEqual([promptA.handled, promptB.handled], [1, 1]);

    const pickA = await pickRole(fx, promptA, fx.R[3]);
    const pickB = await pickRole(fx, promptB, fx.R[4]);
    // Each pick was answered by its own dashboard only.
    assert.deepEqual([pickA.handled, pickB.handled], [1, 1]);
    assert.match(pickA.last(), /Role Added/);
    assert.match(pickB.last(), /Role Added/);
    assert.equal(await storedRoles(fx, message.id), '1234');
    assert.equal(tail(fx.menuRoles(message)), '1234');
    // The second dashboard redrew itself from the stored panel, not from its own copy.
    assert.match(b.last(), /Roles: `4 \/ 25`/);

    const duplicate = await pickRole(fx, await act(fx, a, 'add_role'), fx.R[4]);
    assert.match(duplicate.last(), /already on this panel/);
});

test('a role that is saved but not shown on the panel is reported, and Refresh draws it', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const root = await open(fx);
    fx.hooks.editMessage = () => { throw missingPermissions(); };
    const pick = await pickRole(fx, await act(fx, root, 'add_role'), fx.R[3]);
    assert.match(pick.last(), /Role Added[\s\S]*saved, but the panel message could not be updated right now\. Use \*\*Refresh Panel Message\*\*/);
    assert.equal(pick.colors().at(-1), WARNING);
    assert.equal(await storedRoles(fx, message.id), '123');
    assert.equal(tail(fx.menuRoles(message)), '12');

    fx.hooks.editMessage = null;
    const refresh = await button(fx, root, 'sync');
    assert.match(refresh.last(), /Panel Refreshed/);
    assert.equal(refresh.colors().at(-1), SUCCESS);
    assert.equal(tail(fx.menuRoles(message)), '123');
    // A panel stored before the text was kept gets it from the message it shows.
    assert.equal((await fx.stored())[message.id].title, 'Pick roles');
    assert.equal(message.embeds[0].title, 'Pick roles');
});

test('a role that cannot be saved is not reported as added and the panel is not changed', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const root = await open(fx);
    const prompt = await act(fx, root, 'add_role');
    fx.control.failQuery = panelWrites;
    const pick = await pickRole(fx, prompt, fx.R[3]);
    fx.control.failQuery = null;
    assert.match(pick.last(), /The role could not be added\. Nothing was changed/);
    assert.doesNotMatch(pick.text(), /Role Added|injected/);
    assert.equal(await storedRoles(fx, message.id), '12');
    assert.equal(tail(fx.menuRoles(message)), '12');
    assert.equal(fx.calls.edit.length, 0);
});

test('a role that must not be handed out cannot be added from the dashboard', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const root = await open(fx);
    const pinger = fx.addRole(roleId(21), { name: 'Pinger', position: 21, permissions: ['MentionEveryone'] });
    const refused = await pickRole(fx, await act(fx, root, 'add_role'), pinger);
    assert.match(refused.last(), /cannot be offered on a panel\. It grants server management, moderation or @everyone mention/);
    assert.equal(await storedRoles(fx, message.id), '12');
});

test('removing a role: a deleted role can be taken off, the last role is refused', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2]]);
    fx.roles.delete(fx.R[1].id);
    const root = await open(fx);
    assert.match(root.last(), /deleted role/);

    const prompt = await act(fx, root, 'remove_role');
    const offered = prompt.replies.at(-1).components[0].toJSON().components[0].options.map((option) => option.label);
    assert.deepEqual(offered, [`Deleted role (${fx.R[1].id})`, 'Role 2']);
    const removed = await pickRemoval(fx, prompt, fx.R[1].id);
    assert.match(removed.last(), /Role Removed/);
    assert.equal(await storedRoles(fx, message.id), '2');
    assert.equal(tail(fx.menuRoles(message)), '2');
    // With one role left the dashboard no longer offers removal …
    assert.doesNotMatch(JSON.stringify(root.replies.at(-1).components.map((row) => row.toJSON())), /remove_role/);

    // … and the service refuses it, so the panel is never deleted as a side effect.
    const { removePanelRole } = await import('../src/services/reactionRoles/manage.js');
    await assert.rejects(removePanelRole(fx.client, fx.guild, message.id, fx.R[2].id), code('REACTROLES_LAST_ROLE'));
    await assert.rejects(removePanelRole(fx.client, fx.guild, message.id, fx.R[5].id), code('REACTROLES_ROLE_NOT_ON_PANEL'));
    assert.equal(fx.panelChannel.messages.cache.has(message.id), true);
    assert.equal(fx.calls.delete.length, 0);
});

test('edit text stores the text and says when the message could not be changed', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const root = await open(fx);
    const ok = await button(fx, root, 'edit_text', { modal: { panel_title: ' New title ', panel_description: 'New text' } });
    // The modal opens with what the panel shows now.
    assert.deepEqual(ok.shown[0].components.map((row) => row.components[0].value), ['Pick roles', 'Choose below']);
    assert.match(ok.modal.last(), /Panel Updated\nThe title and description have been saved\.$/);
    assert.deepEqual([message.embeds[0].title, message.embeds[0].description], ['New title', 'New text']);
    assert.equal((await fx.stored())[message.id].title, 'New title');
    assert.equal(tail(fx.menuRoles(message)), '12');

    fx.hooks.editMessage = () => { throw missingPermissions(); };
    const failed = await button(fx, root, 'edit_text', { modal: { panel_title: 'Third', panel_description: 'Third text' } });
    assert.match(failed.modal.last(), /saved, but the panel message could not be updated right now/);
    assert.equal(failed.modal.colors().at(-1), WARNING);
    assert.equal(message.embeds[0].title, 'New title');
    assert.equal((await fx.stored())[message.id].title, 'Third');
});

test('every change from the command leaves a line in the log channel: who, which panel, which role', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    await fx.query('UPDATE guilds SET config = config || $2::jsonb WHERE id = $1', [guildId, JSON.stringify({ logging: { enabled: true, channels: { audit: fx.adminChannel.id } } })]);
    const logged = () => fx.calls.send.filter((call) => call.channelId === fx.adminChannel.id).map((call) => {
        const embed = call.payload.embeds[0].data ?? call.payload.embeds[0];
        return `${embed.title}\n${embed.description}`;
    });
    const message = await fx.seedPanel([fx.R[1], fx.R[2]], { extra: { title: 'Colours' } });
    const root = await open(fx);

    await pickRole(fx, await act(fx, root, 'add_role'), fx.R[3]);
    await pickRemoval(fx, await act(fx, root, 'remove_role'), fx.R[1].id);
    await button(fx, root, 'edit_text', { modal: { panel_title: 'Shades', panel_description: 'Pick one' } });
    // Refused changes are not logged as changes.
    await pickRole(fx, await act(fx, root, 'add_role'), fx.R[3]);

    const lines = logged();
    assert.equal(lines.length, 3);
    const who = new RegExp(`\\*\\*Source:\\*\\* /reactroles[\\s\\S]*\\*\\*By:\\*\\* <@${fx.admin.id}> \\(${fx.admin.id}\\)[\\s\\S]*\\*\\*Message:\\*\\* ${message.id}[\\s\\S]*\\*\\*Channel:\\*\\* <#${fx.panelChannel.id}>`);
    for (const line of lines) assert.match(line, who);
    assert.match(lines[0], new RegExp(`^Role Added To Reaction Role Panel\\n[\\s\\S]*\\*\\*Panel:\\*\\* Colours[\\s\\S]*\\*\\*Role:\\*\\* <@&${fx.R[3].id}>`));
    assert.match(lines[1], new RegExp(`^Role Removed From Reaction Role Panel\\n[\\s\\S]*\\*\\*Role:\\*\\* <@&${fx.R[1].id}>`));
    assert.match(lines[2], /^Reaction Role Panel Text Changed\n[\s\S]*\*\*Panel:\*\* Shades/);

    // A log channel that cannot be written to does not undo or fail the change.
    fx.hooks.send = (channel) => { if (channel.id === fx.adminChannel.id) throw missingPermissions(); };
    const added = await pickRole(fx, await act(fx, root, 'add_role'), fx.R[4]);
    fx.hooks.send = null;
    assert.match(added.last(), /Role Added/);
    assert.equal(await storedRoles(fx, message.id), '234');

    fx.panelChannel.messages.cache.delete(message.id);
    const again = await open(fx);
    await button(fx, again, 'repost');
    const [fresh] = [...fx.panelChannel.messages.cache.values()];
    assert.match(logged().at(-1), new RegExp(`^Reaction Role Panel Reposted\\n[\\s\\S]*\\*\\*Message:\\*\\* ${fresh.id}[\\s\\S]*\\*\\*Roles:\\*\\* <@&${fx.R[2].id}>, <@&${fx.R[3].id}>, <@&${fx.R[4].id}>`));
});

test('delete: nothing changes while Discord refuses or cannot be asked; a missing message is fine', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2]], { extra: { title: 'Pick roles' } });
    const root = await open(fx);

    const unticked = await button(fx, root, 'delete', { modal: { delete_confirmation: false } });
    assert.match(unticked.modal.last(), /must tick the confirmation checkbox/);
    assert.equal(fx.calls.delete.length, 0);

    fx.hooks.deleteMessage = () => { throw missingPermissions(); };
    const refused = await button(fx, root, 'delete', { modal: { delete_confirmation: true } });
    assert.match(refused.modal.last(), /Discord refused the request\. Nothing was changed/);
    assert.doesNotMatch(refused.modal.text(), /Panel Deleted/);
    assert.equal(Object.keys(await fx.stored()).length, 1);
    assert.equal(fx.panelChannel.messages.cache.has(message.id), true);
    fx.hooks.deleteMessage = null;

    fx.hooks.fetchMessage = () => { throw serverError(); };
    await assert.rejects(deletePanel(fx.client, fx.guild, message.id), code('REACTROLES_UNCERTAIN'));
    assert.equal(Object.keys(await fx.stored()).length, 1);
    assert.equal(fx.calls.delete.length, 1);
    fx.hooks.fetchMessage = null;

    // The record cannot be removed after the message is gone: said so, and a second delete finishes.
    fx.control.failQuery = (sql) => /DELETE FROM/.test(sql);
    await assert.rejects(deletePanel(fx.client, fx.guild, message.id), code('REACTROLES_RECORD_LEFT'));
    fx.control.failQuery = null;
    assert.equal(fx.panelChannel.messages.cache.has(message.id), false);
    assert.equal(Object.keys(await fx.stored()).length, 1);

    const done = await button(fx, root, 'delete', { modal: { delete_confirmation: true } });
    assert.match(done.modal.last(), /Panel Deleted\n\*\*Pick roles\*\* has been deleted/);
    assert.deepEqual(await fx.stored(), {});
    assert.match(root.last(), /No panels remain/);
    // The dashboard is closed: its buttons do nothing more.
    const late = await button(fx, root, 'delete', { modal: { delete_confirmation: true } });
    assert.equal(late.handled, 0);
});

test('every press checks Manage Roles again', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const root = await open(fx);
    const prompt = await act(fx, root, 'add_role');
    fx.admin.permissions = new PermissionsBitField([]);

    const pick = await pickRole(fx, prompt, fx.R[3]);
    assert.match(pick.last(), /no longer have the \*\*Manage Roles\*\* permission\. Nothing was changed/);
    const select = await act(fx, root, 'remove_role');
    assert.match(select.last(), /no longer have the \*\*Manage Roles\*\* permission/);
    const del = await button(fx, root, 'delete', { modal: { delete_confirmation: true } });
    assert.match(del.last(), /no longer have the \*\*Manage Roles\*\* permission/);
    assert.equal(del.shown.length, 0);
    const edit = await button(fx, root, 'edit_text', { modal: { panel_title: 'X', panel_description: 'Y' } });
    assert.equal(edit.shown.length, 0);
    const sync = await button(fx, root, 'sync');
    assert.match(sync.last(), /no longer have/);

    assert.equal(await storedRoles(fx, message.id), '12');
    assert.equal(fx.panelChannel.messages.cache.has(message.id), true);
    assert.equal(fx.calls.edit.length + fx.calls.delete.length, 0);
});

test('permission lost while a modal is open: the submit is refused', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const root = await open(fx);
    const pressed = fx.component({ customId: `rr_delete_${guildId}`, type: ComponentType.Button, modal: { delete_confirmation: true } });
    const showModal = pressed.it.showModal;
    pressed.it.showModal = async (modal) => {
        await showModal(modal);
        fx.admin.permissions = new PermissionsBitField([]);
    };
    await fx.press(pressed, root);
    assert.match(pressed.modal.last(), /no longer have the \*\*Manage Roles\*\* permission/);
    assert.equal(fx.panelChannel.messages.cache.has(message.id), true);
    assert.equal(Object.keys(await fx.stored()).length, 1);
});

test('the dashboard says when panels cannot be read, and asks which panel when there are several', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const none = await open(fx);
    assert.match(none.last(), /No reaction role panels found/);

    const a = await fx.seedPanel([fx.R[1]]);
    fx.control.failQuery = panelReads;
    const failed = await open(fx);
    fx.control.failQuery = null;
    assert.match(failed.last(), /could not be read right now/);
    assert.doesNotMatch(failed.text(), /No reaction role panels found|injected/);

    const b = await fx.seedPanel([fx.R[2]]);
    const which = await open(fx);
    assert.match(which.last(), /Multiple panels exist/);
    const chosen = await open(fx, { panel: b.id });
    assert.match(chosen.last(), /Role List: <@&600000000000000002>/);
    assert.match(chosen.last(), new RegExp(`view panel\\]\\(${b.url.replace(/[/.]/g, '\\$&')}\\)`));
    assert.ok(a.id !== b.id);
});

test('a missing panel message never moves the record onto another panel', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const a = await fx.seedPanel([fx.R[1], fx.R[2]], { extra: { title: 'Colours', description: 'Pick a colour' } });
    const b = await fx.seedPanel([fx.R[3], fx.R[4]]);
    // Gone without an event reaching the bot (bulk delete, or deleted while the bot was offline).
    fx.panelChannel.messages.cache.delete(a.id);

    const root = await open(fx, { panel: a.id });
    assert.match(root.last(), /Panel message was deleted — use \*\*Repost Panel\*\*/);
    assert.ok(root.customIds().includes(`rr_repost_${guildId}`));
    assert.equal(await storedRoles(fx, a.id), '12');
    assert.equal(await storedRoles(fx, b.id), '34');

    const repost = await button(fx, root, 'repost');
    assert.match(repost.last(), /Panel Reposted/);
    const stored = await fx.stored();
    assert.equal(Object.keys(stored).length, 2);
    assert.equal(stored[a.id], undefined);
    assert.equal(tail(stored[b.id].roles), '34');
    const fresh = [...fx.panelChannel.messages.cache.values()].find((message) => message.id !== b.id);
    assert.equal(tail(stored[fresh.id].roles), '12');
    // The reposted panel carries the stored text and roles, and the dashboard now follows the new message.
    assert.deepEqual([fresh.embeds[0].title, fresh.embeds[0].description, tail(fx.menuRoles(fresh))], ['Colours', 'Pick a colour', '12']);
    assert.match(root.last(), /Active/);
    const pick = await pickRole(fx, await act(fx, root, 'add_role'), fx.R[5]);
    assert.match(pick.last(), /Role Added/);
    assert.equal(tail(fx.menuRoles(fresh)), '125');
    assert.equal(tail(fx.menuRoles(b)), '34');
});

test('repost is refused while the message exists or cannot be checked, and cleans up after a failed save', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    await assert.rejects(repostPanel(fx.client, fx.guild, message.id), code('REACTROLES_NOT_MISSING'));
    fx.hooks.fetchMessage = () => { throw serverError(); };
    await assert.rejects(repostPanel(fx.client, fx.guild, message.id), code('REACTROLES_UNCERTAIN'));
    fx.hooks.fetchMessage = null;
    assert.equal(fx.calls.send.length, 0);

    fx.panelChannel.messages.cache.delete(message.id);
    fx.control.failQuery = panelWrites;
    await assert.rejects(repostPanel(fx.client, fx.guild, message.id), /injected database failure/);
    fx.control.failQuery = null;
    assert.equal(fx.panelChannel.messages.cache.size, 0);
    assert.equal(await storedRoles(fx, message.id), '12');

    // A panel whose roles are all gone has nothing to offer: refused with a reason, nothing posted.
    const empty = await fx.seedPanel([fx.R[5], fx.R[6]]);
    fx.panelChannel.messages.cache.delete(empty.id);
    const kept = [fx.R[5], fx.R[6]];
    for (const role of kept) fx.roles.delete(role.id);
    const sentBefore = fx.calls.send.length;
    await assert.rejects(repostPanel(fx.client, fx.guild, empty.id), (error) => {
        assert.equal(error.code, 'REACTROLES_ROLES_GONE');
        assert.match(panelErrorMessage(error, 'en', 'x'), /None of the roles on this panel exist any more/);
        assert.match(panelErrorMessage(error, 'id', 'x'), /Tidak ada lagi role panel ini/);
        return true;
    });
    assert.equal(fx.calls.send.length, sentBefore);
    for (const role of kept) fx.roles.set(role.id, role);
    await mutatePanels(fx.client, guildId, () => ({ remove: [empty.id] }));

    // Two reposts at once: one panel message stays, one record.
    const results = await Promise.allSettled([repostPanel(fx.client, fx.guild, message.id), repostPanel(fx.client, fx.guild, message.id)]);
    assert.deepEqual(results.map((entry) => entry.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((entry) => entry.status === 'rejected').reason.code, 'REACTROLES_MISSING');
    assert.equal(fx.panelChannel.messages.cache.size, 1);
    assert.deepEqual(Object.keys(await fx.stored()), [...fx.panelChannel.messages.cache.keys()]);

    // The channel is gone: nothing to repost into.
    const [current] = [...fx.panelChannel.messages.cache.keys()];
    fx.channels.delete(fx.panelChannel.id);
    await assert.rejects(repostPanel(fx.client, fx.guild, current), code('REACTROLES_CHANNEL_MISSING'));
    const { panels } = await inspectPanels(fx.client, fx.guild);
    assert.equal(panels[0].status, 'channel_missing');
    // Such a panel can still be deleted.
    await deletePanel(fx.client, fx.guild, current);
    assert.deepEqual(await fx.stored(), {});
});

// ---- events and startup ---------------------------------------------------------

test('the startup check only counts: an unreachable Discord deletes nothing', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const a = await fx.seedPanel([fx.R[1]]);
    const b = await fx.seedPanel([fx.R[2]]);
    const c = await fx.seedPanel([fx.R[3]], { channel: fx.adminChannel });
    await fx.store('830000000000000777', { broken: true });
    fx.hooks.fetchMessage = (channel, id) => { if (id === a.id) throw serverError(); };
    fx.panelChannel.messages.cache.delete(b.id);
    fx.channels.delete(fx.adminChannel.id);

    const summary = await reconcileReactionRolePanelHealth(fx.client);
    assert.deepEqual(
        [summary.scannedPanels, summary.healthyPanels, summary.deletedPanels, summary.missingChannels, summary.uncheckedPanels, summary.unreadableRecords, summary.errors],
        [3, 0, 1, 1, 1, 1, 0],
    );
    assert.equal(Object.keys(await fx.stored()).length, 4);
    assert.equal(fx.calls.send.length + fx.calls.edit.length + fx.calls.delete.length, 0);
    assert.ok(c.id);

    fx.control.failQuery = panelReads;
    const failed = await reconcileReactionRolePanelHealth(fx.client);
    fx.control.failQuery = null;
    assert.equal(failed.errors, 1);
});

test('a deleted panel message keeps its record; other people\'s messages are not looked up', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel();
    const queries = [];
    fx.control.delayQuery = (sql) => { if (/temp_data/.test(sql)) queries.push(sql); return 0; };

    await messageDelete.execute({ id: '830000000000000555', guild: fx.guild, client: fx.client, author: { id: memberId(1), bot: false }, channel: fx.panelChannel, content: 'hi', attachments: new Map(), embeds: [] });
    assert.equal(queries.length, 0);

    fx.panelChannel.messages.cache.delete(message.id);
    // Not cached when it was deleted: the author is unknown, so the record is looked up.
    await messageDelete.execute({ id: message.id, guild: fx.guild, client: fx.client, author: null, channel: fx.panelChannel, partial: true, attachments: new Map(), embeds: [] });
    // One lookup: a single statement on PostgreSQL, the current and the old key on SQLite.
    assert.equal(queries.length, onSQLite ? 2 : 1);
    fx.control.delayQuery = null;
    assert.equal(await storedRoles(fx, message.id), '12');

    const { panels } = await inspectPanels(fx.client, fx.guild);
    assert.equal(panels[0].status, 'message_missing');
});

test('autocomplete lists stored panels without asking Discord', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    await fx.seedPanel([fx.R[1]], { extra: { title: 'Colours' } });
    await fx.seedPanel([fx.R[2], fx.R[3]], { channel: fx.adminChannel });
    fx.channels.delete(fx.adminChannel.id);
    let answer = null;
    const interaction = {
        commandName: 'reactroles', guild: fx.guild, client: fx.client,
        options: { getSubcommand: () => 'dashboard' },
        respond: async (choices) => { answer = choices; },
    };
    await command.autocomplete(interaction);
    assert.deepEqual(answer.map((choice) => choice.name), ['Colours · #roles · 1 role', 'channel missing · 2 roles']);
    assert.equal(fx.calls.fetchMessage.length + fx.calls.fetchChannel.length, 0);

    fx.control.failQuery = panelReads;
    await command.autocomplete(interaction);
    fx.control.failQuery = null;
    assert.deepEqual(answer, []);
});

test('inspecting panels names every role that cannot be handed out and changes nothing', { skip }, async (t) => {
    const fx = await createReactRolesFixture(t);
    const message = await fx.seedPanel([fx.R[1], fx.R[2], fx.R[3]]);
    fx.R[2].managed = true;
    fx.roles.delete(fx.R[3].id);
    const before = JSON.stringify(await fx.stored());
    const { panels, rejected } = await inspectPanels(fx.client, fx.guild);
    assert.equal(rejected, 0);
    assert.deepEqual(panels[0].roleStates.map((state) => [state.name, state.ok, state.reason]), [
        ['Role 1', true, null], ['Role 2', false, 'ROLE_MANAGED'], [null, false, 'ROLE_MISSING'],
    ]);
    assert.deepEqual([panels[0].status, panels[0].title, panels[0].url], ['ok', 'Pick roles', message.url]);
    assert.match(panels[0].revision, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(await fx.stored()), before);
    assert.equal(fx.calls.edit.length, 0);
});
