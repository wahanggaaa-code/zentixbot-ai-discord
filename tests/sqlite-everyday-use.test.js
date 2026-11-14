import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createGoodbyeApi } from '../src/dashboard/goodbyeApi.js';
import { createBirthdayApi } from '../src/dashboard/birthdayApi.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, initializeDatabase } from '../src/utils/database/wrapper.js';
import { WarningService } from '../src/services/moderation/warningService.js';
import {
    getGuildBirthdays, getWelcomeConfig, getWelcomeConfigForEditing, saveWelcomeConfig, setBirthday, updateWelcomeConfig,
} from '../src/utils/database.js';
import { addMoney, getEconomyData, removeMoney } from '../src/utils/economy.js';
import { getLevelingConfig, getUserLevelData, saveLevelingConfig, setUserLevel } from '../src/services/leveling/leveling.js';
import { getGuildConfig, updateGuildConfig } from '../src/services/config/guildConfig.js';
import { disableCommand, enableCommand, isCommandEnabled } from '../src/services/commandAccessService.js';

// A bot started the way a beginner starts it: no database setting at all. It has to pick
// SQLite, create its file, and the everyday features have to store their data and find it
// again after a restart. This goes through the real startup code, not a prepared fixture.

const ENV_KEYS = [
    'DATABASE_ENGINE', 'DATABASE_DRIVER', 'DB_TYPE', 'DATABASE_URL', 'DATABASE_PATH',
    'POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
];
const guildId = '123456789012345678';
const userId = '223456789012345678';
const moderatorId = '323456789012345678';
const channelId = '423456789012345678';

async function startLikeABeginner(t) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-everyday-'));
    const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedDb = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType, databasePath: db.databasePath };
    const cwd = process.cwd();
    const closeFile = () => { if (db.db?.sqlite?.isOpen?.()) db.db.sqlite.close(); };
    const start = async () => {
        closeFile();
        Object.assign(db, { db: null, initialized: false, useFallback: false, connectionType: 'none', databasePath: undefined });
        await initializeDatabase();
    };
    for (const key of ENV_KEYS) delete process.env[key];
    process.chdir(dir);
    t.after(() => {
        closeFile();
        process.chdir(cwd);
        Object.assign(db, savedDb);
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        rmSync(dir, { recursive: true, force: true });
    });
    await start();
    const client = {
        db,
        homeGuildId: guildId,
        commands: new Map([['ping', { data: { name: 'ping' }, category: 'Utility' }]]),
    };
    return { dir, client, restart: start };
}

test('with no database setting the bot runs on its own SQLite file and everyday features keep their data', async (t) => {
    const { dir, client, restart } = await startLikeABeginner(t);
    assert.equal(db.getStatus().connectionType, 'sqlite');
    assert.equal(db.getStatus().isDegraded, false);
    assert.ok(existsSync(join(dir, 'data', 'zentix.db')), 'the bot created its data file');

    // Moderation warnings.
    await WarningService.addWarning({ guildId, userId, moderatorId, reason: 'spam' });
    assert.equal(await WarningService.getWarningCount(guildId, userId), 1);

    // Birthdays.
    await setBirthday(client, guildId, userId, 5, 17);
    assert.deepEqual(await getGuildBirthdays(client, guildId), { [userId]: { month: 5, day: 17 } });

    // Economy: a new member starts empty, money is added and taken.
    assert.equal((await getEconomyData(client, guildId, userId)).wallet, 0);
    await addMoney(client, guildId, userId, 250);
    await removeMoney(client, guildId, userId, 50);
    assert.equal((await getEconomyData(client, guildId, userId)).wallet, 200);
    assert.deepEqual(await db.list(`guild:${guildId}:economy:`), [`guild:${guildId}:economy:${userId}`]);

    // Levels and their settings.
    assert.equal((await getUserLevelData(client, guildId, userId)).level, 0);
    await setUserLevel(client, guildId, userId, 3);
    await saveLevelingConfig(client, guildId, { ...(await getLevelingConfig(client, guildId)), xpCooldown: 33 });
    assert.equal((await getLevelingConfig(client, guildId)).xpCooldown, 33);

    // Server settings and switching a command off and on.
    await updateGuildConfig(client, guildId, { prefix: '?' });
    assert.deepEqual(await disableCommand(client, guildId, 'ping'), { commandName: 'ping', enabled: false });
    assert.equal(await isCommandEnabled(client, guildId, 'ping', 'Utility'), false);
    await enableCommand(client, guildId, 'ping');
    assert.equal(await isCommandEnabled(client, guildId, 'ping', 'Utility'), true);

    // The bot is stopped and started again: nothing is lost.
    await restart();
    assert.equal(await WarningService.getWarningCount(guildId, userId), 1);
    assert.deepEqual(await getGuildBirthdays(client, guildId), { [userId]: { month: 5, day: 17 } });
    assert.equal((await getEconomyData(client, guildId, userId)).wallet, 200);
    const level = await getUserLevelData(client, guildId, userId);
    assert.equal(level.level, 3);
    assert.equal((await getLevelingConfig(client, guildId)).xpCooldown, 33);
    assert.equal((await getGuildConfig(client, guildId)).prefix, '?');
});

