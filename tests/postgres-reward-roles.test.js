import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLevelingFixture, pgEnabled, guildId, member, role, missingPermissions, unknownRole,
} from './helpers/leveling-postgres-fixture.js';
import { addXp } from '../src/services/leveling/xpSystem.js';
import {
    addLevels, removeLevels, setUserLevel, getUserLevelData, getXpForLevel,
    getLevelingConfig, saveLevelingConfig, deleteUserLevelData,
} from '../src/services/leveling/leveling.js';
import { checkRewardRole, syncMemberRewardRoles } from '../src/services/leveling/rewardRoles.js';
import { reconcileLevelRoles } from '../src/services/leveling/levelRoleSyncService.js';
import levelSetCommand from '../src/commands/Leveling/levelset.js';
import levelAddCommand from '../src/commands/Leveling/leveladd.js';
import levelRemoveCommand from '../src/commands/Leveling/levelremove.js';
import messageCreateEvent from '../src/events/messageCreate.js';

const skip = !pgEnabled;
const levelUp = (from) => getXpForLevel(from);
const READ_LEVEL = /SELECT xp, level, total_xp, last_message, rank/;
const WRITE_LEVEL = /UPDATE user_levels\s+SET xp/;

// ---- level-up ---------------------------------------------------------------

test('level-up stores the level first, then gives every reward up to it', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1), 3: role(3), 5: role(5) } });
    fx.addRole(role(1)); fx.addRole(role(3)); fx.addRole(role(5));
    const user = fx.addMember(member(1));
    // Level 2 without the level 1 role: it was missed earlier.
    await fx.setLevel(user.id, 2);

    const seen = [];
    fx.hooks.addRole = async () => seen.push((await fx.readLevel(user.id)).level);

    const result = await addXp(fx.client, fx.guild, user, levelUp(2));
    assert.equal(result.level, 3);
    assert.equal(result.leveledUp, true);
    assert.deepEqual(fx.rolesOf(user.id), [role(1), role(3)]);
    assert.deepEqual(seen, [3, 3], 'both roles were given after level 3 was stored');
    assert.deepEqual(result.rewardRoles.added.map((x) => x.level), [1, 3]);
    assert.match(fx.given[0].reason, /Level 1 reward \(level up\)/);
});

test('a level that could not be stored gives no role', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    fx.addRole(role(1));
    const user = fx.addMember(member(1));

    fx.control.failQuery = (sql) => WRITE_LEVEL.test(sql);
    await assert.rejects(addXp(fx.client, fx.guild, user, levelUp(0)));
    fx.control.failQuery = null;

    assert.deepEqual(fx.given, []);
    assert.equal(await fx.readLevel(user.id), null, 'no half-made record is left');
});

test('a failed read never resets a member to level 0', { skip }, async (t) => {
    const fx = await createLevelingFixture(t);
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 7, { xp: 30, totalXp: 2000 });

    fx.control.failQuery = (sql) => READ_LEVEL.test(sql);
    await assert.rejects(addXp(fx.client, fx.guild, user, 20));
    await assert.rejects(getUserLevelData(fx.client, guildId, user.id));
    await assert.rejects(setUserLevel(fx.client, guildId, user.id, 1));
    fx.control.failQuery = null;

    assert.deepEqual(await fx.readLevel(user.id), { xp: 30, level: 7, totalXp: 2000 });
});

test('messages sent together: the cooldown lets exactly one earn XP', { skip }, async (t) => {
    const fx = await createLevelingFixture(t);
    const user = fx.addMember(member(1));

    const results = await Promise.all(
        Array.from({ length: 6 }, () => addXp(fx.client, fx.guild, user, 20, { cooldownMs: 60_000 })),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await fx.readLevel(user.id)).totalXp, 20);
});

test('message event: the stored cooldown decides, including a cooldown of 0', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { xpCooldown: 0, xpRange: { min: 10, max: 10 } });
    const user = fx.addMember(member(1));
    const message = () => ({
        author: { id: user.id, bot: false, tag: 'user001' },
        guild: fx.guild,
        guildId,
        member: user,
        channel: { id: '900000000000000001' },
        content: 'hello there',
    });

    // 0 means no cooldown; it used to be read as 60 seconds.
    for (let i = 0; i < 3; i += 1) await messageCreateEvent.execute(message(), fx.client);
    assert.equal((await fx.readLevel(user.id)).totalXp, 30);

    // With a cooldown, messages arriving together earn XP once.
    await fx.patchLeveling({ xpCooldown: 3600 });
    await fx.setLevel(user.id, 0);
    await Promise.all(Array.from({ length: 5 }, () => messageCreateEvent.execute(message(), fx.client)));
    assert.equal((await fx.readLevel(user.id)).totalXp, 10);
});

