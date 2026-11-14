// What the bot uses of its host (src/services/systemUsage.js): the kernel's text files are read
// the way a hosting panel reads them, and nothing is invented where a file cannot be read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    cgroupDirectory, cpuQuotaCores, createSystemUsage, diskRoot, diskScanDue, firstNumber, folderBytes, megabytes, networkTotals, perSecond, statValue,
    DISK_SCAN_MAX_ENTRIES, DISK_SCAN_RETRY_MS, DISK_SCAN_TTL_MS, MAX_BASELINE_AGE_MS, MIN_SAMPLE_GAP_MS,
} from '../src/services/systemUsage.js';

const MB = 1024 * 1024;
const NET_HEAD = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
const netDev = (rows) => NET_HEAD + rows.map(([name, rx, tx]) => `${name.padStart(6)}: ${rx}    4068    0    0    0     0          0         0   ${tx}    3513    0    0    0     0       0          0\n`).join('');
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A host made of text files. `files` maps a path to its text; a missing path cannot be read.
 * Returns the sampler, the clock, and the list of folder walks that were started.
 */
function host({ files = {}, env = {}, cwd = '/srv/bot', cores = 4, totalMemory = 8192 * MB, rss = 90 * MB, scan } = {}) {
    const clock = { now: 1_800_000_000_000 };
    const state = { files: { ...files }, cpuMicros: 5_000_000, rss, scans: [], reads: [] };
    const usage = createSystemUsage({
        env, cwd,
        now: () => clock.now,
        readText: async (file) => { state.reads.push(file); return Object.hasOwn(state.files, file) ? state.files[file] : null; },
        exists: async (file) => Object.hasOwn(state.files, file),
        cores: () => cores,
        totalMemory: () => totalMemory,
        processCpuMicros: () => state.cpuMicros,
        processRss: () => state.rss,
        scan: scan ?? (async (root) => { state.scans.push(root); return { bytes: 420 * MB, complete: true }; }),
    });
    return { usage, clock, state };
}

/** A container as a panel makes it: cgroup v2 at the root of the mount, 1 core, 512 MB. */
const container = (more = {}) => ({
    '/proc/self/cgroup': '0::/\n',
    '/sys/fs/cgroup/cpu.stat': 'usage_usec 10000000\nuser_usec 6000000\nsystem_usec 4000000\n',
    '/sys/fs/cgroup/cpu.max': '100000 100000\n',
    '/sys/fs/cgroup/memory.max': `${512 * MB}\n`,
    '/sys/fs/cgroup/memory.current': `${300 * MB}\n`,
    '/sys/fs/cgroup/memory.stat': `anon ${180 * MB}\nfile ${110 * MB}\ninactive_file ${60 * MB}\nactive_file ${50 * MB}\n`,
    '/proc/self/net/dev': netDev([['lo', 999999, 999999], ['eth0', 1_000_000, 200_000]]),
    ...more,
});

// ---------------------------------------------------------------------------------------------
// Reading the files
// ---------------------------------------------------------------------------------------------

