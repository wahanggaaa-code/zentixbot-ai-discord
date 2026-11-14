import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, initializeDatabase } from '../src/utils/database/wrapper.js';
import { WarningService } from '../src/services/moderation/warningService.js';
import { addMoney, getEconomyData } from '../src/utils/economy.js';
import { updateWelcomeConfig, getWelcomeConfig } from '../src/utils/database.js';

// Backing up and restoring the SQLite data of a bot that runs without any database setting,
// done the way docs/hosting.md describes it: `npm run backup:db` while the bot runs, or a
// copy of the data folder while it is stopped.

const ENV_KEYS = [
    'DATABASE_ENGINE', 'DATABASE_DRIVER', 'DB_TYPE', 'DATABASE_URL', 'DATABASE_PATH', 'BACKUP_DIR',
    'POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
];
const guildId = '123456789012345678';
const userId = '223456789012345678';
const moderatorId = '323456789012345678';
const backupScript = fileURLToPath(new URL('../scripts/backup.js', import.meta.url));
// node:sqlite gained its backup function in Node 22.16.
const [major, minor] = process.versions.node.split('.').map(Number);
const canBackup = major > 22 || (major === 22 && minor >= 16);

function bot(t) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-backup-'));
    const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const savedDb = { db: db.db, initialized: db.initialized, useFallback: db.useFallback, connectionType: db.connectionType, databasePath: db.databasePath };
    const cwd = process.cwd();
    const stop = () => {
        if (db.db?.sqlite?.isOpen?.()) db.db.sqlite.close();
        Object.assign(db, { db: null, initialized: false, useFallback: false, connectionType: 'none', databasePath: undefined });
    };
    const start = async () => { stop(); await initializeDatabase(); };
    for (const key of ENV_KEYS) delete process.env[key];
    process.chdir(dir);
    t.after(() => {
        stop();
        process.chdir(cwd);
        Object.assign(db, savedDb);
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        rmSync(dir, { recursive: true, force: true });
    });
    const client = { db, homeGuildId: guildId };
    const snapshot = async () => ({
        warnings: await WarningService.getWarningCount(guildId, userId),
        wallet: (await getEconomyData(client, guildId, userId)).wallet,
        welcome: (await getWelcomeConfig(client, guildId)).welcomeMessage,
    });
    // The backup command as a separate process, as `npm run backup:db` runs it.
    const backup = (args = []) => spawnSync(process.execPath, [backupScript, ...args], {
        cwd: dir, encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    return { dir, data: join(dir, 'data'), client, start, stop, snapshot, backup };
}

test('backup:db copies the SQLite data while the bot is running, and the copy restores to that moment', { skip: !canBackup && 'the SQLite backup function needs Node 22.16 or newer' }, async (t) => {
    const fx = bot(t);
    await fx.start();
    await WarningService.addWarning({ guildId, userId, moderatorId, reason: 'before the backup' });
    await addMoney(fx.client, guildId, userId, 100);
    await updateWelcomeConfig(fx.client, guildId, { welcomeMessage: 'before the backup' });
    const atBackup = await fx.snapshot();
    assert.deepEqual(atBackup, { warnings: 1, wallet: 100, welcome: 'before the backup' });

    // The bot keeps its file open while the command runs.
    const run = fx.backup();
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const file = run.stdout.match(/^Backup created: (.+\.db)$/m)?.[1];
    assert.ok(file && existsSync(file), run.stdout);
    assert.ok(file.startsWith(join(fx.dir, 'backups')), 'backups go to the backups folder next to the bot');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'only the owner can read the backup');
    assert.deepEqual(readdirSync(join(fx.dir, 'backups')).filter((name) => /-wal$|-shm$/.test(name)), [], 'the backup is one file');

    // An existing file is never overwritten.
    const again = fx.backup(['--output', file]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /Backup failed/);

    // The bot works on after the backup.
    await WarningService.addWarning({ guildId, userId, moderatorId, reason: 'after the backup' });
    await addMoney(fx.client, guildId, userId, 900);
    await updateWelcomeConfig(fx.client, guildId, { welcomeMessage: 'after the backup' });
    assert.deepEqual(await fx.snapshot(), { warnings: 2, wallet: 1000, welcome: 'after the backup' });

    // Restore as documented: stop the bot, empty the data folder (the -wal and -shm files
    // belong to the old database), put the backup in as zentix.db, start the bot.
    fx.stop();
    rmSync(fx.data, { recursive: true, force: true });
    cpSync(file, join(fx.data, 'zentix.db'), { recursive: true });
    await fx.start();
    assert.deepEqual(await fx.snapshot(), atBackup, 'the data is as it was at the backup');
    // And the restored bot can write again.
    await addMoney(fx.client, guildId, userId, 5);
    assert.equal((await fx.snapshot()).wallet, 105);
});

test('backup:db says what is wrong when there is no SQLite file, and creates none', async (t) => {
    const fx = bot(t);
    const run = fx.backup();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Backup failed: SQLite database file not found: .*zentix\.db/);
    assert.equal(existsSync(fx.data), false, 'asking for a backup does not create an empty database');
    assert.equal(existsSync(join(fx.dir, 'backups')), false);
});

test('copying the data folder while the bot is stopped is a complete backup', async (t) => {
    const fx = bot(t);
    await fx.start();
    await WarningService.addWarning({ guildId, userId, moderatorId, reason: 'kept' });
    await addMoney(fx.client, guildId, userId, 250);
    await updateWelcomeConfig(fx.client, guildId, { welcomeMessage: 'kept' });
    const kept = await fx.snapshot();

    fx.stop();
    const copy = join(fx.dir, 'copy-of-data');
    cpSync(fx.data, copy, { recursive: true });

    // The data is lost (a wiped disk, a new server), then the copy is put back.
    rmSync(fx.data, { recursive: true, force: true });
    await fx.start();
    assert.deepEqual(await fx.snapshot(), { warnings: 0, wallet: 0, welcome: (await fx.snapshot()).welcome }, 'a new, empty database');
    fx.stop();
    rmSync(fx.data, { recursive: true, force: true });
    cpSync(copy, fx.data, { recursive: true });
    await fx.start();
    assert.deepEqual(await fx.snapshot(), kept);
});