test('awards without a cooldown are all counted', { skip }, async (t) => {
    const fx = await createLevelingFixture(t);
    const user = fx.addMember(member(1));

    await Promise.all(Array.from({ length: 8 }, () => addXp(fx.client, fx.guild, user, 10)));
    const stored = await fx.readLevel(user.id);
    assert.equal(stored.totalXp, 80);
    assert.equal(stored.level, 1);
    assert.equal(stored.xp, 30);
});

test('a level set by staff is not overwritten by XP arriving at the same time', { skip }, async (t) => {
    const fx = await createLevelingFixture(t);
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 0);

    // The XP award has read level 0 and is held just before its write (xp = 10).
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

    // Staff sets level 10 now. It must wait for the award instead of being overwritten by it.
    await setUserLevel(fx.client, guildId, user.id, 10);
    await award;
    assert.equal((await fx.readLevel(user.id)).level, 10);
});

// ---- which roles may be given -----------------------------------------------

test('roles that must not or cannot be given are skipped, the rest is given', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, {
        roleRewards: { 1: role(1), 2: role(2), 3: role(3), 4: role(4), 5: role(5), 6: role(6) },
    });
    fx.addRole(role(1));
    fx.addRole(role(2), { permissions: ['Administrator'] });
    fx.addRole(role(3), { position: 60 });          // above the bot
    fx.addRole(role(4), { managed: true });          // owned by an integration
    // role(5) does not exist
    fx.addRole(role(6), { permissions: ['KickMembers'] });
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 5);

    const result = await addXp(fx.client, fx.guild, user, levelUp(5));
    assert.equal(result.level, 6);
    assert.deepEqual(fx.rolesOf(user.id), [role(1)]);
    assert.deepEqual(
        result.rewardRoles.skipped.map((x) => [x.level, x.code]),
        [[2, 'ROLE_DANGEROUS'], [3, 'ROLE_TOO_HIGH'], [4, 'ROLE_MANAGED'], [5, 'ROLE_MISSING'], [6, 'ROLE_DANGEROUS']],
    );
    assert.equal((await fx.readLevel(user.id)).level, 6, 'the level itself is kept');
    assert.deepEqual(Object.keys((await fx.readLeveling()).roleRewards).length, 6, 'the configuration is not pruned');
});

test('the bot without Manage Roles gives nothing and says why', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    const reward = fx.addRole(role(1));
    const user = fx.addMember(member(1));
    fx.me.permissions.remove('ManageRoles');

    assert.equal(checkRewardRole(fx.guild, reward).code, 'BOT_NO_MANAGE_ROLES');
    const result = await syncMemberRewardRoles(fx.guild, user, 3, await getLevelingConfig(fx.client, guildId));
    assert.deepEqual(result.skipped.map((x) => x.code), ['BOT_NO_MANAGE_ROLES']);
    assert.deepEqual(fx.given, []);
    assert.equal(checkRewardRole(fx.guild, fx.roles.get(guildId)).code, 'ROLE_EVERYONE');
});

test('a role Discord refused is given on the next level-up', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    fx.addRole(role(1));
    const user = fx.addMember(member(1));

    fx.hooks.addRole = async () => { throw missingPermissions(); };
    const first = await addXp(fx.client, fx.guild, user, levelUp(0));
    assert.equal(first.level, 1);
    assert.deepEqual(first.rewardRoles.failed.map((x) => x.code), ['DISCORD_ERROR']);
    assert.deepEqual(fx.rolesOf(user.id), []);
    assert.equal((await fx.readLevel(user.id)).level, 1, 'the level is not rolled back');

    fx.hooks.addRole = null;
    const second = await addXp(fx.client, fx.guild, user, levelUp(1));
    assert.equal(second.level, 2);
    assert.deepEqual(fx.rolesOf(user.id), [role(1)]);
});