test('welcome, goodbye and autorole settings can be changed from commands on SQLite', async (t) => {
    const { client, restart } = await startLikeABeginner(t);

    // /welcome, /goodbye and /autorole change a few fields.
    await updateWelcomeConfig(client, guildId, { enabled: true, channelId });
    assert.equal((await getWelcomeConfig(client, guildId)).channelId, channelId);

    // The settings menu loads everything, edits, and saves; twice with the same loaded object.
    const editing = await getWelcomeConfigForEditing(client, guildId);
    editing.welcomeMessage = 'Halo {user}';
    await saveWelcomeConfig(client, guildId, editing);
    editing.goodbyeEnabled = true;
    await saveWelcomeConfig(client, guildId, editing);
    let stored = await getWelcomeConfig(client, guildId);
    assert.equal(stored.welcomeMessage, 'Halo {user}');
    assert.equal(stored.goodbyeEnabled, true);
    assert.equal(stored.channelId, channelId, 'fields the menu did not touch are kept');

    // A menu left open while someone else changed the settings must not overwrite them.
    const stale = await getWelcomeConfigForEditing(client, guildId);
    await updateWelcomeConfig(client, guildId, { welcomeMessage: 'changed elsewhere' });
    stale.welcomeMessage = 'old menu';
    await assert.rejects(saveWelcomeConfig(client, guildId, stale), /Stale welcome configuration/);
    // A full save without having loaded the settings first is refused too.
    await assert.rejects(saveWelcomeConfig(client, guildId, { enabled: false }), /Welcome snapshot required/);
    stored = await getWelcomeConfig(client, guildId);
    assert.equal(stored.welcomeMessage, 'changed elsewhere');
    assert.equal(stored.enabled, true);

    await restart();
    stored = await getWelcomeConfig(client, guildId);
    assert.equal(stored.welcomeMessage, 'changed elsewhere');
    assert.equal(stored.channelId, channelId);

    // With the file closed nothing pretends to work.
    db.db.sqlite.close();
    await assert.rejects(updateWelcomeConfig(client, guildId, { enabled: false }));
    await assert.rejects(getWelcomeConfigForEditing(client, guildId));
});