test('the kernel\'s files are read as they are written, and anything else is "not known"', () => {
    assert.equal(cgroupDirectory('0::/\n'), '/sys/fs/cgroup');
    assert.equal(cgroupDirectory('0::/system.slice/bot.service\n'), '/sys/fs/cgroup/system.slice/bot.service');
    assert.equal(cgroupDirectory('12:memory:/docker/abc\n0::/user/\n'), '/sys/fs/cgroup/user');
    assert.equal(cgroupDirectory('5:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n'), null, 'cgroup v1 has no such line');
    assert.equal(cgroupDirectory('0::/../../etc\n'), null);
    for (const nothing of ['', null, undefined, 'garbage']) assert.equal(cgroupDirectory(nothing), null);

    assert.equal(firstNumber('536870912\n'), 536870912);
    assert.equal(firstNumber('200000 100000'), 200000);
    for (const nothing of ['max\n', 'max 100000', '', null, undefined, '0', '-1', '1.5', 'abc']) assert.equal(firstNumber(nothing), null, String(nothing));

    assert.equal(statValue('anon 5\ninactive_file 0\nfile 7\n', 'inactive_file'), 0, 'zero is a value');
    assert.equal(statValue('anon 5\ninactive_file 12\n', 'inactive_file'), 12);
    assert.equal(statValue('total_inactive_file 9\ninactive_file 3\n', 'inactive_file'), 3, 'the whole name, not a part of it');
    for (const nothing of ['', null, 'inactive_file abc', 'inactive_file', 'file 3']) assert.equal(statValue(nothing, 'inactive_file'), null);

    assert.equal(cpuQuotaCores('200000 100000\n'), 2);
    assert.equal(cpuQuotaCores('50000 100000'), 0.5);
    for (const nothing of ['max 100000\n', '', null, '100000', '0 100000', '100000 0', 'a b']) assert.equal(cpuQuotaCores(nothing), null, String(nothing));

    assert.deepEqual(networkTotals(netDev([['lo', 500, 500], ['eth0', 1000, 200], ['eth1', 30, 4]])), { rx: 1030, tx: 204 }, 'loopback is not traffic');
    assert.equal(networkTotals(netDev([['lo', 500, 500]])), null);
    assert.equal(networkTotals(NET_HEAD), null);
    assert.equal(networkTotals(null), null);
    assert.deepEqual(networkTotals('eth0:1000 1 0 0 0 0 0 0 200 1 0 0 0 0 0 0\n'), { rx: 1000, tx: 200 }, 'no space after the colon, as the kernel writes long names');

    assert.equal(megabytes('1024'), 1024 * MB);
    assert.equal(megabytes(' 512 '), 512 * MB);
    assert.equal(megabytes(10 * 1024 * 1024), 10 * 1024 * 1024 * MB);
    for (const nothing of ['', undefined, null, '0', '-5', '1.5', '1e3', 'abc', '5GB', String(10 * 1024 * 1024 + 1), '999999999']) assert.equal(megabytes(nothing), null, String(nothing));

    assert.equal(perSecond(3000, 1000, 2000), 1000);
    assert.equal(perSecond(1000, 1000, 2000), 0, 'no traffic is 0, not "unknown"');
    assert.equal(perSecond(500, 1000, 2000), null, 'a counter that went backwards was reset');
    for (const [a, b, ms] of [[null, 1, 1000], [1, null, 1000], [undefined, 1, 1000], [2, 1, 0], [2, 1, -5], [2, 1, NaN]]) assert.equal(perSecond(a, b, ms), null);
});

test('the disk figure is the panel\'s server folder when the bot lives in it, otherwise the bot\'s own folder', () => {
    assert.equal(diskRoot('/home/container'), '/home/container');
    assert.equal(diskRoot('/home/container/bot'), '/home/container');
    assert.equal(diskRoot('/home/container/a/b/c'), '/home/container');
    assert.equal(diskRoot('/home/container2/bot'), '/home/container2/bot', 'a folder that only starts with the same letters');
    assert.equal(diskRoot('/home'), '/home');
    assert.equal(diskRoot('/srv/bot'), '/srv/bot');
});

test('a folder size is measured again after five minutes, or after 30 seconds when the walk was cut short', () => {
    assert.equal(DISK_SCAN_TTL_MS, 5 * 60 * 1000);
    assert.equal(DISK_SCAN_RETRY_MS, 30 * 1000);
    assert.equal(DISK_SCAN_MAX_ENTRIES, 60000);
    assert.equal(diskScanDue(null, 0), true);
    assert.equal(diskScanDue({ at: 1000, complete: true }, 1000 + DISK_SCAN_TTL_MS - 1), false);
    assert.equal(diskScanDue({ at: 1000, complete: true }, 1000 + DISK_SCAN_TTL_MS), true);
    assert.equal(diskScanDue({ at: 1000, complete: false }, 1000 + DISK_SCAN_RETRY_MS - 1), false);
    assert.equal(diskScanDue({ at: 1000, complete: false }, 1000 + DISK_SCAN_RETRY_MS), true);
});