test('XP without a level-up does not touch roles', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    fx.addRole(role(1));
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 3);

    let lookups = 0;
    fx.hooks.fetchRole = async () => { lookups += 1; };
    const result = await addXp(fx.client, fx.guild, user, 5);
    assert.equal(result.leveledUp, false);
    assert.equal(result.rewardRoles, null);
    assert.deepEqual(fx.given, []);
    assert.equal(lookups, 0);
});

test('disabled leveling gives neither XP nor roles', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { enabled: false, roleRewards: { 1: role(1) } });
    fx.addRole(role(1));
    const user = fx.addMember(member(1));

    assert.equal(await addXp(fx.client, fx.guild, user, 500), null);
    assert.equal(await fx.readLevel(user.id), null);
    const config = await getLevelingConfig(fx.client, guildId);
    assert.deepEqual((await syncMemberRewardRoles(fx.guild, user, 9, config)).added, []);
});

// ---- staff changes ----------------------------------------------------------

test('level commands store atomically; roles are only ever added', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 2: role(2), 4: role(4) } });
    fx.addRole(role(2)); fx.addRole(role(4));
    const user = fx.addMember(member(1));
    const config = await getLevelingConfig(fx.client, guildId);

    const added = await addLevels(fx.client, guildId, user.id, 4);
    assert.equal(added.level, 4);
    await syncMemberRewardRoles(fx.guild, user, added.level, config, { source: '/leveladd' });
    assert.deepEqual(fx.rolesOf(user.id), [role(2), role(4)]);

    const lowered = await removeLevels(fx.client, guildId, user.id, 3);
    assert.equal(lowered.level, 1);
    const after = await syncMemberRewardRoles(fx.guild, user, lowered.level, config, { source: '/levelset' });
    assert.deepEqual(after, { added: [], skipped: [], failed: [] });
    assert.deepEqual(fx.rolesOf(user.id), [role(2), role(4)], 'a demotion removes nothing');

    await assert.rejects(addLevels(fx.client, guildId, user.id, 1000), /Maximum level|exceeds/);
    assert.equal((await fx.readLevel(user.id)).level, 1, 'a refused change stores nothing');

    await deleteUserLevelData(fx.client, guildId, user.id);
    assert.equal(await fx.readLevel(user.id), null);
});

/** A slash command interaction that keeps what the bot answered. */
function commandInteraction(fx, name, target, amount) {
    const replies = [];
    const interaction = {
        id: '910000000000000001',
        commandName: name,
        user: { id: '323456789012345678', tag: 'admin' },
        member: { id: '323456789012345678', permissions: { has: () => true } },
        guild: fx.guild,
        guildId,
        deferred: false,
        replied: false,
        createdTimestamp: Date.now(),
        options: { getUser: () => target.user, getInteger: () => amount },
        deferReply: async () => { interaction.deferred = true; },
        editReply: async (payload) => { replies.push(payload); },
        reply: async (payload) => { replies.push(payload); interaction.replied = true; },
        followUp: async (payload) => { replies.push(payload); },
    };
    const text = () => replies.map((payload) => {
        const embed = payload.embeds?.[0];
        return (embed?.data ?? embed)?.description ?? '';
    }).join('\n');
    return { interaction, text };
}

test('/levelset, /leveladd and /levelremove tell what happened to reward roles', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 2: role(2), 3: role(3), 6: role(6) } });
    fx.addRole(role(2)); fx.addRole(role(6));
    fx.addRole(role(3), { permissions: ['ManageChannels'] });
    const user = fx.addMember(member(1));

    const set = commandInteraction(fx, 'levelset', user, 4);
    await levelSetCommand.execute(set.interaction, {}, fx.client);
    assert.equal((await fx.readLevel(user.id)).level, 4);
    assert.deepEqual(fx.rolesOf(user.id), [role(2)]);
    assert.match(set.text(), new RegExp(`Reward roles given:\\*\\* <@&${role(2)}>`));
    assert.match(set.text(), new RegExp(`Reward roles not given:\\*\\*\\n<@&${role(3)}> \\(level 3: .*server management`));
    assert.match(fx.given[0].reason, /\(\/levelset\)/);

    const add = commandInteraction(fx, 'leveladd', user, 2);
    await levelAddCommand.execute(add.interaction, {}, fx.client);
    assert.equal((await fx.readLevel(user.id)).level, 6);
    assert.deepEqual(fx.rolesOf(user.id), [role(2), role(6)]);
    assert.match(add.text(), new RegExp(`Reward roles given:\\*\\* <@&${role(6)}>`));

    const remove = commandInteraction(fx, 'levelremove', user, 5);
    await levelRemoveCommand.execute(remove.interaction, {}, fx.client);
    assert.equal((await fx.readLevel(user.id)).level, 1);
    assert.match(remove.text(), /Reward roles already given are not removed/);
    assert.deepEqual(fx.rolesOf(user.id), [role(2), role(6)]);

    // Nothing to report: no extra line.
    const same = commandInteraction(fx, 'levelset', user, 1);
    await levelSetCommand.execute(same.interaction, {}, fx.client);
    assert.doesNotMatch(same.text(), /Reward roles/);
});

