import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { COUNTER_TYPE_CONFIG } from '../services/serverstatsService.js';
import {
    changeCounterType, counterErrorMessage, createCounter, deleteCounter, inspectCounters,
} from '../services/serverStats/manage.js';
import { COUNTER_TYPES, MAX_COUNTERS } from '../services/serverStats/store.js';
import { logger } from '../utils/logger.js';

/**
 * Server stats counters for the web dashboard.
 *
 * Unlike most settings pages this one acts on Discord: creating a counter
 * creates a channel and deleting a counter deletes its channel. Every change
 * goes through the same functions as `/serverstats`, so the checks and the
 * order of effects are the same. Reading changes nothing.
 */

const MAX_LISTED_CATEGORIES = 200;
const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const isCounterId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);
const isRevision = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (status, message) => Object.assign(new Error(message), { status });

const STATUS = {
    SERVERSTATS_TYPE: 400,
    SERVERSTATS_CHANNEL_TYPE: 400,
    SERVERSTATS_CATEGORY: 400,
    SERVERSTATS_BOT_PERMISSION: 409,
    SERVERSTATS_DUPLICATE: 409,
    SERVERSTATS_LIMIT: 409,
    SERVERSTATS_MISSING: 404,
    SERVERSTATS_STALE: 409,
    SERVERSTATS_INVALID: 409,
    SERVERSTATS_UNAVAILABLE: 503,
    SERVERSTATS_CHANNEL_FAILED: 502,
    SERVERSTATS_CHANNEL_LEFT: 500,
};

function respond(res, error, fallback) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    const status = STATUS[error.code];
    if (status) {
        if (status >= 500) logger.warn(`[SERVERSTATS] Dashboard request failed (${error.code}): ${error.cause?.message ?? error.message}`);
        const body = { error: counterErrorMessage(error, 'id', fallback) };
        if (error.code === 'SERVERSTATS_CHANNEL_LEFT') body.channelId = error.channelId;
        return res.status(status).json(body);
    }
    // Includes a lost COMMIT response: the change may or may not be stored.
    logger.warn(`[SERVERSTATS] Dashboard request failed: ${error?.message ?? error}`);
    return res.status(503).json({ error: fallback });
}

function requireBody(body, required) {
    if (!isPlainObject(body)) throw bad(400, 'Permintaan tidak valid.');
    const keys = Object.keys(body);
    if (keys.length !== required.length || required.some((key) => !Object.hasOwn(body, key))) throw bad(400, 'Permintaan tidak valid.');
    if (body.confirmed !== true) throw bad(400, 'Konfirmasi diperlukan.');
}

function listCategories(guild) {
    const me = guild.members?.me;
    const categories = [...guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildCategory);
    categories.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || (a.id < b.id ? -1 : 1));
    return {
        truncated: categories.length > MAX_LISTED_CATEGORIES,
        categories: categories.slice(0, MAX_LISTED_CATEGORIES).map((category) => ({
            id: category.id,
            name: String(category.name ?? '').slice(0, 100),
            // The bot's cached permissions, not a live Discord lookup.
            usable: Boolean(me && category.permissionsFor?.(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels])),
        })),
    };
}

const channelKind = (channel) => (channel?.type === ChannelType.GuildVoice ? 'voice' : channel?.type === ChannelType.GuildText ? 'text' : null);

function refreshView(refresh) {
    if (!refresh) return { status: 'unknown', retryAt: null };
    return { status: refresh.status, retryAt: refresh.status === 'deferred' ? refresh.retryAt : null };
}

export function createServerStatsApi(client, { auth, csrf }) {
    const router = express.Router();
    const base = '/server-stats';
    router.use(base, express.json({ limit: '2kb' }));
    router.use(base, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const actor = (req) => `${String(req.session?.user?.username ?? 'dashboard').slice(0, 60)} (${req.session?.user?.id ?? req.member?.id ?? 'unknown'}) via dashboard`;
    const ready = () => {
        if (!client.isReady?.()) throw bad(503, 'Bot belum siap.');
    };

    router.get(base, auth, async (req, res) => {
        try {
            if (Object.keys(req.query).length) throw bad(400, 'Parameter tidak valid.');
            const view = await inspectCounters(client, req.guild);
            const { categories, truncated } = listCategories(req.guild);
            res.json({
                revision: view.revision,
                rejected: view.rejected,
                counters: view.counters.map((counter) => ({
                    id: counter.id,
                    type: counter.type,
                    known: counter.known,
                    enabled: counter.enabled !== false,
                    channelId: counter.channelId,
                    // The bot's cache: null means the bot does not see the channel right now.
                    channelName: counter.channel ? String(counter.channel.name ?? '').slice(0, 100) : null,
                    channelType: channelKind(counter.channel),
                    count: counter.count,
                    expectedName: counter.expectedName,
                    current: counter.current,
                    botCanManage: counter.botCanManage,
                    nextRenameAt: counter.nextRenameAt,
                    createdAt: counter.createdAt,
                })),
                types: COUNTER_TYPES.map((type) => ({
                    id: type,
                    label: COUNTER_TYPE_CONFIG[type].label,
                    taken: view.counters.some((counter) => counter.type === type),
                })),
                categories,
                categoriesTruncated: truncated,
                limits: { counters: MAX_COUNTERS },
            });
        } catch (error) {
            respond(res, error, 'Counter tidak dapat dibaca dari database.');
        }
    });

    const unknownResult = 'Perubahan tidak dapat diselesaikan saat ini. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.';

    router.post(`${base}/counters`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'type', 'channelType', 'categoryId']);
            if (typeof req.body.type !== 'string' || typeof req.body.channelType !== 'string' || !isId(req.body.categoryId)) {
                throw bad(400, 'Permintaan tidak valid.');
            }
            ready();
            const { counter, channel, count } = await createCounter(client, req.guild, {
                type: req.body.type,
                channelType: req.body.channelType,
                categoryId: req.body.categoryId,
                actor: actor(req),
            });
            res.json({ ok: true, id: counter.id, channelId: channel.id, channelName: String(channel.name ?? '').slice(0, 100), count });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.patch(`${base}/counters/:id`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'type']);
            if (!isCounterId(req.params.id) || !isRevision(req.body.revision) || typeof req.body.type !== 'string') throw bad(400, 'Permintaan tidak valid.');
            ready();
            const { changed, refresh } = await changeCounterType(client, req.guild, req.params.id, req.body.type, { revision: req.body.revision });
            res.json({ ok: true, changed, refresh: refreshView(refresh) });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.delete(`${base}/counters/:id`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision']);
            if (!isCounterId(req.params.id) || !isRevision(req.body.revision)) throw bad(400, 'Permintaan tidak valid.');
            ready();
            const { channelDeleted, channelKept } = await deleteCounter(client, req.guild, req.params.id, { revision: req.body.revision, actor: actor(req) });
            res.json({ ok: true, channelDeleted, channelKept });
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
