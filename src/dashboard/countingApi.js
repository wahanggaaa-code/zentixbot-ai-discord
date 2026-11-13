import express from 'express';
import {
    COUNTING_CHANNEL_TYPES, MAX_START, countingErrorMessage, disableGame, inspectGame, missingBotPermissions, resetGame, setupGame,
} from '../services/countingGame/manage.js';
import { COUNTING_SYSTEMS, isCountingSystem } from '../services/countingGame/systems.js';
import { recordGameChange } from '../services/countingGame/audit.js';
import { logger } from '../utils/logger.js';

/**
 * The counting game for the web dashboard.
 *
 * Reading changes nothing. A change goes through the same functions as `/count`,
 * so the checks are the same. Nothing here sends, edits or deletes a Discord
 * message; the game itself does that later, when members write in the channel.
 */

const MAX_LISTED = 250;
const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const isRevision = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (status, message) => Object.assign(new Error(message), { status });
const name = (value) => String(value ?? '').slice(0, 100);

const STATUS = {
    COUNTING_SYSTEM: 400,
    COUNTING_CHANNEL: 400,
    COUNTING_START: 400,
    COUNTING_BOT_PERMISSION: 409,
    COUNTING_ACTIVE_ELSEWHERE: 409,
    COUNTING_NOT_ENABLED: 409,
    COUNTING_STALE: 409,
    COUNTING_INVALID: 409,
    COUNTING_UNCERTAIN: 503,
    COUNTING_UNAVAILABLE: 503,
};

function respond(res, error, fallback, { reading = false } = {}) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    const status = STATUS[error.code];
    if (status) {
        if (status >= 500) logger.warn(`[COUNTING] Dashboard request failed (${error.code}): ${error.cause?.message ?? error.message}`);
        // "Nothing was changed" is the wrong thing to say about a read that changes nothing anyway.
        const text = reading && error.code === 'COUNTING_UNAVAILABLE' ? fallback : countingErrorMessage(error, 'id', fallback);
        return res.status(status).json({ error: text });
    }
    logger.warn(`[COUNTING] Dashboard request failed: ${error?.message ?? error}`);
    return res.status(503).json({ error: fallback });
}

function requireBody(body, required) {
    if (!isPlainObject(body)) throw bad(400, 'Permintaan tidak valid.');
    const keys = Object.keys(body);
    if (keys.length !== required.length || required.some((key) => !Object.hasOwn(body, key))) throw bad(400, 'Permintaan tidak valid.');
    if (body.confirmed !== true) throw bad(400, 'Konfirmasi diperlukan.');
    if (!isRevision(body.revision)) throw bad(400, 'Permintaan tidak valid.');
}

function listChannels(guild) {
    const channels = [...guild.channels.cache.values()].filter((channel) => COUNTING_CHANNEL_TYPES.includes(channel.type));
    channels.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || (a.id < b.id ? -1 : 1));
    return {
        truncated: channels.length > MAX_LISTED,
        // The bot's cached permissions, not a live Discord lookup.
        channels: channels.slice(0, MAX_LISTED).map((channel) => {
            const missing = missingBotPermissions(guild, channel);
            return { id: channel.id, name: name(channel.name), usable: missing.length === 0, missing };
        }),
    };
}

export function createCountingApi(client, { auth, csrf, audit = recordGameChange }) {
    const router = express.Router();
    const base = '/counting';
    router.use(base, express.json({ limit: '4kb' }));
    router.use(base, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const ready = () => {
        if (!client.isReady?.()) throw bad(503, 'Bot belum siap.');
    };
    /** The member the session belongs to; a request without one is refused before anything is read. */
    const actorOf = (req) => {
        if (!req.member?.id) throw bad(403, 'Akses ditolak.');
        return req.member;
    };
    /** A line in the bot's log channel. The answer to the browser never waits for it or depends on it. */
    const record = (req, action, details) => {
        Promise.resolve()
            .then(() => audit(client, req.guild.id, action, { source: 'dashboard', actorId: req.member?.id, ...details }))
            .catch(() => {});
    };
    /** Names come from the bot's member cache; null means the member is not cached (or has left). */
    const memberName = (guild, userId) => {
        const user = guild.members?.cache?.get(userId)?.user;
        return user ? name(user.globalName ?? user.username) : null;
    };
    const publicGame = (game) => ({
        enabled: game.enabled,
        channelId: game.channelId,
        system: game.system,
        nextNumber: game.nextNumber,
        currentStreak: game.currentStreak,
        bestStreak: game.bestStreak,
    });
    const unknownResult = 'Perubahan tidak dapat diselesaikan saat ini. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.';

    router.get(base, auth, async (req, res) => {
        try {
            if (Object.keys(req.query).length) throw bad(400, 'Parameter tidak valid.');
            actorOf(req);
            const view = await inspectGame(client, req.guild);
            const channels = listChannels(req.guild);
            const channel = view.game.channelId ? req.guild.channels.cache.get(view.game.channelId) : null;
            res.json({
                game: {
                    ...publicGame(view.game),
                    // The bot's cache: null means the bot does not see the channel right now.
                    channelName: channel ? name(channel.name) : null,
                    expected: view.expected,
                    lastUserId: view.game.lastUserId,
                    lastUserName: view.game.lastUserId ? memberName(req.guild, view.game.lastUserId) : null,
                },
                revision: view.revision,
                health: view.health,
                players: view.players,
                leaderboard: view.top.map((entry) => ({ userId: entry.userId, name: memberName(req.guild, entry.userId), counts: entry.counts })),
                systems: Object.entries(COUNTING_SYSTEMS).map(([value, system]) => ({ value, label: system.label, description: system.description })),
                channels: channels.channels,
                channelsTruncated: channels.truncated,
                limits: { maxStart: MAX_START },
            });
        } catch (error) {
            respond(res, error, 'Permainan hitung tidak dapat dibaca dari database.', { reading: true });
        }
    });

    router.put(base, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'channelId', 'system']);
            const { channelId, system, revision } = req.body;
            if (!isId(channelId) || !isCountingSystem(system)) throw bad(400, 'Permintaan tidak valid.');
            ready();
            actorOf(req);
            const { changed, game } = await setupGame(client, req.guild, { channelId, system, revision });
            if (changed) record(req, 'setup', { channelId: game.channelId, system: COUNTING_SYSTEMS[game.system].label });
            res.json({ ok: true, changed, game: publicGame(game) });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/disable`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision']);
            ready();
            actorOf(req);
            const { changed, game } = await disableGame(client, req.guild, { revision: req.body.revision });
            if (changed) record(req, 'disable', { channelId: game.channelId });
            res.json({ ok: true, changed, game: publicGame(game) });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/reset`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'start', 'clearScores']);
            const { start, clearScores, revision } = req.body;
            if (!Number.isSafeInteger(start) || start < 1 || start > MAX_START) throw bad(400, `Angka awal harus antara 1 dan ${MAX_START}.`);
            if (typeof clearScores !== 'boolean') throw bad(400, 'Permintaan tidak valid.');
            ready();
            actorOf(req);
            const { game } = await resetGame(client, req.guild, { start, clearScores, revision });
            record(req, 'reset', { channelId: game.channelId, start, scoresCleared: clearScores });
            res.json({ ok: true, game: publicGame(game) });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    // Malformed or oversized JSON: answer in the API's own format, without details.
    router.use(base, (error, req, res, next) => {
        if (res.headersSent) return next(error);
        res.status(error?.status === 413 ? 413 : 400).json({ error: 'Permintaan tidak valid.' });
    });

    return router;
}