// ---- configuration ----------------------------------------------------------

test('an open Discord dashboard cannot overwrite a newer change', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });

    // The dashboard was opened …
    const session = await getLevelingConfig(fx.client, guildId);
    // … and it can save twice in a row.
    session.announceLevelUp = true;
    await saveLevelingConfig(fx.client, guildId, session);
    session.xpCooldown = 30;
    await saveLevelingConfig(fx.client, guildId, session);
    assert.equal((await fx.readLeveling()).xpCooldown, 30);

    // Then the web dashboard adds a reward.
    await fx.patchLeveling({ roleRewards: { 1: role(1), 9: role(9) } });

    session.announceLevelUp = false;
    await assert.rejects(
        saveLevelingConfig(fx.client, guildId, session),
        (error) => error.code === 'LEVELING_CONFIG_STALE' && /changed somewhere else/.test(error.userMessage),
    );
    const stored = await fx.readLeveling();
    assert.deepEqual(stored.roleRewards, { 1: role(1), 9: role(9) });
    assert.equal(stored.announceLevelUp, true);

    // Opening the dashboard again works.
    const reopened = await getLevelingConfig(fx.client, guildId);
    reopened.announceLevelUp = false;
    await saveLevelingConfig(fx.client, guildId, reopened);
    assert.equal((await fx.readLeveling()).announceLevelUp, false);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 1: role(1), 9: role(9) });
});

test('settings that cannot be read are an error, not default settings', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    fx.control.failQuery = (sql) => /SELECT config FROM guilds/.test(sql);
    await assert.rejects(getLevelingConfig(fx.client, guildId));
    fx.control.failQuery = null;
    assert.deepEqual((await getLevelingConfig(fx.client, guildId)).roleRewards, { 1: role(1) });
});

// ---- sync -------------------------------------------------------------------

test('sync gives missing roles to members who reached the level, and nothing else', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 2: role(2), 5: role(5), 8: role(8), 9: role(9) } });
    fx.addRole(role(2)); fx.addRole(role(5));
    fx.addRole(role(8), { permissions: ['ManageGuild'] });
    // role(9) was deleted in Discord
    const extra = fx.addRole(role(77));

    const high = fx.addMember(member(1));               // level 6, no roles yet
    const mid = fx.addMember(member(2), [role(2)]);     // level 3, already has its role
    const low = fx.addMember(member(3));                // level 1, below every reward
    const demoted = fx.addMember(member(4), [role(5), extra.id]); // level 2, keeps role 5
    await fx.setLevel(high.id, 6);
    await fx.setLevel(mid.id, 3);
    await fx.setLevel(low.id, 1);
    await fx.setLevel(demoted.id, 2);
    await fx.setLevel(member(5), 9);                    // left the server

    const fetched = [];
    fx.hooks.fetchMember = async (id) => { fetched.push(id); };

    const summary = await reconcileLevelRoles(fx.client, guildId);
    assert.deepEqual(summary, {
        scannedGuilds: 1,
        prunedRewardEntries: 0,
        missingRewardEntries: 1,
        unusableRewardEntries: 1,
        membersChecked: 3,
        rolesReAwarded: 3,
        errors: 0,
    });
    assert.deepEqual(fx.rolesOf(high.id), [role(2), role(5)]);
    assert.deepEqual(fx.rolesOf(mid.id), [role(2)]);
    assert.deepEqual(fx.rolesOf(low.id), []);
    assert.deepEqual(fx.rolesOf(demoted.id), [role(2), role(5), extra.id].sort());
    assert.ok(!fetched.includes(low.id), 'members below the lowest reward are not fetched');
    assert.match(fx.given[0].reason, /\(startup sync\)/);
    assert.equal(Object.keys((await fx.readLeveling()).roleRewards).length, 4, 'rewards are never pruned');

    // Running it again changes nothing.
    const again = await reconcileLevelRoles(fx.client, guildId);
    assert.equal(again.rolesReAwarded, 0);
    assert.equal(again.errors, 0);
});

