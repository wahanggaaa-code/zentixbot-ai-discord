/**
 * What the bot is using of its host: CPU, memory, network and disk.
 *
 * The numbers are measured from inside, by reading what the kernel publishes under /proc and
 * /sys/fs/cgroup. On a hosting panel (Pterodactyl, Wispbyte and the like) the bot runs in a
 * container with limits, and the panel's own figures are the container's. So the container is
 * measured where there is one, with the same arithmetic the panel uses:
 *
 *   CPU      time used by the container divided by the time that passed; 100% is one core,
 *            and the limit is the CPU quota.
 *   memory   memory charged to the container minus file cache that can be dropped at once
 *            (inactive_file), against the limit.
 *   network  bytes through the container's interfaces, loopback left out.
 *   disk     the size of the server folder, because the kernel does not know the disk quota
 *            of a container; the quota comes from DISK_LIMIT_MB.
 *
 * Outside a container (a VPS, a laptop) there is nothing that separates the bot from the rest of
 * the machine, so CPU and memory are those of the bot's process and the totals are the machine's.
 * `scope` says which of the two a sample is.
 *
 * Nothing here throws. What cannot be read is null, and the dashboard writes "—" for it.
 */
import { access, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CGROUP_ROOT = '/sys/fs/cgroup';
/** Where a Pterodactyl-style panel puts the server's files; the panel's disk figure is this folder. */
const PANEL_HOME = '/home/container';

/** A second sample sooner than this returns the previous one: a rate over a few milliseconds is noise. */
export const MIN_SAMPLE_GAP_MS = 1000;
/** A previous sample older than this is not compared with: the result would be an average, not "now". */
export const MAX_BASELINE_AGE_MS = 15 * 1000;
/** How long a folder size is reused. Walking the folder costs CPU, and the answer changes slowly. */
export const DISK_SCAN_TTL_MS = 5 * 60 * 1000;
/** A walk that stopped at the entry limit is repeated sooner. */
export const DISK_SCAN_RETRY_MS = 30 * 1000;
export const DISK_SCAN_MAX_ENTRIES = 60000;

// ---------------------------------------------------------------------------------------------
// Reading the kernel's text files
// ---------------------------------------------------------------------------------------------

/** The directory of the process's own cgroup (cgroup v2), from the text of /proc/self/cgroup. */
export function cgroupDirectory(text) {
    for (const line of String(text ?? '').split('\n')) {
        const match = /^0::(\/.*)$/.exec(line.trim());
        if (!match || match[1].split('/').includes('..')) continue;
        return match[1] === '/' ? CGROUP_ROOT : CGROUP_ROOT + match[1].replace(/\/+$/, '');
    }
    return null;
}

/** The first number of a file; null for "max", for nothing, and for anything not above zero. */
export function firstNumber(text) {
    const token = String(text ?? '').trim().split(/\s+/)[0];
    if (!/^\d+$/.test(token)) return null;
    const value = Number(token);
    return value > 0 ? value : null;
}

/** The value after `key` in a file of "key value" lines; zero is a value. */
export function statValue(text, key) {
    for (const line of String(text ?? '').split('\n')) {
        const [name, value] = line.trim().split(/\s+/);
        if (name === key && /^\d+$/.test(value ?? '')) return Number(value);
    }
    return null;
}

/** Cores allowed by cpu.max ("200000 100000" is two); null when there is no quota. */
export function cpuQuotaCores(text) {
    const [quota, period] = String(text ?? '').trim().split(/\s+/);
    if (!/^\d+$/.test(quota ?? '') || !/^\d+$/.test(period ?? '')) return null;
    return Number(quota) > 0 && Number(period) > 0 ? Number(quota) / Number(period) : null;
}

/** Bytes received and sent over every interface but loopback, from the text of /proc/<pid>/net/dev. */
export function networkTotals(text) {
    let rx = 0, tx = 0, found = false;
    for (const line of String(text ?? '').split('\n')) {
        const match = /^\s*([^:\s]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/.exec(line);
        if (!match || match[1] === 'lo') continue;
        rx += Number(match[2]); tx += Number(match[3]); found = true;
    }
    return found ? { rx, tx } : null;
}

/** A setting in megabytes as bytes; null when it is not a whole number between 1 and 10 TB. */
export function megabytes(value) {
    const text = String(value ?? '').trim();
    if (!/^\d{1,8}$/.test(text)) return null;
    const mb = Number(text);
    return mb >= 1 && mb <= 10 * 1024 * 1024 ? mb * 1024 * 1024 : null;
}

/** Units per second between two readings of a counter; null when the counter went backwards. */
export function perSecond(current, previous, elapsedMs) {
    if (current === null || previous === null || current === undefined || previous === undefined || !(elapsedMs > 0)) return null;
    const delta = current - previous;
    return delta < 0 ? null : delta / (elapsedMs / 1000);
}

/** Whether a folder size has to be measured again. */
export function diskScanDue(cached, now) {
    if (!cached) return true;
    return now - cached.at >= (cached.complete ? DISK_SCAN_TTL_MS : DISK_SCAN_RETRY_MS);
}

/** The folder whose size is the server's disk use: the panel's server folder when the bot lives in it. */
export function diskRoot(cwd) {
    const relative = path.relative(PANEL_HOME, cwd);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? PANEL_HOME : cwd;
}

// ---------------------------------------------------------------------------------------------
// Folder size
// ---------------------------------------------------------------------------------------------

/**
 * Bytes of all files under `root`. Symbolic links are not followed, so the walk cannot go in
 * circles or leave the folder. Stops after `maxEntries`
 * files and says so (`complete: false`), so that a huge or slow disk cannot hold the bot up.
 * Files of one folder are read together, folders one after another: thousands of requests at
 * once would slow down everything else that reads the disk, the bot included.
 */
export async function folderBytes(root, maxEntries = DISK_SCAN_MAX_ENTRIES) {
    let bytes = 0, files = 0, complete = true;
    async function walk(dir) {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        const folders = [], sizes = [];
        for (const entry of entries) {
            if (entry.isDirectory()) { folders.push(path.join(dir, entry.name)); continue; }
            if (!entry.isFile()) continue;
            if (files + sizes.length >= maxEntries) { complete = false; break; }
            sizes.push(stat(path.join(dir, entry.name)).then((info) => info.size, () => 0));
        }
        for (const size of await Promise.all(sizes)) bytes += size;
        files += sizes.length;
        for (const folder of folders) { if (!complete) return; await walk(folder); }
    }
    await walk(root);
    return { bytes, complete };
}

// ---------------------------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------------------------

const readTextFile = (file) => readFile(file, 'utf8').catch(() => null);
const fileExists = (file) => access(file).then(() => true, () => false);
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * @param {object} [options]             everything has a real default; tests pass stand-ins
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {() => number} [options.now]
 * @param {string} [options.cwd]
 * @param {(file: string) => Promise<string | null>} [options.readText]
 * @param {(file: string) => Promise<boolean>} [options.exists]
 * @param {() => number} [options.cores]            cores of the machine
 * @param {() => number} [options.totalMemory]      bytes of the machine
 * @param {() => number} [options.processCpuMicros] CPU time of this process, microseconds
 * @param {() => number} [options.processRss]       resident memory of this process, bytes
 * @param {(root: string) => Promise<{bytes: number, complete: boolean}>} [options.scan]
 * @returns {{ sample: () => Promise<object> }}
 */
export function createSystemUsage({
    env = process.env,
    now = Date.now,
    cwd = process.cwd(),
    readText = readTextFile,
    exists = fileExists,
    cores = () => os.availableParallelism?.() ?? os.cpus().length ?? 1,
    totalMemory = () => os.totalmem(),
    processCpuMicros = () => { const used = process.cpuUsage(); return used.user + used.system; },
    processRss = () => process.memoryUsage.rss(),
    scan = folderBytes,
} = {}) {
    let previous = null;      // counters of the last sample, for the rates
    let last = null;          // the last result
    let pending = null;       // a sample being taken
    let docker = null;        // whether /.dockerenv exists; it does not change while the process lives
    let folder = null;        // { at, bytes, complete }
    let scanning = false;
    const root = diskRoot(cwd);

    /** Limits and counters of the cgroup the process is in; null when none can be read. */
    async function readCgroup() {
        const own = cgroupDirectory(await readText('/proc/self/cgroup'));
        // Inside a container the cgroup's files sit at the root of the mount, whatever /proc says.
        for (const dir of [...new Set([own, CGROUP_ROOT])].filter(Boolean)) {
            const [cpuStat, cpuMax, memoryMax, memoryCurrent, memoryStat] = await Promise.all(
                ['cpu.stat', 'cpu.max', 'memory.max', 'memory.current', 'memory.stat'].map((name) => readText(`${dir}/${name}`)));
            const used = firstNumber(memoryCurrent);
            const cpuMicros = statValue(cpuStat, 'usage_usec');
            if (used === null && cpuMicros === null) continue;
            return {
                cpuMicros,
                cores: cpuQuotaCores(cpuMax),
                memoryLimit: firstNumber(memoryMax),
                memoryUsed: used === null ? null : Math.max(0, used - (statValue(memoryStat, 'inactive_file') ?? 0)),
            };
        }
        // cgroup v1, as older hosts still mount it.
        const [limit, usage, memoryStat, quota, period, cpuNanos] = await Promise.all([
            'memory/memory.limit_in_bytes', 'memory/memory.usage_in_bytes', 'memory/memory.stat',
            'cpu/cpu.cfs_quota_us', 'cpu/cpu.cfs_period_us', 'cpuacct/cpuacct.usage',
        ].map((name) => readText(`${CGROUP_ROOT}/${name}`)));
        const used = firstNumber(usage), nanos = firstNumber(cpuNanos);
        if (used === null && nanos === null) return null;
        const memoryLimit = firstNumber(limit);
        const quotaMicros = firstNumber(quota), periodMicros = firstNumber(period);
        return {
            cpuMicros: nanos === null ? null : nanos / 1000,
            cores: quotaMicros && periodMicros ? quotaMicros / periodMicros : null,
            // v1 writes a number near 2^63 for "no limit".
            memoryLimit: memoryLimit !== null && memoryLimit < 2 ** 60 ? memoryLimit : null,
            memoryUsed: used === null ? null : Math.max(0, used - (statValue(memoryStat, 'total_inactive_file') ?? 0)),
        };
    }

    /** The folder size known so far; starts a walk in the background when it is due. Never waits. */
    function disk(at) {
        if (!scanning && diskScanDue(folder, at)) {
            scanning = true;
            Promise.resolve().then(() => scan(root))
                .then((result) => { if (result && Number.isFinite(result.bytes)) folder = { at: now(), bytes: result.bytes, complete: result.complete !== false }; })
                .catch(() => {})
                .finally(() => { scanning = false; });
        }
        return {
            usedBytes: folder ? folder.bytes : null,
            limitBytes: megabytes(env.DISK_LIMIT_MB),
            measuredAt: folder ? folder.at : null,
            complete: folder ? folder.complete : null,
            source: 'folder',
        };
    }

    async function take() {
        const at = now();
        if (docker === null) docker = await exists('/.dockerenv');
        const [cgroup, netText] = await Promise.all([readCgroup(), readText('/proc/self/net/dev')]);
        // A cgroup with a limit is a unit somebody decided to measure and restrict: a container.
        const container = Boolean(cgroup) && (docker || cgroup.memoryLimit !== null || cgroup.cores !== null);
        const scope = container ? 'container' : 'process';

        const cpuSource = container && cgroup.cpuMicros !== null ? 'container' : 'process';
        const cpuMicros = cpuSource === 'container' ? cgroup.cpuMicros : processCpuMicros();
        const net = networkTotals(netText);

        const base = previous && at - previous.at <= MAX_BASELINE_AGE_MS ? previous : null;
        const elapsed = base ? at - base.at : 0;
        const machineCores = Math.max(1, cores());
        const perSecondMicros = base && base.cpuSource === cpuSource ? perSecond(cpuMicros, base.cpuMicros, elapsed) : null;
        // 1,000,000 microseconds of CPU per second is one core working all the time: 100%.
        const percent = perSecondMicros === null ? null : Math.min(machineCores * 100, round1(perSecondMicros / 10000));

        const rss = processRss();
        const cgroupLimit = container ? cgroup.memoryLimit : null;
        // Pterodactyl gives the container a little more memory than the server was sold (headroom
        // against being killed) and writes the sold amount to SERVER_MEMORY. The panel shows that one.
        const sold = container ? megabytes(env.SERVER_MEMORY) : null;
        const memoryLimit = sold !== null && (cgroupLimit === null || sold <= cgroupLimit) ? sold : cgroupLimit;

        previous = { at, cpuSource, cpuMicros, rx: net?.rx ?? null, tx: net?.tx ?? null };
        const rate = (current, before) => { const value = base ? perSecond(current, before, elapsed) : null; return value === null ? null : Math.round(value); };
        return {
            sampledAt: at,
            scope,
            cpu: { percent, limitPercent: container && cgroup.cores !== null ? Math.round(cgroup.cores * 100) : null, cores: machineCores },
            memory: {
                usedBytes: (container ? cgroup.memoryUsed : null) ?? rss,
                totalBytes: memoryLimit ?? totalMemory(),
                limited: memoryLimit !== null,
                processBytes: rss,
            },
            network: {
                inBytes: net?.rx ?? null,
                outBytes: net?.tx ?? null,
                inBytesPerSecond: rate(net?.rx ?? null, base?.rx ?? null),
                outBytesPerSecond: rate(net?.tx ?? null, base?.tx ?? null),
            },
            disk: disk(at),
        };
    }

    return {
        /** One sample. Calls that overlap, or follow each other within a second, share a result. */
        sample() {
            if (pending) return pending;
            if (last && now() - last.sampledAt < MIN_SAMPLE_GAP_MS) return Promise.resolve({ ...last, disk: disk(now()) });
            pending = take().then((result) => { last = result; return result; }).finally(() => { pending = null; });
            return pending;
        },
    };
}
