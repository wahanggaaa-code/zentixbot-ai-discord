// manage.js — the rules of the counting game, shared by /count, the message
// handler and the web dashboard.
//
// Order of effects. The database is changed first, in one transaction. Only
// after that does the bot touch Discord (delete the wrong message, post the
// notice). A notice therefore never announces a reset that was not stored.

import { ChannelType, MessageType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { COUNTING_SYSTEMS, formatCount, isCountingSystem, matchesCount, systemOf } from './systems.js';
import { fail, isSnowflake, mutateGame, readGame, revisionOf } from './store.js';

export const MAX_START = 1_000_000;
export const LEADERBOARD_SIZE = 10;
export const NOTICE_LIFETIME_MS = 10_000;
export const COUNTING_CHANNEL_TYPES = [ChannelType.GuildText];
/** What the bot needs in the counting channel: read the numbers, remove wrong ones, announce a reset. */
export const NEEDED_PERMISSIONS = ['ViewChannel', 'SendMessages', 'ManageMessages'];

const PERMISSION_NAMES = {
    ViewChannel: { en: 'View Channel', id: 'View Channel' },
    SendMessages: { en: 'Send Messages', id: 'Send Messages' },
    ManageMessages: { en: 'Manage Messages', id: 'Manage Messages' },
};

/** Message for a failure code, in the language of the caller. Unknown codes get `fallback`. */
export const COUNTING_ERRORS = {
    COUNTING_SYSTEM: { en: 'Please choose one of the listed counting systems.', id: 'Pilih salah satu sistem hitung yang tersedia.' },
    COUNTING_CHANNEL: { en: 'Please choose a text channel of this server.', id: 'Pilih channel teks dari server ini.' },
    COUNTING_BOT_PERMISSION: { en: 'I am missing permissions in that channel. Nothing was changed.', id: 'Bot kekurangan izin di channel itu. Tidak ada yang diubah.' },
    COUNTING_ACTIVE_ELSEWHERE: {
        en: 'The counting game is already running in another channel. Disable it first, then set it up again.',
        id: 'Permainan hitung sudah berjalan di channel lain. Nonaktifkan dulu, lalu atur ulang.',
    },
    COUNTING_NOT_ENABLED: { en: 'Enable the counting game first with `/count setup`.', id: 'Aktifkan permainan hitung terlebih dahulu.' },
    COUNTING_START: { en: `The start number must be between 1 and ${MAX_START}.`, id: `Angka awal harus antara 1 dan ${MAX_START}.` },
    COUNTING_STALE: {
        en: 'The counting game settings changed in the meantime. Nothing was changed.',
        id: 'Pengaturan permainan hitung sudah berubah. Muat ulang, lalu coba lagi. Tidak ada yang diubah.',
    },
    COUNTING_INVALID: {
        en: 'The stored counting game cannot be read. Nothing was changed.',
        id: 'Data permainan hitung yang tersimpan tidak dapat dibaca. Tidak ada yang diubah.',
    },
    COUNTING_UNAVAILABLE: {
        en: 'The database could not be reached. Nothing was changed.',
        id: 'Database tidak dapat dihubungi. Tidak ada yang diubah.',
    },
    COUNTING_UNCERTAIN: {
        en: 'The database did not confirm the change. Check `/count status` before trying again.',
        id: 'Database tidak mengonfirmasi perubahan. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.',
    },
};

export function countingErrorMessage(error, language, fallback) {
    const text = COUNTING_ERRORS[error?.code]?.[language] ?? fallback;
    if (error?.code === 'COUNTING_BOT_PERMISSION' && Array.isArray(error.missing) && error.missing.length) {
        const names = error.missing.map((flag) => PERMISSION_NAMES[flag]?.[language] ?? flag).join(', ');
        return `${text} ${language === 'id' ? 'Izin yang kurang' : 'Missing'}: ${names}.`;
    }
    return text;
}

export const getCountingSystemChoices = () => Object.entries(COUNTING_SYSTEMS).map(([value, system]) => ({ name: system.label, value }));
export const getCountingSystemLabel = (key) => systemOf(key).label;

/** How the next number is written, shortened so it always fits an embed field. */
export function expectedText(game, limit = 100) {
    const text = formatCount(game.system, game.nextNumber);
    return text.length > limit ? `${text.slice(0, limit)}… (${text.length} characters)` : text;
}

/** Permissions from NEEDED_PERMISSIONS the bot lacks in a channel, from the bot's cache. */
export function missingBotPermissions(guild, channel) {
    const me = guild?.members?.me;
    const permissions = me && typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    if (!permissions) return [...NEEDED_PERMISSIONS];
    return NEEDED_PERMISSIONS.filter((flag) => !permissions.has(PermissionFlagsBits[flag]));
}

const countingChannel = (guild, channelId) => {
    const channel = isSnowflake(channelId) ? guild?.channels?.cache?.get(channelId) : null;
    return channel && COUNTING_CHANNEL_TYPES.includes(channel.type) ? channel : null;
};

function checkRevision(game, revision) {
    if (revision !== undefined && revision !== revisionOf(game)) throw fail('Counting game changed', 'COUNTING_STALE');
}

const sequenceStart = (game, start = 1) => Object.assign(game, { nextNumber: start, lastUserId: null, currentStreak: 0 });

/** The top of the leaderboard: `[{userId, counts}]`, most counts first; ties by user id so the order is stable. */
export function topCounters(game, size = LEADERBOARD_SIZE) {
    return Object.entries(game.leaderboard)
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, size)
        .map(([userId, counts]) => ({ userId, counts }));
}

