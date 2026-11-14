/**
 * Texts of the startup report. The loaders announce one line per group (commands, events,
 * interactions) and keep the line per file at debug level; the bot closes the report with a
 * short block of what is running.
 */

/** Joins items into lines no longer than `width`, breaking only between items. */
export function wrapList(items, { width = 96, separator = ' · ' } = {}) {
    const lines = [];
    for (const item of items) {
        const last = lines.length - 1;
        if (last >= 0 && lines[last].length + separator.length + item.length <= width) lines[last] += separator + item;
        else lines.push(item);
    }
    return lines;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * @param {Iterable<{ category?: string, subcommands?: number }>} commands
 * @returns {{ total: number, subcommands: number, categories: [string, number][] }} categories by name
 */
export function summarizeCommands(commands) {
    const counts = new Map();
    let total = 0, subcommands = 0;
    for (const command of commands) {
        total += 1;
        subcommands += command.subcommands ?? 0;
        const category = command.category || 'uncategorised';
        counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return { total, subcommands, categories: [...counts].sort(([a], [b]) => a.localeCompare(b, 'en')) };
}

/** The lines announcing the loaded commands: totals first, then the count per category. */
export function describeCommands({ total, subcommands, categories }, { failed = 0 } = {}) {
    const problems = failed ? `; ${plural(failed, 'file')} not loaded, see the messages above` : '';
    const head = `Commands: ${total} loaded in ${plural(categories.length, 'category', 'categories')}, ${plural(subcommands, 'subcommand')}${problems}`;
    return [head, ...wrapList(categories.map(([name, count]) => `${name} ${count}`)).map((line) => `  ${line}`)];
}

export function describeEvents(count, { failed = 0 } = {}) {
    return `Events: ${count} registered${failed ? `; ${plural(failed, 'file')} not loaded, see the messages above` : ''}`;
}

export function describeInteractions({ buttons, selectMenus, modals }, { failed = 0 } = {}) {
    return `Interactions: ${plural(buttons, 'button')}, ${plural(selectMenus, 'select menu')}, ${plural(modals, 'modal')}`
        + (failed ? `; ${plural(failed, 'handler')} not loaded, see the messages above` : '');
}

/**
 * Result of one startup check, e.g. `Check, ticket panels: healthy 3, deleted 0, errors 0`.
 * Every count is listed, also the zeros, so that the same line can be compared between two starts.
 * @param {string} title
 * @param {[string, number][]} counts
 * @returns {string[]} one line, or more when the counts do not fit; the following ones are indented
 */
export function describeCheck(title, counts) {
    const [first, ...rest] = counts.map(([label, count]) => `${label} ${count}`);
    return wrapList([`Check, ${title}: ${first}`, ...rest], { separator: ', ' }).map((line, index) => (index ? `  ${line}` : line));
}

/**
 * The server the bot works for. `name` is null when the bot has not joined it; `connected` counts
 * every server the bot is in, and those besides the configured one are ignored by the bot.
 */
export function describeServer({ id, name, connected }) {
    const others = connected - (name === null ? 0 : 1);
    return `Server: ${name === null ? 'not joined' : name} (${id})`
        + (others > 0 ? `; ${others} other ${others === 1 ? 'server is' : 'servers are'} ignored` : '');
}

const DASHBOARD_OFF = {
    missing: 'DASHBOARD_URL is not set',
    malformed: 'DASHBOARD_URL must be an address without a path',
    http_not_allowed: 'DASHBOARD_URL uses http:// and DASHBOARD_ALLOW_HTTP is not true',
};

/** @param {{ origin: string | null, insecure: boolean, reason: string | null, configured: boolean }} status */
export function describeDashboard({ origin, insecure, reason, configured }) {
    if (configured) return `${origin}/dashboard/${insecure ? ' (plain HTTP)' : ''}`;
    return `login off: ${DASHBOARD_OFF[reason] ?? 'CLIENT_ID, DISCORD_CLIENT_SECRET or GUILD_ID is missing'}`;
}

const RULE = '─'.repeat(60);

/**
 * The closing block of the startup report.
 *
 * @param {object} facts
 * @param {string} facts.version
 * @param {number} facts.seconds        time since the process started
 * @param {string | null} facts.botTag  null while Discord has not confirmed the login yet
 * @param {string} facts.guildId
 * @param {string | null} facts.guildName  null when the bot is not in the configured server
 * @param {{ commands: number, buttons: number, selectMenus: number, modals: number }} facts.loaded
 * @param {boolean} facts.registered    whether Discord accepted the slash commands
 * @param {string} facts.database
 * @param {number | null} facts.port    null while the web server is not listening
 * @param {string} facts.dashboard      see describeDashboard
 * @param {number} facts.memoryBytes    resident memory of the process
 */
export function onlineSummary({ version, seconds, botTag, guildId, guildName, loaded, registered, database, port, dashboard, memoryBytes }) {
    const rows = [
        ['Bot', botTag ?? 'waiting for Discord to confirm the login'],
        ['Server', guildName ? `${guildName} (${guildId})` : `${guildId} (the bot has not joined it)`],
        ['Loaded', `${plural(loaded.commands, 'command')}, ${plural(loaded.buttons, 'button')}, ${plural(loaded.selectMenus, 'select menu')}, ${plural(loaded.modals, 'modal')}`],
        ...(registered ? [] : [['Warning', 'slash commands were NOT registered, see the error above; Discord may show none or old ones']]),
        ['Database', database],
        ['Web', port ? `port ${port}` : 'not listening yet'],
        ['Dashboard', dashboard],
        ['Memory', `${Math.round(memoryBytes / (1024 * 1024))} MB`],
    ];
    return [RULE, `ZentixBot ${version} is ONLINE (startup took ${seconds.toFixed(1)} s)`, ...rows.map(([label, text]) => `  ${label.padEnd(10)} ${text}`), RULE];
}