// ---------------------------------------------------------------------------------------------
// In a container
// ---------------------------------------------------------------------------------------------

test('in a container the figures are the container\'s, counted the way a hosting panel counts them', async () => {
    const { usage, clock, state } = host({ files: container(), env: { DISK_LIMIT_MB: '1024' } });

    const first = await usage.sample();
    assert.equal(first.scope, 'container');
    assert.equal(first.sampledAt, clock.now);
    assert.deepEqual(first.cpu, { percent: null, limitPercent: 100, cores: 4 }, 'no rate before there are two readings');
    assert.deepEqual(first.memory, { usedBytes: 240 * MB, totalBytes: 512 * MB, limited: true, processBytes: 90 * MB }, 'memory charged minus file cache that can be dropped');
    assert.deepEqual(first.network, { inBytes: 1_000_000, outBytes: 200_000, inBytesPerSecond: null, outBytesPerSecond: null });
    assert.deepEqual(first.disk, { usedBytes: null, limitBytes: 1024 * MB, measuredAt: null, complete: null, source: 'folder' }, 'the folder walk does not hold the answer up');

    await settle();
    clock.now += 3000;
    // 0.75 s of CPU in 3 s is a quarter of one core.
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 10750000\n';
    state.files['/sys/fs/cgroup/memory.current'] = `${310 * MB}\n`;
    state.files['/proc/self/net/dev'] = netDev([['lo', 5_000_000, 5_000_000], ['eth0', 1_300_000, 206_000]]);
    state.cpuMicros += 2_900_000; // the process's own counter is not what is shown here
    const second = await usage.sample();
    assert.deepEqual(second.cpu, { percent: 25, limitPercent: 100, cores: 4 });
    assert.equal(second.memory.usedBytes, 250 * MB);
    assert.deepEqual(second.network, { inBytes: 1_300_000, outBytes: 206_000, inBytesPerSecond: 100_000, outBytesPerSecond: 2000 });
    assert.deepEqual(second.disk, { usedBytes: 420 * MB, limitBytes: 1024 * MB, measuredAt: clock.now - 3000, complete: true, source: 'folder' });
    assert.deepEqual(state.scans, ['/srv/bot']);
    assert.equal(JSON.stringify(second).includes('/srv'), false, 'no path of the host leaves the bot');
});

test('the memory limit shown is the one the panel shows: SERVER_MEMORY when the container was given headroom above it', async () => {
    // Pterodactyl: a 512 MB server gets a container of about 589 MB.
    const sold = host({ files: container({ '/sys/fs/cgroup/memory.max': `${589 * MB}\n` }), env: { SERVER_MEMORY: '512' } });
    assert.deepEqual((await sold.usage.sample()).memory, { usedBytes: 240 * MB, totalBytes: 512 * MB, limited: true, processBytes: 90 * MB });

    const wrong = host({ files: container(), env: { SERVER_MEMORY: '4096' } });
    assert.equal((await wrong.usage.sample()).memory.totalBytes, 512 * MB, 'a setting above what the kernel enforces is not believed');

    const zero = host({ files: container(), env: { SERVER_MEMORY: '0' } });
    assert.equal((await zero.usage.sample()).memory.totalBytes, 512 * MB, '0 is the panel\'s word for "no limit"');

    const onlyEnv = host({ files: container({ '/sys/fs/cgroup/memory.max': 'max\n' }), env: { SERVER_MEMORY: '2048' } });
    assert.deepEqual((await onlyEnv.usage.sample()).memory, { usedBytes: 240 * MB, totalBytes: 2048 * MB, limited: true, processBytes: 90 * MB });
});

