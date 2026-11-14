import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// The feature suites written for PostgreSQL, run once more on SQLite.
//
// With ZENTIX_TEST_BACKEND=sqlite the shared fixtures give each test a SQLite file in a
// temporary folder instead of a PostgreSQL schema; the tests themselves are the same, so both
// databases have to behave the same way towards the bot, the commands and the dashboard.
// No PostgreSQL server is needed for this file.
//
// `skipped` counts the tests that only make sense on PostgreSQL (a COMMIT whose answer gets
// lost on the network, a write held half way by another connection). A new skip must be added
// here on purpose, so a suite cannot quietly stop testing SQLite.

const GROUPS = [
    {
        name: 'commands and their stores: to-do, counting, reaction roles, server stats, applications, reports',
        skipped: 0,
        files: [
            'tests/postgres-todo.test.js', 'tests/postgres-counting.test.js', 'tests/postgres-reactroles.test.js',
            'tests/postgres-serverstats.test.js', 'tests/community-applications.test.js',
            'tests/community-applications-settings.test.js', 'tests/postgres-report.test.js',
        ],
    },
    {
        name: 'dashboard pages: applications, counting, reaction roles, server stats, level rewards',
        skipped: 1,
        files: [
            'tests/postgres-dashboard-applications.test.js', 'tests/postgres-dashboard-counting.test.js',
            'tests/postgres-dashboard-reactroles.test.js', 'tests/postgres-dashboard-serverstats.test.js',
            'tests/postgres-dashboard-reward-roles.test.js',
        ],
    },
    {
        name: 'levels and economy: XP, reward roles, shop, premium role, /pay, leaderboard',
        skipped: 1,
        files: ['tests/postgres-reward-roles.test.js', 'tests/postgres-economy-writers.test.js'],
    },
    {
        name: 'Join to Create, giveaways and tickets',
        skipped: 3,
        files: [
            'tests/postgres-jointocreate-transactions.test.js', 'tests/postgres-jointocreate-runtime.test.js',
            'tests/postgres-dashboard-jointocreate-settings.test.js', 'tests/postgres-giveaway-management.test.js',
            'tests/postgres-ticket-service.test.js',
        ],
    },
];

function runOnSQLite(files) {
    return new Promise((resolve, reject) => {
        // NODE_TEST_CONTEXT would make the child report to this runner instead of running its own.
        const { NODE_TEST_CONTEXT: _context, ZENTIX_TEST_PG_SOCKET: _socket, ...env } = process.env;
        const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], {
            env: { ...env, ZENTIX_TEST_BACKEND: 'sqlite' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            const count = (name) => Number(out.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
            const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1]);
            resolve({ code, failed, tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') });
        });
    });
}

for (const group of GROUPS) {
    test(`on SQLite: ${group.name}`, async () => {
        const result = await runOnSQLite(group.files);
        assert.deepEqual(result.failed, [], 'tests that fail on SQLite');
        assert.deepEqual(
            { code: result.code, fail: result.fail, cancelled: result.cancelled, skipped: result.skipped },
            { code: 0, fail: 0, cancelled: 0, skipped: group.skipped },
        );
        assert.equal(result.pass, result.tests - group.skipped);
        assert.ok(result.pass >= 20, `${result.pass} tests ran`);
        console.log(`SQLITE-SUITES ${result.pass} passed, ${result.skipped} PostgreSQL-only: ${group.name}`);
    });
}