test('sync reports a failed member list and failed Discord calls as errors', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { roleRewards: { 1: role(1) } });
    fx.addRole(role(1));
    const first = fx.addMember(member(1));
    const second = fx.addMember(member(2));
    await fx.setLevel(first.id, 4);
    await fx.setLevel(second.id, 4);

    fx.control.failQuery = (sql) => /FROM user_levels WHERE guild_id = \$1 AND level >=/.test(sql);
    let summary = await reconcileLevelRoles(fx.client, guildId);
    fx.control.failQuery = null;
    assert.equal(summary.errors, 1);
    assert.equal(summary.membersChecked, 0);
    assert.deepEqual(fx.given, []);

    fx.hooks.addRole = async (target) => { if (target.id === first.id) throw missingPermissions(); };
    summary = await reconcileLevelRoles(fx.client, guildId);
    assert.equal(summary.errors, 1);
    assert.equal(summary.rolesReAwarded, 1);
    assert.deepEqual(fx.rolesOf(first.id), []);
    assert.deepEqual(fx.rolesOf(second.id), [role(1)]);

    // A role lookup that fails says nothing about the role: nothing is given, nothing is pruned.
    fx.hooks.addRole = null;
    fx.roles.delete(role(1));
    fx.hooks.fetchRole = async () => { throw new Error('gateway timeout'); };
    summary = await reconcileLevelRoles(fx.client, guildId);
    assert.equal(summary.errors, 1);
    assert.equal(summary.missingRewardEntries, 0);
    fx.hooks.fetchRole = async () => { throw unknownRole(); };
    summary = await reconcileLevelRoles(fx.client, guildId);
    assert.equal(summary.missingRewardEntries, 1);
    assert.deepEqual((await fx.readLeveling()).roleRewards, { 1: role(1) });
});

test('sync does nothing while leveling is disabled', { skip }, async (t) => {
    const fx = await createLevelingFixture(t, { enabled: false, roleRewards: { 1: role(1) } });
    fx.addRole(role(1));
    const user = fx.addMember(member(1));
    await fx.setLevel(user.id, 4);

    const summary = await reconcileLevelRoles(fx.client, guildId);
    assert.equal(summary.rolesReAwarded, 0);
    assert.equal(summary.membersChecked, 0);
    assert.deepEqual(fx.given, []);
});

// ---- backends without transactions ------------------------------------------
// Not used by a deployed bot (PostgreSQL or SQLite only), but the code path
// exists and must not announce a level it could not store.

test('key-value backend: an unsaved level gives no role; the cooldown is checked under the lock', async () => {
    const store = new Map();
    let failWrites = false;
    const client = {
        db: {
            get: async (key) => store.get(key),
            set: async (key, value) => {
                if (failWrites) return false;
                store.set(key, structuredClone(value));
                return true;
            },
        },
    };
    const reward = { id: role(1), name: 'Reward', managed: false, permissions: { has: () => false } };
    const given = [];
    const guild = {
        id: guildId,
        name: 'Home',
        roles: { cache: new Map([[reward.id, reward]]) },
        members: { me: { permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } } },
    };
    const user = {
        id: member(1),
        user: { id: member(1), tag: 'user001' },
        roles: { cache: new Map(), add: async (target) => given.push(target.id) },
    };
    store.set(`guild:${guildId}:config`, { leveling: { enabled: true, announceLevelUp: false, roleRewards: { 1: reward.id } } });

    failWrites = true;
    await assert.rejects(addXp(client, guild, user, levelUp(0)));
    assert.deepEqual(given, []);

    failWrites = false;
    const results = await Promise.all(Array.from({ length: 4 }, () => addXp(client, guild, user, levelUp(0), { cooldownMs: 60_000 })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(given, [reward.id]);
    assert.equal(store.get(`guild:${guildId}:leveling:users:${user.id}`).level, 1);
});