test('a container without limits is still a container; without a memory figure the bot\'s own is used', async () => {
    const files = container({ '/.dockerenv': '', '/sys/fs/cgroup/cpu.max': 'max 100000\n', '/sys/fs/cgroup/memory.max': 'max\n' });
    const { usage, clock, state } = host({ files, cores: 2, totalMemory: 4096 * MB });
    const first = await usage.sample();
    assert.equal(first.scope, 'container');
    assert.deepEqual(first.cpu, { percent: null, limitPercent: null, cores: 2 });
    assert.deepEqual(first.memory, { usedBytes: 240 * MB, totalBytes: 4096 * MB, limited: false, processBytes: 90 * MB });

    clock.now += 2000;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 19000000\n'; // 9 s of CPU in 2 s: more than two cores can do
    assert.equal((await usage.sample()).cpu.percent, 200, 'never more than the machine has');

    const noMemory = container({ '/.dockerenv': '' });
    delete noMemory['/sys/fs/cgroup/memory.current'];
    const second = host({ files: noMemory });
    assert.equal((await second.usage.sample()).memory.usedBytes, 90 * MB);
});

test('the cgroup named in /proc is used when its files are there, the root of the mount otherwise', async () => {
    // A service on a VPS: the files sit in the service's own directory.
    const service = {
        '/proc/self/cgroup': '0::/system.slice/bot.service\n',
        '/sys/fs/cgroup/cpu.stat': 'usage_usec 999999999\n', // the whole machine; must not be used
        '/sys/fs/cgroup/system.slice/bot.service/cpu.stat': 'usage_usec 1000000\n',
        '/sys/fs/cgroup/system.slice/bot.service/cpu.max': '200000 100000\n',
        '/sys/fs/cgroup/system.slice/bot.service/memory.max': `${256 * MB}\n`,
        '/sys/fs/cgroup/system.slice/bot.service/memory.current': `${100 * MB}\n`,
        '/sys/fs/cgroup/system.slice/bot.service/memory.stat': 'inactive_file 0\n',
    };
    const own = host({ files: service });
    const first = await own.usage.sample();
    assert.equal(first.scope, 'container');
    assert.deepEqual(first.cpu, { percent: null, limitPercent: 200, cores: 4 });
    assert.deepEqual(first.memory, { usedBytes: 100 * MB, totalBytes: 256 * MB, limited: true, processBytes: 90 * MB });
    own.clock.now += 2000;
    own.state.files['/sys/fs/cgroup/system.slice/bot.service/cpu.stat'] = 'usage_usec 4000000\n';
    assert.equal((await own.usage.sample()).cpu.percent, 150, '3 s of CPU in 2 s is one and a half cores');

    // A container that sees the host's name for its cgroup: that directory does not exist inside.
    const renamed = host({ files: container({ '/proc/self/cgroup': '0::/system.slice/docker-abc.scope\n' }) });
    assert.equal((await renamed.usage.sample()).memory.usedBytes, 240 * MB);
});

