import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLiteStore } from '../src/services/storage/sqlite.js';
import { changeRows, readRow, readRows, rowTransaction } from '../src/services/storage/sqliteRows.js';

// The helper every feature store uses to read and change its rows on SQLite.

const guild = 'guild:123456789012345678';
const key = (name) => `${guild}:rowtest:${name}`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

async function store(t) {
    const dir = mkdtempSync(join(tmpdir(), 'zentix-rows-'));
    const sqlite = await openSQLiteStore({ path: join(dir, 'data.db') });
    t.after(() => {
        if (sqlite.isOpen()) sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    });
    return sqlite;
}

test('changeRows is one transaction: all of it is stored, or none of it', async (t) => {
    const sqlite = await store(t);
    assert.equal(readRow(sqlite, key('a')), undefined);

    changeRows(sqlite, (rows) => {
        rows.put(key('a'), { n: 1 });
        rows.put(key('b'), { n: 2 });
    });
    assert.deepEqual(readRow(sqlite, key('a')), { n: 1 });
    assert.deepEqual([...readRows(sqlite, [key('a'), key('b'), key('missing')])], [[key('a'), { n: 1 }], [key('b'), { n: 2 }]]);

    assert.throws(() => changeRows(sqlite, (rows) => {
        rows.put(key('a'), { n: 99 });
        rows.del(key('b'));
        throw new Error('stop half way');
    }), /stop half way/);
    assert.deepEqual(readRow(sqlite, key('a')), { n: 1 }, 'the write before the error is undone');
    assert.deepEqual(readRow(sqlite, key('b')), { n: 2 }, 'and so is the delete');

    assert.throws(() => changeRows(sqlite, async () => {}), { code: 'SQLITE_INVALID' });
});

test('rowTransaction keeps writes aside until the end and stores nothing when the work fails', async (t) => {
    const sqlite = await store(t);
    changeRows(sqlite, (rows) => rows.put(key('count'), { n: 1 }));

    const result = await rowTransaction(sqlite, 'counting', async (tx) => {
        const current = await tx.get(key('count'));
        await tx.put(key('count'), { n: current.n + 1 });
        await pause();
        assert.deepEqual(readRow(sqlite, key('count')), { n: 1 }, 'not in the file while the work is running');
        assert.deepEqual(await tx.get(key('count')), { n: 2 }, 'but the work sees its own write');
        return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(readRow(sqlite, key('count')), { n: 2 });

    await assert.rejects(rowTransaction(sqlite, 'counting', async (tx) => {
        await tx.put(key('count'), { n: 50 });
        await tx.del(key('count'));
        throw new Error('Discord said no');
    }), /Discord said no/);
    assert.deepEqual(readRow(sqlite, key('count')), { n: 2 });
});

test('rowTransaction calls with the same name run one after the other, so no update is lost', async (t) => {
    const sqlite = await store(t);
    changeRows(sqlite, (rows) => rows.put(key('count'), { n: 0 }));
    const order = [];
    const add = (label) => rowTransaction(sqlite, 'counting', async (tx) => {
        order.push(`${label} in`);
        const current = await tx.get(key('count'));
        await pause();
        await tx.put(key('count'), { n: current.n + 1 });
        order.push(`${label} out`);
    });
    await Promise.all([add('a'), add('b'), add('c')]);
    assert.deepEqual(readRow(sqlite, key('count')), { n: 3 });
    assert.deepEqual(order, ['a in', 'a out', 'b in', 'b out', 'c in', 'c out']);

    // A failed call does not block the ones waiting behind it.
    const failed = rowTransaction(sqlite, 'counting', async () => { throw new Error('first fails'); });
    const next = add('d');
    await assert.rejects(failed, /first fails/);
    await next;
    assert.deepEqual(readRow(sqlite, key('count')), { n: 4 });
});

test('rowTransaction refuses to store when a row it read was changed by something else meanwhile', async (t) => {
    const sqlite = await store(t);
    changeRows(sqlite, (rows) => {
        rows.put(key('settings'), { limit: 5 });
        rows.put(key('other'), { untouched: true });
    });

    await assert.rejects(rowTransaction(sqlite, 'settings', async (tx) => {
        const current = await tx.get(key('settings'));
        await pause();
        // Another writer (a different feature path, or another name) changes the same row.
        changeRows(sqlite, (rows) => rows.put(key('settings'), { limit: 9 }));
        await tx.put(key('settings'), { limit: current.limit + 1 });
        await tx.put(key('other'), { untouched: false });
    }), { code: 'SQLITE_ROW_CONFLICT' });
    assert.deepEqual(readRow(sqlite, key('settings')), { limit: 9 }, 'the other writer keeps its change');
    assert.deepEqual(readRow(sqlite, key('other')), { untouched: true }, 'none of the refused writes is stored');

    // A row that appeared under a prefix that was listed counts as a change too.
    await assert.rejects(rowTransaction(sqlite, 'settings', async (tx) => {
        const listed = await tx.rows(`${guild}:rowtest:`);
        assert.equal(listed.length, 2);
        changeRows(sqlite, (rows) => rows.put(key('new'), { late: true }));
        await tx.put(key('other'), { untouched: false });
    }), { code: 'SQLITE_ROW_CONFLICT' });
    assert.deepEqual(readRow(sqlite, key('other')), { untouched: true });

    // With the file closed the call fails instead of pretending to store.
    sqlite.close();
    await assert.rejects(rowTransaction(sqlite, 'settings', async (tx) => { await tx.put(key('other'), { n: 1 }); }));
});
