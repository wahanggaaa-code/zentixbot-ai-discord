import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLevelingFixture, pgEnabled, guildId, adminId, channelId, member, role, onSQLite } from './helpers/leveling-postgres-fixture.js';
import { createModulesApi } from '../src/dashboard/modulesApi.js';
import { createOperationsApi } from '../src/dashboard/operationsApi.js';
import { addXp } from '../src/services/leveling/xpSystem.js';
import { getLevelingConfig } from '../src/services/leveling/leveling.js';
import {
    getRewardSyncStatus, startRewardSync, waitForRewardSync,
} from '../src/services/leveling/levelRoleSyncService.js';
import { handleRoleRewardAdd, handleRoleRewardRemove } from '../src/commands/Leveling/modules/level_dashboard.js';

const skip = !pgEnabled;
const settings = (roleRewards) => ({
    enabled: true, min: 15, max: 25, cooldown: 20, channelId, announce: false, publicLeaderboard: false, roleRewards,
});

// ---- web: reward settings ---------------------------------------------------

test('web settings show the state of each reward and refuse roles that must not be given', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1), 2: role(2), 3: role(3) } });
    fx.addRole(role(1), { name: 'Aktif' });
    fx.addRole(role(2), { name: '<b>Admin</b>', permissions: ['Administrator'] });
    // role(3) was deleted in Discord
    fx.addRole(role(4), { name: 'Tinggi', position: 70 });
    fx.addRole(role(5), { name: 'Bot lain', managed: true });
    fx.addRole(role(6), { name: 'Moderator', permissions: ['BanMembers'] });
    const req = await fx.startApi([createModulesApi]);

    const page = await req('/settings/leveling');
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.rewardRoles.map((x) => [x.level, x.ok, x.code, x.name]), [
        [1, true, null, 'Aktif'],
        [2, false, 'ROLE_DANGEROUS', '<b>Admin</b>'],
        [3, false, 'ROLE_MISSING', null],
    ]);
    assert.match(page.body.rewardRoles[1].reason, /izin pengelolaan atau moderasi/);
    assert.equal(page.body.rewardSync.running, false);

    const refused = [
        [role(2), /level 7 .*izin pengelolaan atau moderasi/],
        [role(3), /level 7 .*tidak ada di server/],
        [role(4), /level 7 .*role tertinggi bot/],
        [role(5), /level 7 .*dikelola integrasi/],
        [role(6), /level 7 .*izin pengelolaan atau moderasi/],
        [guildId, /level 7 .*@everyone/],
    ];
    for (const [id, message] of refused) {
        const answer = await req('/settings/leveling', 'PATCH', settings({ 7: id }));
        assert.equal(answer.status, 400, id);
        assert.match(answer.body.error, message);
    }
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 1: role(1), 2: role(2), 3: role(3) }, 'a refusal stores nothing');

    // The stored dangerous reward must be taken out before anything can be saved.
    assert.equal((await req('/settings/leveling', 'PATCH', settings({ 1: role(1), 2: role(2) }))).status, 400);
    assert.equal((await req('/settings/leveling', 'PATCH', settings({ 1: role(1) }))).status, 200);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 1: role(1) });

    // Without Manage Roles nothing can be a reward.
    fx.me.permissions.remove('ManageRoles');
    const noPermission = await req('/settings/leveling', 'PATCH', settings({ 1: role(1) }));
    assert.equal(noPermission.status, 400);
    assert.match(noPermission.body.error, /Manage Roles/);
});

test('web page that is out of date cannot erase a reward added from Discord', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    fx.addRole(role(1)); fx.addRole(role(2));
    const req = await fx.startApi([createModulesApi]);

    const page = await req('/settings/leveling');
    assert.match(page.body.revision, /^[0-9a-f]{24}$/);

    // While the page is open, a reward is added through /level dashboard.
    await fx.patchLeveling({ roleRewards: { 1: role(1), 2: role(2) } });

    const stale = await req('/settings/leveling', 'PATCH', { ...settings({ 1: role(1) }), revision: page.body.revision });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /sudah diubah di tempat lain.*Tidak ada yang disimpan/);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 1: role(1), 2: role(2) });

    // After a reload the same change is accepted, and the revision moves on.
    const reloaded = await req('/settings/leveling');
    assert.notEqual(reloaded.body.revision, page.body.revision);
    const saved = await req('/settings/leveling', 'PATCH', { ...settings({ 1: role(1) }), revision: reloaded.body.revision });
    assert.equal(saved.status, 200);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 1: role(1) });
    const again = await req('/settings/leveling', 'PATCH', { ...settings({ 1: role(1) }), revision: reloaded.body.revision });
    assert.equal(again.status, 409, 'the old revision is used up by the save');

    // Unchanged settings keep their revision; a malformed one is refused.
    const now = await req('/settings/leveling');
    assert.equal((await req('/settings/leveling')).body.revision, now.body.revision);
    assert.equal((await req('/settings/leveling', 'PATCH', { ...settings({}), revision: 'x' })).status, 400);
});

// ---- web: member level ------------------------------------------------------