test('cgroup v1 is read as well', async () => {
    const files = {
        '/proc/self/cgroup': '5:memory:/docker/abc\n4:cpu,cpuacct:/docker/abc\n',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${512 * MB}\n`,
        '/sys/fs/cgroup/memory/memory.usage_in_bytes': `${300 * MB}\n`,
        '/sys/fs/cgroup/memory/memory.stat': `cache ${90 * MB}\ninactive_file ${1 * MB}\ntotal_inactive_file ${50 * MB}\n`,
        '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '50000\n',
        '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000\n',
        '/sys/fs/cgroup/cpuacct/cpuacct.usage': '8000000000\n', // nanoseconds
    };
    const { usage, clock, state } = host({ files });
    const first = await usage.sample();
    assert.equal(first.scope, 'container');
    assert.deepEqual(first.cpu, { percent: null, limitPercent: 50, cores: 4 });
    assert.deepEqual(first.memory, { usedBytes: 250 * MB, totalBytes: 512 * MB, limited: true, processBytes: 90 * MB });
    clock.now += 4000;
    state.files['/sys/fs/cgroup/cpuacct/cpuacct.usage'] = '9000000000\n';
    assert.equal((await usage.sample()).cpu.percent, 25);

    // "No limit" is a number near 2^63 there, and a quota of -1.
    const free = host({ files: { ...files, '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712\n', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1\n' }, totalMemory: 2048 * MB });
    const sample = await free.usage.sample();
    assert.equal(sample.scope, 'process', 'nothing restricts it and nothing says it is a container');
    assert.deepEqual(sample.memory, { usedBytes: 90 * MB, totalBytes: 2048 * MB, limited: false, processBytes: 90 * MB });
});

// ---------------------------------------------------------------------------------------------
// Outside a container
// ---------------------------------------------------------------------------------------------

test('outside a container CPU and memory are the bot\'s own process, against the whole machine', async () => {
    // A VPS: the root cgroup counts every process of the machine and has no limits.
    const files = {
        '/proc/self/cgroup': '0::/\n',
        '/sys/fs/cgroup/cpu.stat': 'usage_usec 900000000000\n',
        '/proc/self/net/dev': netDev([['lo', 1, 1], ['ens3', 5000, 7000]]),
    };
    const { usage, clock, state } = host({ files, cores: 8, totalMemory: 16384 * MB, rss: 150 * MB });
    const first = await usage.sample();
    assert.equal(first.scope, 'process');
    assert.deepEqual(first.cpu, { percent: null, limitPercent: null, cores: 8 });
    assert.deepEqual(first.memory, { usedBytes: 150 * MB, totalBytes: 16384 * MB, limited: false, processBytes: 150 * MB });

    clock.now += 5000;
    state.cpuMicros += 500_000;
    state.rss = 160 * MB;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 900040000000\n'; // the machine was busy; the bot was not
    const second = await usage.sample();
    assert.equal(second.cpu.percent, 10, 'half a second of CPU in five seconds');
    assert.equal(second.memory.usedBytes, 160 * MB);
    assert.deepEqual(second.network, { inBytes: 5000, outBytes: 7000, inBytesPerSecond: 0, outBytesPerSecond: 0 });
});

test('where nothing can be read (not Linux), the answer still comes and says what is not known', async () => {
    const { usage, clock, state } = host({ files: {}, cores: 0 });
    const first = await usage.sample();
    assert.deepEqual(first, {
        sampledAt: clock.now, scope: 'process',
        cpu: { percent: null, limitPercent: null, cores: 1 },
        memory: { usedBytes: 90 * MB, totalBytes: 8192 * MB, limited: false, processBytes: 90 * MB },
        network: { inBytes: null, outBytes: null, inBytesPerSecond: null, outBytesPerSecond: null },
        disk: { usedBytes: null, limitBytes: null, measuredAt: null, complete: null, source: 'folder' },
    });
    clock.now += 2000;
    state.cpuMicros += 100_000;
    const second = await usage.sample();
    assert.equal(second.cpu.percent, 5);
    assert.deepEqual(second.network, { inBytes: null, outBytes: null, inBytesPerSecond: null, outBytesPerSecond: null });
});

// ---------------------------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------------------------

test('samples closer than a second share one reading, and overlapping calls share one sample', async () => {
    assert.equal(MIN_SAMPLE_GAP_MS, 1000);
    const { usage, clock, state } = host({ files: container() });
    const [a, b] = await Promise.all([usage.sample(), usage.sample()]);
    assert.equal(a, b, 'two tabs asking at once');
    const readsForOne = state.reads.length;
    assert.ok(readsForOne > 0);

    clock.now += MIN_SAMPLE_GAP_MS - 1;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 10999000\n';
    const soon = await usage.sample();
    assert.equal(soon.sampledAt, a.sampledAt);
    assert.equal(soon.cpu.percent, null);
    assert.equal(state.reads.length, readsForOne, 'nothing was read again');

    clock.now += 1;
    const next = await usage.sample();
    assert.equal(next.sampledAt, a.sampledAt + MIN_SAMPLE_GAP_MS);
    assert.equal(next.cpu.percent, 99.9);
    assert.equal(state.reads.length, readsForOne * 2);
});

test('a reading older than 15 seconds is not compared with, and a counter that fell back gives no rate', async () => {
    assert.equal(MAX_BASELINE_AGE_MS, 15000);
    const { usage, clock, state } = host({ files: container() });
    await usage.sample();

    clock.now += MAX_BASELINE_AGE_MS;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 11500000\n';
    assert.equal((await usage.sample()).cpu.percent, 10, 'exactly 15 seconds still counts');

    clock.now += MAX_BASELINE_AGE_MS + 1;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 99000000\n';
    const stale = await usage.sample();
    assert.equal(stale.cpu.percent, null, 'the tab was away: an average over that time is not "now"');
    assert.equal(stale.network.inBytesPerSecond, null);

    clock.now += 2000;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 1000\n'; // the container was moved or restarted
    state.files['/proc/self/net/dev'] = netDev([['eth0', 10, 300_000]]);
    const reset = await usage.sample();
    assert.equal(reset.cpu.percent, null);
    assert.equal(reset.network.inBytesPerSecond, null);
    assert.equal(reset.network.outBytesPerSecond, 50_000, 'each counter on its own');

    clock.now += 2000;
    state.files['/sys/fs/cgroup/cpu.stat'] = 'usage_usec 201000\n';
    assert.equal((await usage.sample()).cpu.percent, 10, 'and the next one is compared again');
});

test('when the source of the CPU figure changes, the two readings are not compared', async () => {
    const { usage, clock, state } = host({ files: container() });
    await usage.sample();
    clock.now += 2000;
    delete state.files['/sys/fs/cgroup/cpu.stat']; // the file became unreadable: the process's own counter takes over
    state.cpuMicros = 60_000_000; // a larger number than the container's counter was: the difference would look like load
    assert.equal((await usage.sample()).cpu.percent, null, 'a container counter and a process counter are different clocks');
    clock.now += 2000;
    state.cpuMicros += 400_000;
    assert.equal((await usage.sample()).cpu.percent, 20);
});

// ---------------------------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------------------------

test('the folder is walked in the background, once per five minutes, and never twice at a time', async () => {
    let release;
    const walks = [];
    const scan = (root) => { walks.push(root); return new Promise((resolve) => { release = resolve; }); };
    const { usage, clock } = host({ files: container(), cwd: '/home/container/bot', scan });

    assert.equal((await usage.sample()).disk.usedBytes, null);
    await settle();
    assert.deepEqual(walks, ['/home/container'], 'the panel\'s server folder, not only the bot\'s subfolder');

    clock.now += 3000;
    assert.equal((await usage.sample()).disk.usedBytes, null, 'still walking');
    await settle();
    assert.equal(walks.length, 1, 'no second walk while the first runs');

    release({ bytes: 700 * MB, complete: true });
    await settle();
    const measuredAt = clock.now;
    clock.now += 3000;
    assert.deepEqual((await usage.sample()).disk, { usedBytes: 700 * MB, limitBytes: null, measuredAt, complete: true, source: 'folder' });

    clock.now = measuredAt + DISK_SCAN_TTL_MS - 1;
    await usage.sample(); await settle();
    assert.equal(walks.length, 1);
    clock.now = measuredAt + DISK_SCAN_TTL_MS;
    const during = await usage.sample(); await settle();
    assert.equal(walks.length, 2);
    assert.equal(during.disk.usedBytes, 700 * MB, 'the old figure stays until the new one is there');
    release({ bytes: 710 * MB, complete: true });
    await settle();
    clock.now += 2000;
    assert.equal((await usage.sample()).disk.usedBytes, 710 * MB);
});

test('a walk that was cut short says so and is repeated sooner; a walk that fails changes nothing', async () => {
    const answers = [{ bytes: 5000 * MB, complete: false }, new Error('disk gone'), null, { bytes: Infinity, complete: true }, { bytes: 5100 * MB, complete: true }];
    let walks = 0;
    const scan = async () => { const answer = answers[walks++]; if (answer instanceof Error) throw answer; return answer; };
    const { usage, clock } = host({ files: container(), env: { DISK_LIMIT_MB: 'lots' }, scan });

    await usage.sample(); await settle();
    clock.now += 2000;
    const partial = (await usage.sample()).disk;
    assert.deepEqual({ usedBytes: partial.usedBytes, complete: partial.complete, limitBytes: partial.limitBytes }, { usedBytes: 5000 * MB, complete: false, limitBytes: null });
    assert.equal(walks, 1);

    for (const expected of [2, 3, 4, 5]) {
        clock.now += DISK_SCAN_RETRY_MS;
        const before = (await usage.sample()).disk;
        await settle();
        assert.equal(walks, expected);
        if (expected < 5) assert.equal(before.usedBytes, 5000 * MB, 'a failed walk keeps the last good figure');
    }
    clock.now += 2000;
    assert.deepEqual((({ usedBytes, complete }) => ({ usedBytes, complete }))((await usage.sample()).disk), { usedBytes: 5100 * MB, complete: true });
});

test('folderBytes adds up the files of a real folder, does not follow links, and stops at its limit', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zentix-usage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(1000));
    fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'b.bin'), Buffer.alloc(2500));
    fs.writeFileSync(path.join(root, 'sub', 'deeper', 'c'), '');
    fs.writeFileSync(path.join(root, 'sub', 'deeper', 'd'), 'abc');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zentix-usage-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'big'), Buffer.alloc(50000));
    fs.symlinkSync(outside, path.join(root, 'link-to-folder'));
    fs.symlinkSync(path.join(outside, 'big'), path.join(root, 'link-to-file'));
    fs.symlinkSync(root, path.join(root, 'sub', 'loop'));

    assert.deepEqual(await folderBytes(root), { bytes: 3503, complete: true });
    assert.deepEqual(await folderBytes(path.join(root, 'missing')), { bytes: 0, complete: true }, 'a folder that is not there is empty, not an error');

    const cut = await folderBytes(root, 2);
    assert.equal(cut.complete, false);
    assert.ok(cut.bytes < 3503);
    assert.deepEqual(await folderBytes(root, 4), { bytes: 3503, complete: true }, 'exactly as many files as the limit is not "cut short"');
    const oneShort = await folderBytes(root, 3);
    assert.equal(oneShort.complete, false, 'one file more than the limit is');
    assert.ok(oneShort.bytes === 3500 || oneShort.bytes === 3503, 'and no more than the limit was counted');
});

test('on this machine the real sampler answers, with numbers that can be true', async () => {
    const usage = createSystemUsage({ cwd: path.resolve('src/services') });
    const first = await usage.sample();
    assert.ok(['container', 'process'].includes(first.scope));
    assert.equal(first.cpu.percent, null);
    assert.ok(first.cpu.cores >= 1);
    assert.ok(first.memory.usedBytes > 1 * MB && first.memory.usedBytes <= first.memory.totalBytes * 1.5);
    assert.ok(first.memory.processBytes > 1 * MB);
    await new Promise((resolve) => setTimeout(resolve, MIN_SAMPLE_GAP_MS + 50));
    const second = await usage.sample();
    assert.ok(second.cpu.percent >= 0 && second.cpu.percent <= second.cpu.cores * 100);
    assert.ok(second.disk.usedBytes > 0, 'the folder of this very source file');
    assert.equal(second.disk.complete, true);
});
