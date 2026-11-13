import test from 'node:test';
import assert from 'node:assert/strict';
import { openSQLiteStore } from '../src/services/storage/sqlite.js';
import { createSQLiteBotDatabase } from '../src/services/storage/sqliteBotDatabase.js';
import {
    changeConfig, createApplication, decideApplication, deleteApplicationsOf, noteApplication, purgeExpired, readAll, readApplication, readConfig,
} from '../src/services/applications/store.js';

// Role applications need PostgreSQL (one transaction under one lock per server). On the SQLite
// store they must refuse outright, and the generic key-value layer must not be a way around that.
const g = '123456789012345678';
const u = '234567890123456789';
const appId = '1700000000000-abcdefghi';
const appKey = `guild:${g}:applications:${appId}`;
const userKey = `guild:${g}:applications:users:${u}`;
const roleKey = `guild:${g}:applications:roles`;

test('on SQLite every entry point of the applications store refuses before reading or writing anything', async (t) => {
    const sqlite = await openSQLiteStore();
    t.after(() => sqlite.close());
    const adapter = createSQLiteBotDatabase(sqlite);
    // The bot's database wrapper as it reports itself when running on SQLite.
    const client = { db: { db: adapter, isAvailable: () => true, getStatus: () => ({ connectionType: 'sqlite', isDegraded: false }) } };
    const app = { id: appId, guildId: g, userId: u, status: 'pending' };
    sqlite.transaction((tx) => {
        tx.botSet(appKey, app);
        tx.botSet(userKey, [appId]);
        tx.botSet(roleKey, [{ name: 'role' }]);
    });

    const calls = [
        () => readConfig(client, g),
        () => readAll(client, g),
        () => readApplication(client, g, appId),
        () => changeConfig(client, g, (draft) => { draft.settings.enabled = true; }),
        () => createApplication(client, { guildId: g, userId: u, roleId: u, answers: [] }),
        () => decideApplication(client, { guildId: g, id: appId, action: 'approve', reviewerId: u }),
        () => noteApplication(client, g, appId, { roleGranted: true }),
        () => purgeExpired(client, g),
        () => deleteApplicationsOf(client, g, u),
    ];
    for (const [index, call] of calls.entries()) await assert.rejects(call(), { code: 'APP_UNAVAILABLE' }, `call ${index}`);
    assert.deepEqual(sqlite.botGet(appKey), app);
    assert.deepEqual(sqlite.botGet(userKey), [appId]);
    assert.deepEqual(sqlite.botGet(roleKey), [{ name: 'role' }]);

    // No database at all is the same answer.
    for (const broken of [{}, { db: null }, { db: { getStatus: () => ({ connectionType: 'postgresql', isDegraded: true }) } }]) {
        await assert.rejects(readConfig(broken, g), { code: 'APP_UNAVAILABLE' });
    }
});

test('generic application keys cannot bypass guards, including nested role and malformed legacy keys', async (t) => {
    const sqlite = await openSQLiteStore();
    t.after(() => sqlite.close());
    const adapter = createSQLiteBotDatabase(sqlite);
    for (const key of [appKey, userKey, roleKey, `guild:${g}:applications:settings`, `guild:${g}:applications:role:${u}:settings`, `guild:${g}:applications:unexpected:shape`]) {
        await assert.rejects(adapter.get(key), { code: 'APPLICATION_READ_DISABLED' });
        await assert.rejects(adapter.exists(key), { code: 'APPLICATION_READ_DISABLED' });
        await assert.rejects(adapter.set(key, {}), { code: 'APPLICATION_WRITE_DISABLED' });
        await assert.rejects(adapter.delete(key), { code: 'APPLICATION_WRITE_DISABLED' });
        await assert.rejects(adapter.increment(key), { code: 'APPLICATION_WRITE_DISABLED' });
    }
});

test('expired application keys in both namespaces are not silently pruned', async (t) => {
    const sqlite = await openSQLiteStore();
    t.after(() => sqlite.close());
    const now = Date.now();
    sqlite.transaction((tx) => {
        tx.botSet(appKey, null, now - 10);
        tx.set(userKey, [], now - 10);
        tx.botSet('cache:other', 1, now - 10);
    });
    assert.deepEqual(sqlite.cleanupExpired({ now, limit: 50 }), { ai: 0, bot: 1, total: 1 });
    sqlite.transaction((tx) => {
        assert.equal(tx.hasRawKey(appKey), true);
        assert.equal(tx.hasRawKey(userKey), true);
        assert.equal(tx.hasRawKey('cache:other'), false);
    });
});