test('web level change gives the reward roles and reports them; lowering removes nothing', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 2: role(2), 4: role(4), 6: role(6) } });
    fx.addRole(role(2)); fx.addRole(role(4));
    fx.addRole(role(6), { permissions: ['ManageRoles'] });
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 1);
    const req = await fx.startApi([createOperationsApi]);
    const post = (body) => req(`/members/${user.id}`, 'POST', body);

    const stale = await post({ type: 'level', value: 6, expected: 3, confirmed: true });
    assert.equal(stale.status, 409);
    assert.deepEqual(fx.given, [], 'a refused change gives no role');

    const raised = await post({ type: 'level', value: 6, expected: 1, confirmed: true });
    assert.equal(raised.status, 200);
    assert.deepEqual(raised.body.rewardRoles, {
        added: [{ level: 2, roleId: role(2) }, { level: 4, roleId: role(4) }],
        notGiven: [{ level: 6, roleId: role(6), code: 'ROLE_DANGEROUS' }],
    });
    assert.deepEqual(fx.rolesOf(user.id), [role(2), role(4)]);
    assert.match(fx.given[0].reason, /\(web dashboard\)/);

    const lowered = await post({ type: 'level', value: 0, expected: 6, confirmed: true });
    assert.equal(lowered.status, 200);
    assert.deepEqual(lowered.body.rewardRoles, { added: [], notGiven: [] });
    assert.deepEqual(fx.rolesOf(user.id), [role(2), role(4)]);
    assert.equal((await fx.readLevel(user.id)).level, 0);
});

// PostgreSQL only: on SQLite an award is one synchronous transaction and cannot be "in progress".
test('web level change waits for an XP award in progress instead of being overwritten', { skip: skip || onSQLite }, async (t) => {
    const fx = await createLevelingFixture(t);
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 0);
    const req = await fx.startApi([createOperationsApi]);

    const anyLevelWrite = /UPDATE user_levels\s+SET xp|INSERT INTO user_levels \(guild_id, user_id, xp, level/;
    let reached;
    const beforeWrite = new Promise((resolve) => { reached = resolve; });
    fx.control.delayQuery = (sql, params) => {
        if (!anyLevelWrite.test(sql) || params[2] !== 10) return 0;
        reached();
        return 200;
    };
    const award = addXp(fx.client, fx.guild, user, 10);
    await beforeWrite;

    const answer = await req(`/members/${user.id}`, 'POST', { type: 'level', value: 5, expected: 0, confirmed: true });
    await award;
    assert.equal(answer.status, 200);
    assert.equal((await fx.readLevel(user.id)).level, 5);
});

// ---- web: manual sync -------------------------------------------------------

test('manual sync: confirmation, one run at a time, result, pause before the next run', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: {} });
    fx.addRole(role(3));
    const first = fx.addMember(member(1));
    const second = fx.addMember(member(2));
    await fx.setLevel(first.id, 5);
    await fx.setLevel(second.id, 3);
    const req = await fx.startApi([createModulesApi]);
    const start = (body = { confirmed: true }) => req('/leveling/reward-sync', 'POST', body);

    assert.equal((await start({})).status, 400);
    assert.equal((await start({ confirmed: false })).status, 400);
    assert.equal((await req('/leveling/reward-sync', 'POST', { confirmed: true }, { csrf: false })).status, 403);

    const empty = await start();
    assert.equal(empty.status, 409);
    assert.match(empty.body.error, /Belum ada role hadiah/);

    await fx.patchLeveling({ enabled: false, roleRewards: { 3: role(3) } });
    const disabled = await start();
    assert.equal(disabled.status, 409);
    assert.match(disabled.body.error, /dinonaktifkan/);
    await fx.patchLeveling({ enabled: true });
    assert.deepEqual(fx.given, []);

    // Hold the run at the first member so a second request arrives while it works.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    fx.hooks.fetchMember = () => gate;

    const started = await start();
    assert.equal(started.status, 202);
    assert.equal(started.body.status.running, true);

    const duplicate = await start();
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.error, /masih berjalan/);
    assert.equal((await req('/leveling/reward-sync')).body.status.running, true);

    release();
    await waitForRewardSync(guildId);

    const done = (await req('/leveling/reward-sync')).body.status;
    assert.equal(done.running, false);
    assert.equal(done.failed, false);
    assert.deepEqual(done.summary, {
        scannedGuilds: 1, prunedRewardEntries: 0, missingRewardEntries: 0, unusableRewardEntries: 0,
        membersChecked: 2, rolesReAwarded: 2, errors: 0,
    });
    assert.deepEqual(fx.rolesOf(first.id), [role(3)]);
    assert.deepEqual(fx.rolesOf(second.id), [role(3)]);
    assert.match(fx.given[0].reason, /\(manual sync\)/);
    assert.equal((await req('/settings/leveling')).body.rewardSync.summary.rolesReAwarded, 2);

    const tooSoon = await start();
    assert.equal(tooSoon.status, 429);
    assert.match(tooSoon.body.error, /Tunggu satu menit/);
});

