/**
 * How one log entry looks on the console:
 *
 *     20:28:42  START  Commands: 100 loaded in 20 categories, 84 subcommands
 *     20:28:45  WARN   Lavalink node "nazha" error: Unexpected server response: 403
 *     20:28:46  ERROR  Failed to start bot: connect ECONNREFUSED
 *                          at TCPConnectWrap.afterConnect (node:net:1637:16)
 *
 * The time and a tag of fixed width come first, so messages start in the same column; the
 * following lines of a message with several lines are indented to that column.
 */
const TAGS = { error: 'ERROR', warn: 'WARN', info: 'INFO', http: 'HTTP', verbose: 'VERB', debug: 'DEBUG', silly: 'SILLY', startup: 'START', status: 'STATUS' };
const COLORS = { ERROR: 31, WARN: 33, INFO: 36, START: 32, STATUS: 35 };
const DIM = 90;
const TAG_WIDTH = 6;

const paint = (text, code, color) => (color && code ? `\u001b[${code}m${text}\u001b[39m` : text);

/** Whether the console output is coloured: on, unless NO_COLOR is set to anything. */
export const consoleColorEnabled = (env = process.env) => !env.NO_COLOR;

/**
 * @param {object} entry
 * @param {string} entry.timestamp
 * @param {string} entry.level
 * @param {string} [entry.displayLevel]  'startup' or 'status' for the bot's own announcements
 * @param {unknown} entry.message
 * @param {string} [entry.stack]         stack of an error that was logged with the message
 * @param {unknown[]} [entry.extras]     further arguments of the log call; plain values among them
 *                                       are shown, as in logger.warn('Could not close:', error.message).
 *                                       Objects are left to the log files.
 * @param {{ color?: boolean }} [options]
 */
export function formatConsoleLine({ timestamp, level, displayLevel, message, stack, extras }, { color = false } = {}) {
    const tag = TAGS[displayLevel] ?? TAGS[level] ?? String(level).toUpperCase();
    const shown = (extras ?? []).filter((extra) => extra === null || !['object', 'function', 'symbol'].includes(typeof extra));
    const lines = [String(message ?? ''), ...shown.map(String)].join(' ').split('\n');
    if (stack) {
        // Winston already appended the error's message to ours; the stack adds its kind and the frames.
        const kind = /^([^\s:]+): /.exec(stack)?.[1];
        if (kind && kind !== 'Error' && !lines[0].includes(kind)) lines[0] += ` (${kind})`;
        lines.push(...String(stack).split('\n').filter((line) => /^\s+at /.test(line)));
    }
    const indent = ' '.repeat(timestamp.length + 2 + TAG_WIDTH + 1);
    const head = `${paint(timestamp, DIM, color)}  ${paint(tag.padEnd(TAG_WIDTH), COLORS[tag] ?? DIM, color)} ${lines[0]}`;
    return [head, ...lines.slice(1).map((line) => indent + line)].join('\n');
}
