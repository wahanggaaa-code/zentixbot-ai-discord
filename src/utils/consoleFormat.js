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
    let text = [String(message ?? ''), ...shown.map(String)].join(' ');
    let kind = null;
    const frames = [];
    if (stack) {
        // The stack starts with "Kind: message" (or "Kind [CODE]: message"), followed by the frames.
        const all = String(stack).split('\n');
        const first = all.findIndex((line) => /^\s+at /.test(line));
        const head = (first === -1 ? all : all.slice(0, first)).join('\n').trim();
        const named = /^([^\s:]+(?: \[[^\]\n]+\])?):(?: |$)/.exec(head);
        const reason = (named ? head.slice(named[0].length) : head).trim();
        // An error passed to the logger has its message appended to ours by Winston. One passed as a detail
        // ({ error, stack }) does not, and without this the console would show frames and no reason.
        if (reason && !text.includes(reason)) text += (text ? ': ' : '') + reason;
        // The kind is worth showing unless it is the plain "Error"; a kind with a code is the whole reason
        // when the message is empty (Node's AggregateError [ECONNREFUSED]).
        const name = named?.[1].split(' ')[0];
        if (name && name !== 'Error' && !text.split('\n')[0].includes(name)) kind = named[1];
        if (first !== -1) frames.push(...all.slice(first).filter((line) => /^\s+at /.test(line)));
    }
    const lines = text.split('\n');
    if (kind) lines[0] += ` (${kind})`;
    lines.push(...frames);
    const indent = ' '.repeat(timestamp.length + 2 + TAG_WIDTH + 1);
    const head = `${paint(timestamp, DIM, color)}  ${paint(tag.padEnd(TAG_WIDTH), COLORS[tag] ?? DIM, color)} ${lines[0]}`;
    return [head, ...lines.slice(1).map((line) => indent + line)].join('\n');
}