/**
 * The stored game and whether it can run right now.
 * `health.state`: `none` (never set up), `off`, `ok`, `channel_missing`, `permissions`.
 * Channel and permissions come from the bot's cache, not from a live Discord lookup.
 */
export async function inspectGame(client, guild) {
    const game = await readGame(client, guild.id);
    const health = { state: 'ok', missing: [] };
    if (!game.channelId) health.state = 'none';
    else if (!game.enabled) health.state = 'off';
    else {
        const channel = countingChannel(guild, game.channelId);
        if (!channel) health.state = 'channel_missing';
        else {
            health.missing = missingBotPermissions(guild, channel);
            if (health.missing.length) health.state = 'permissions';
        }
    }
    return { game, health, revision: revisionOf(game), expected: expectedText(game), players: Object.keys(game.leaderboard).length, top: topCounters(game) };
}

/**
 * Turn the game on in a channel, or change its system.
 * Scores (leaderboard and best streak) are kept; the sequence starts again at 1
 * unless nothing changes. Returns `{changed, game}`.
 */
export async function setupGame(client, guild, { channelId, system, revision } = {}) {
    if (!isCountingSystem(system)) throw fail('Unknown counting system', 'COUNTING_SYSTEM');
    const channel = countingChannel(guild, channelId);
    if (!channel) throw fail('Not a text channel of this server', 'COUNTING_CHANNEL');
    const missing = missingBotPermissions(guild, channel);
    if (missing.length) throw fail('Bot lacks permissions in the counting channel', 'COUNTING_BOT_PERMISSION', { missing });

    return mutateGame(client, guild.id, (game) => {
        checkRevision(game, revision);
        if (game.enabled && game.channelId !== channel.id) throw fail('Counting game runs elsewhere', 'COUNTING_ACTIVE_ELSEWHERE', { channelId: game.channelId });
        if (game.enabled && game.system === system) return { write: false, result: { changed: false, game } };
        sequenceStart(Object.assign(game, { enabled: true, channelId: channel.id, system }));
        return { game, result: { changed: true, game } };
    });
}

/** Turn the game off. Channel, system and scores stay stored. Returns `{changed, game}`. */
export async function disableGame(client, guild, { revision } = {}) {
    return mutateGame(client, guild.id, (game) => {
        checkRevision(game, revision);
        if (!game.enabled) return { write: false, result: { changed: false, game } };
        game.enabled = false;
        return { game, result: { changed: true, game } };
    });
}