test('the dashboard pages Goodbye and Birthday save on SQLite and refuse a stale save', async (t) => {
    const { client } = await startLikeABeginner(t);
    const channel = { id: channelId, name: 'leaves', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) };
    const member = { id: userId, user: { id: userId, username: 'tester', bot: false }, permissions: { has: (p) => p === PermissionFlagsBits.Administrator } };
    const guild = {
        id: guildId, name: 'Home', ownerId: '999999999999999999', roles: { cache: new Map() },
        channels: { cache: new Map([[channelId, channel]]) },
        members: { me: {}, cache: new Map([[userId, member]]), fetch: async () => member },
    };
    Object.assign(client, { isReady: () => true, guilds: { cache: new Map([[guildId, guild]]) } });
    const auth = (req, res, next) => { req.guild = guild; req.session = { user: { id: userId } }; next(); };
    const csrf = (req, res, next) => next();
    const app = express();
    app.use('/api', createGoodbyeApi(client, { auth, csrf }));
    app.use('/api', createBirthdayApi(client, { auth, csrf }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const call = async (path, method = 'GET', body) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
            method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
    };

    // Goodbye. A bot command wrote welcome settings first; the page must keep them.
    await updateWelcomeConfig(client, guildId, { welcomeMessage: 'Welcome stays', custom: { x: 1 }, leaveEmbed: { title: 'Old', footer: 'Old', color: 42, extra: 'keep' } });
    const before = await call('/goodbye');
    assert.equal(before.status, 200);
    assert.equal(before.body.goodbye.title, 'Old');
    const form = (revision) => ({ revision, enabled: true, channelId, message: 'Goodbye {user}', ping: false, image: null, title: 'Goodbye', footer: 'From {server}', color: 0xed4245 });
    const saved = await call('/goodbye', 'PATCH', form(before.body.revision));
    assert.equal(saved.status, 200);
    assert.notEqual(saved.body.revision, before.body.revision);
    assert.equal((await call('/goodbye', 'PATCH', form(before.body.revision))).status, 409, 'the old revision is refused');
    const stored = db.db.sqlite.botGet(`guild:${guildId}:welcome`);
    assert.equal(stored.welcomeMessage, 'Welcome stays');
    assert.deepEqual(stored.custom, { x: 1 });
    assert.deepEqual(stored.leaveEmbed, { title: 'Goodbye', footer: 'From {server}', color: 0xed4245, extra: 'keep' });
    const again = await call('/goodbye');
    assert.equal(again.body.goodbye.enabled, true);
    assert.equal(again.body.goodbye.channelId, channelId);
    assert.equal(again.body.revision, saved.body.revision);

    // Birthday: the channel, then one member's date.
    assert.deepEqual((await call('/birthday/settings')).body.channelId, null);
    assert.equal((await call('/birthday/settings', 'PATCH', { channelId, expectedChannelId: null })).status, 200);
    assert.equal((await call('/birthday/settings', 'PATCH', { channelId, expectedChannelId: null })).status, 409, 'the channel changed since the page loaded');
    assert.equal((await call('/birthday/settings')).body.channelId, channelId);
    assert.equal((await call('/birthday/member', 'POST', { userId, month: 5, day: 17, confirmed: true })).status, 200);
    assert.deepEqual((await call('/birthday/list')).body.birthdays, [{ userId, month: 5, day: 17 }]);
    assert.equal((await call(`/birthday/member/${userId}`)).body.hasBirthday, true);
    assert.deepEqual(await getGuildBirthdays(client, guildId), { [userId]: { month: 5, day: 17 } });

    // With the file closed both pages answer 503 and say so.
    db.db.sqlite.close();
    assert.equal((await call('/goodbye')).status, 503);
    assert.equal((await call('/birthday/settings', 'PATCH', { channelId: null, expectedChannelId: channelId })).status, 503);
});

test('the whole bot starts in production mode with only the Discord values set, on a SQLite file it creates', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'zentix-boot-'));
    const app = fileURLToPath(new URL('../src/app.js', import.meta.url));
    const port = 20000 + Math.floor(Math.random() * 20000);
    // An empty working directory keeps a developer's own .env out of the run. The token is not
    // valid, so the run ends at the Discord login; everything before it is the real startup.
    const start = (extra = {}) => spawnSync(process.execPath, [app], {
        encoding: 'utf8', timeout: 60000, cwd,
        env: {
            PATH: process.env.PATH, NODE_ENV: 'production', LOG_LEVEL: 'info', NO_COLOR: '1', WEB_PORT: String(port),
            DISCORD_TOKEN: 'invalid.token.value', CLIENT_ID: '456789012345678901', GUILD_ID: '123456789012345678', ...extra,
        },
    });
    try {
        const run = start();
        const lines = run.stdout.split('\n').filter(Boolean).map((line) => line.slice(10));
        const file = join(cwd, 'data', 'zentix.db');
        assert.ok(lines.some((line) => line.startsWith(`START  Database: SQLite, data is kept in the file `) && line.includes(join('data', 'zentix.db'))), run.stdout + run.stderr);
        assert.ok(lines.includes('START  Discord: logging in...'), 'startup reaches the Discord login');
        assert.ok(lines.some((line) => /^START  Commands: \d+ loaded/.test(line)));
        assert.equal(lines.some((line) => /PostgreSQL .*required/.test(line)), false, 'no PostgreSQL setting is demanded');
        assert.ok(existsSync(file), 'the data file exists after the first start');

        // Settings that point at both databases stop the bot with a reason instead of guessing.
        const both = start({ DATABASE_PATH: file, POSTGRES_URL: 'postgresql://user:secret@127.0.0.1:1/none' });
        assert.notEqual(both.status, 0);
        assert.match(both.stdout + both.stderr, /DATABASE_ENGINE/);
        assert.equal((both.stdout + both.stderr).includes('Discord: logging in...'), false);
        assert.equal((both.stdout + both.stderr).includes('secret'), false, 'the password is not printed');
    } finally {
        rmSync(cwd, { recursive: true, force: true });
    }
});