test('a manual sync that breaks is reported as failed and does not block the next run', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 3: role(3) } });
    const req = await fx.startApi([createModulesApi]);

    const otherGuild = '223456789012345678';
    const { started } = startRewardSync(fx.client, otherGuild, { run: async () => { throw new Error('boom'); } });
    assert.equal(started, true);
    const status = await waitForRewardSync(otherGuild);
    assert.deepEqual([status.running, status.failed, status.summary], [false, true, null]);
    assert.ok(status.finishedAt);

    const next = startRewardSync(fx.client, otherGuild, { run: async () => ({ rolesReAwarded: 0 }) });
    assert.equal(next.started, true);
    assert.deepEqual((await waitForRewardSync(otherGuild)).summary, { rolesReAwarded: 0 });
    assert.equal(getRewardSyncStatus('999999999999999999').running, false);
    assert.equal((await req('/leveling/reward-sync')).status, 200);
});

// ---- Discord dashboard ------------------------------------------------------

function dashboardFlow(fx, { level, roleId }) {
    const replies = [];
    const submitted = {
        id: '900000000000000001',
        user: { id: adminId },
        guildId,
        guild: fx.guild,
        customId: `level_cfg_role_reward_add_${guildId}`,
        replied: false,
        deferred: false,
        fields: {
            getTextInputValue: () => String(level),
            getField: () => ({ values: [roleId] }),
        },
        reply: async (payload) => { replies.push(payload); submitted.replied = true; },
        followUp: async (payload) => { replies.push(payload); },
        editReply: async (payload) => { replies.push(payload); },
    };
    const select = {
        id: '900000000000000002',
        user: { id: adminId },
        guildId,
        replied: false,
        deferred: false,
        showModal: async () => {},
        awaitModalSubmit: async () => submitted,
        deferUpdate: async () => { select.deferred = true; },
        followUp: async (payload) => { replies.push(payload); },
        editReply: async (payload) => { replies.push(payload); },
    };
    const root = {
        id: '900000000000000003',
        user: { id: adminId },
        guildId,
        guild: fx.guild,
        replied: true,
        deferred: true,
        editReply: async () => {},
    };
    const text = () => replies.map((payload) => {
        const embed = payload.embeds?.[0];
        const data = embed?.data ?? embed ?? {};
        return `${data.title ?? ''} ${data.description ?? ''}`;
    }).join('\n');
    return { submitted, select, root, text };
}

test('Discord dashboard refuses a reward role that grants server control', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: {} });
    fx.addRole(role(1));
    fx.addRole(role(2), { permissions: ['Administrator'] });
    fx.addRole(role(3), { position: 99 });
    const cfg = await getLevelingConfig(fx.client, guildId);

    for (const [id, reason] of [[role(2), /server management or moderation/], [role(3), /highest role/], [role(8), /no longer exists/]]) {
        const flow = dashboardFlow(fx, { level: 5, roleId: id });
        await handleRoleRewardAdd(flow.select, flow.root, cfg, guildId, fx.client);
        assert.match(flow.text(), /cannot be used as a reward/);
        assert.match(flow.text(), reason);
    }
    assert.deepEqual(cfg.roleRewards, {});
    assert.deepEqual((await fx.readLeveling()).roleRewards, {});

    const good = dashboardFlow(fx, { level: 5, roleId: role(1) });
    await handleRoleRewardAdd(good.select, good.root, cfg, guildId, fx.client);
    assert.match(good.text(), /Role Reward Added/);
    assert.match(good.text(), /next level-up/);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 5: role(1) });
});

test('Discord dashboard that is out of date saves nothing and says so in the form reply', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 2: role(2) } });
    fx.addRole(role(1)); fx.addRole(role(2));
    const cfg = await getLevelingConfig(fx.client, guildId);

    // The web dashboard changes the rewards while the Discord dashboard is open.
    await fx.patchLeveling({ roleRewards: { 2: role(2), 9: role(1) } });

    const add = dashboardFlow(fx, { level: 5, roleId: role(1) });
    await handleRoleRewardAdd(add.select, add.root, cfg, guildId, fx.client);
    assert.match(add.text(), /changed somewhere else/);
    assert.deepEqual(cfg.roleRewards, { 2: role(2) }, 'the open dashboard shows what it showed before');

    const remove = dashboardFlow(fx, { level: 2, roleId: role(2) });
    await handleRoleRewardRemove(remove.select, remove.root, cfg, guildId, fx.client);
    assert.match(remove.text(), /changed somewhere else/);
    assert.deepEqual(cfg.roleRewards, { 2: role(2) });

    assert.deepEqual((await fx.readLeveling()).roleRewards, { 2: role(2), 9: role(1) });

    // After reopening, removing works and tells that members keep the role.
    const reopened = await getLevelingConfig(fx.client, guildId);
    const again = dashboardFlow(fx, { level: 2, roleId: role(2) });
    await handleRoleRewardRemove(again.select, again.root, reopened, guildId, fx.client);
    assert.match(again.text(), /Role Reward Removed/);
    assert.match(again.text(), /keep it/);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 9: role(1) });
});