/** Start the sequence again at `start`; with `clearScores` also empty the leaderboard and the best streak. */
export async function resetGame(client, guild, { start = 1, clearScores = false, revision } = {}) {
    if (!Number.isSafeInteger(start) || start < 1 || start > MAX_START) throw fail('Start number out of range', 'COUNTING_START');
    if (typeof clearScores !== 'boolean') throw fail('Invalid clearScores', 'COUNTING_START');
    return mutateGame(client, guild.id, (game) => {
        checkRevision(game, revision);
        if (!game.enabled) throw fail('Counting game is not enabled', 'COUNTING_NOT_ENABLED');
        sequenceStart(game, start);
        if (clearScores) Object.assign(game, { leaderboard: {}, bestStreak: 0 });
        return { game, result: { changed: true, game } };
    });
}

/** Messages a member wrote. Join notices, pins, boosts and thread notices are not part of the game. */
export const isPlayerMessage = (message) => (message.type === MessageType.Default || message.type === MessageType.Reply)
    && message.system !== true && !message.webhookId && message.author?.bot !== true;

/**
 * Judge one message against the stored game, in one transaction.
 * Returns `{outcome: 'ignored'}`, `{outcome: 'correct', number}` or
 * `{outcome: 'broken', reason: 'wrong' | 'twice', expected}`.
 */
export async function judgeCount(client, guildId, { channelId, userId, content }) {
    return mutateGame(client, guildId, (game) => {
        if (!game.enabled || game.channelId !== channelId) return { write: false, result: { outcome: 'ignored' } };
        const twice = game.lastUserId === userId;
        if (!twice && matchesCount(game.system, content, game.nextNumber)) {
            const number = game.nextNumber;
            game.leaderboard[userId] = (game.leaderboard[userId] ?? 0) + 1;
            game.lastUserId = userId;
            game.currentStreak += 1;
            game.bestStreak = Math.max(game.bestStreak, game.currentStreak);
            game.nextNumber = number + 1;
            return { game, result: { outcome: 'correct', number } };
        }
        const result = { outcome: 'broken', reason: twice ? 'twice' : 'wrong', expected: expectedText(game, 60) };
        // Already at the very start: there is nothing to store.
        if (game.nextNumber === 1 && game.currentStreak === 0 && game.lastUserId === null) return { write: false, result };
        sequenceStart(game);
        return { game, result };
    });
}

const lastComplaint = new Map();
/** One log line per server and minute, however many messages arrive. */
function complain(guildId, error) {
    const now = Date.now();
    if (now - (lastComplaint.get(guildId) ?? 0) < 60_000) return;
    lastComplaint.set(guildId, now);
    logger.error(`[COUNTING] Could not judge a message in guild ${guildId} (${error?.code ?? 'error'}): ${error?.cause?.message ?? error?.message ?? error}`);
}

/**
 * The message handler's part. Returns `true` when the message belonged to the
 * counting game (the caller then skips prefix commands and leveling).
 *
 * When the database cannot be used the message is left alone and `false` is
 * returned: nothing is deleted and nothing is announced.
 */
export async function handleCountingMessage(client, message) {
    const guildId = message.guild.id;
    let result;
    try {
        // One plain read for every message; the transaction only runs in the counting channel.
        const game = await readGame(client, guildId);
        if (!game.enabled || game.channelId !== message.channel.id) return false;
        if (!isPlayerMessage(message)) return true;
        result = await judgeCount(client, guildId, {
            channelId: message.channel.id,
            userId: message.author.id,
            content: typeof message.content === 'string' ? message.content : '',
        });
    } catch (error) {
        complain(guildId, error);
        return false;
    }
    if (result.outcome === 'ignored') return false;
    if (result.outcome === 'correct') return true;

    await message.delete().catch((error) => {
        logger.debug(`[COUNTING] Could not delete a wrong count in guild ${guildId}: ${error?.message ?? error}`);
    });
    const why = result.reason === 'twice'
        ? 'The same member may not count twice in a row.'
        : `The next count was **${result.expected}**.`;
    try {
        const notice = await message.channel.send(`❌ Count broken by <@${message.author.id}>. ${why} The sequence has been reset to **1**.`);
        const timer = setTimeout(() => {
            Promise.resolve(notice?.delete?.()).catch(() => {});
        }, NOTICE_LIFETIME_MS);
        timer.unref?.();
    } catch (error) {
        logger.warn(`[COUNTING] Could not announce the reset in guild ${guildId}: ${error?.message ?? error}`);
    }
    return true;
}
