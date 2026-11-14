import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { inspectJoinToCreate } from '../services/storage/postgresJoinToCreateTransactions.js';
import {
    configureJoinToCreateTrigger,
    updateJoinToCreateTrigger,
    removeJoinToCreateTriggerConfig,
} from '../services/joinToCreateRuntime.js';
import {
    ALLOWED_TEMPLATE_PLACEHOLDERS,
    CHANNEL_NAME_MAX_LENGTH,
    normalizeChannelNameTemplate,
    validateChannelNameTemplate,
} from '../utils/joinToCreateTemplate.js';
import { logConfigurationChange } from '../services/joinToCreateService.js';

/**
 * Join to Create settings for the web dashboard.
 *
 * Every change goes through the same runtime entry points as the slash
 * command, so it is serialized with voice events and written by the single
 * transaction protocol. Nothing here creates, moves or deletes anything in
 * Discord: these are changes to stored settings only.
 */

const MAX_LISTED_VOICE_CHANNELS = 500;
const REQUIRED_BOT_PERMISSIONS = [
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.MoveMembers,
    PermissionFlagsBits.Connect,
];
const OPTION_FIELDS = ['nameTemplate', 'userLimit', 'bitrate'];

const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const isRevision = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (status, message) => Object.assign(new Error(message), { status });

/** Messages for protocol outcomes. Anything not listed is reported as "could not save". */
const PROTOCOL_ERRORS = {
    JTC_STALE: [409, 'Pengaturan berubah sejak halaman dimuat. Muat ulang, periksa, lalu ulangi.'],
    JTC_PENDING: [409, 'Bot sedang membuat channel sementara. Coba lagi beberapa detik lagi.'],
    JTC_MISSING: [404, 'Trigger tidak lagi terdaftar. Muat ulang halaman.'],
    JTC_CONFLICT: [409, 'Join to Create sudah memiliki trigger, atau channel itu tidak dapat dipakai. Muat ulang halaman.'],
    JTC_INVALID: [409, 'Data Join to Create tersimpan perlu diperiksa sebelum dapat diubah.'],
    JTC_LEGACY: [409, 'Ada data Join to Create berformat lama. Periksa data sebelum mengubah pengaturan.'],
    JTC_EXPIRY: [409, 'Record Join to Create memiliki masa berlaku. Periksa data sebelum mengubah pengaturan.'],
    JTC_SCOPE: [403, 'Server ini bukan server yang dikonfigurasi untuk bot.'],
    JTC_UNAVAILABLE: [503, 'Database tidak tersedia.'],
};

function respond(res, error, fallback) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    const known = PROTOCOL_ERRORS[error.code];
    if (known) return res.status(known[0]).json({ error: known[1] });
    // Includes a lost COMMIT response: the change may or may not be stored.
    return res.status(503).json({ error: fallback });
}

function requireBody(body, required, optional = []) {
    if (!isPlainObject(body)) throw bad(400, 'Permintaan tidak valid.');
    const keys = Object.keys(body);
    const allowed = new Set([...required, ...optional]);
    if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(body, key))) {
        throw bad(400, 'Permintaan tidak valid.');
    }
    if (body.confirmed !== true) throw bad(400, 'Konfirmasi diperlukan.');
}

/** Validated settings taken from a request body; only fields that are present. */
function parseOptions(body) {
    const options = {};
    if (Object.hasOwn(body, 'nameTemplate')) {
        const raw = body.nameTemplate;
        if (typeof raw !== 'string' || raw.length > 400) throw bad(400, 'Template nama tidak valid.');
        try {
            validateChannelNameTemplate(raw);
        } catch {
            throw bad(400, `Template nama tidak valid. Maksimal ${CHANNEL_NAME_MAX_LENGTH} karakter, tanpa @ # : atau backtick, dan hanya placeholder yang didukung.`);
        }
        options.nameTemplate = normalizeChannelNameTemplate(raw);
    }
    if (Object.hasOwn(body, 'userLimit')) {
        if (!Number.isInteger(body.userLimit) || body.userLimit < 0 || body.userLimit > 99) {
            throw bad(400, 'Batas user harus bilangan bulat 0 sampai 99.');
        }
        options.userLimit = body.userLimit;
    }
    if (Object.hasOwn(body, 'bitrate')) {
        if (!Number.isInteger(body.bitrate) || body.bitrate < 8000 || body.bitrate > 384000) {
            throw bad(400, 'Bitrate harus 8 sampai 384 kbps.');
        }
        options.bitrate = body.bitrate;
    }
    return options;
}

function botCanManage(guild, channel) {
    const me = guild.members?.me;
    return Boolean(me && channel.permissionsFor?.(me)?.has(REQUIRED_BOT_PERMISSIONS));
}

function listVoiceChannels(guild) {
    const voice = [...guild.channels.cache.values()].filter((channel) => channel.type === ChannelType.GuildVoice);
    // Roughly Discord's sidebar order: uncategorized first, then by category and position.
    const rank = (channel) => [channel.parent ? (channel.parent.rawPosition ?? 0) : -1, channel.rawPosition ?? 0];
    voice.sort((a, b) => {
        const [categoryA, positionA] = rank(a);
        const [categoryB, positionB] = rank(b);
        return categoryA - categoryB || positionA - positionB || (a.id < b.id ? -1 : 1);
    });
    return {
        truncated: voice.length > MAX_LISTED_VOICE_CHANNELS,
        channels: voice.slice(0, MAX_LISTED_VOICE_CHANNELS).map((channel) => ({
            id: channel.id,
            name: String(channel.name ?? '').slice(0, 100),
            category: channel.parent?.name ? String(channel.parent.name).slice(0, 100) : null,
            usable: botCanManage(guild, channel),
        })),
    };
}

export function createJoinToCreateSettingsApi(client, { auth, csrf, audit = logConfigurationChange }) {
    const router = express.Router();
    const base = '/join-to-create/settings';
    router.use(base, express.json({ limit: '4kb' }));
    router.use(base, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    // The audit entry is a Discord message; it must never delay or fail the response.
    const record = (req, action, details) => {
        Promise.resolve()
            .then(() => audit(client, req.guild.id, req.session?.user?.id ?? null, `Dashboard: ${action}`, details))
            .catch(() => {});
    };

    router.get(base, auth, async (req, res) => {
        try {
            if (Object.keys(req.query).length) throw bad(400, 'Parameter tidak valid.');
            const view = await inspectJoinToCreate(client, req.guild.id);
            const channels = req.guild.channels.cache;
            const voice = view.triggers.length ? { truncated: false, channels: [] } : listVoiceChannels(req.guild);
            res.json({
                configRevision: view.configRevision,
                enabled: view.enabled,
                busy: view.pendingCreateCount > 0,
                temporaryCount: view.temporaryCount,
                triggers: view.triggers.map((trigger) => {
                    const channel = channels.get(trigger.channelId);
                    return {
                        channelId: trigger.channelId,
                        // The bot's cache, not a live Discord lookup.
                        channelName: channel ? String(channel.name ?? '').slice(0, 100) : null,
                        botCanManage: channel ? botCanManage(req.guild, channel) : null,
                        nameTemplate: trigger.nameTemplate,
                        userLimit: trigger.userLimit,
                        bitrate: trigger.bitrate,
                    };
                }),
                voiceChannels: voice.channels,
                voiceChannelsTruncated: voice.truncated,
                placeholders: [...ALLOWED_TEMPLATE_PLACEHOLDERS],
                limits: {
                    nameTemplate: CHANNEL_NAME_MAX_LENGTH,
                    guildBitrate: Number.isInteger(req.guild.maximumBitrate) ? req.guild.maximumBitrate : null,
                },
            });
        } catch (error) {
            respond(res, error, 'Pengaturan Join to Create tidak dapat dibaca dari database.');
        }
    });

    const unknownResult = 'Perubahan tidak dapat disimpan saat ini. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.';

    router.post(`${base}/triggers`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'channelId', ...OPTION_FIELDS]);
            if (!isId(req.body.channelId)) throw bad(400, 'Channel tidak valid.');
            const options = parseOptions(req.body);

            if (!client.isReady?.()) throw bad(503, 'Bot belum siap.');
            const channel = req.guild.channels.cache.get(req.body.channelId);
            if (channel?.type !== ChannelType.GuildVoice) throw bad(400, 'Pilih channel suara dari server ini.');
            if (!botCanManage(req.guild, channel)) {
                throw bad(400, 'Bot membutuhkan izin Manage Channels, Move Members dan Connect pada channel itu.');
            }

            await configureJoinToCreateTrigger(client, req.guild.id, channel.id, options);
            record(req, 'Initialized Join to Create', { channelId: channel.id, ...options });
            res.json({ ok: true });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.patch(`${base}/triggers/:channelId`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision'], OPTION_FIELDS);
            if (!isId(req.params.channelId) || !isRevision(req.body.revision)) throw bad(400, 'Permintaan tidak valid.');
            const patch = parseOptions(req.body);
            if (!Object.keys(patch).length) throw bad(400, 'Tidak ada perubahan yang dikirim.');

            const options = await updateJoinToCreateTrigger(client, req.guild.id, req.params.channelId, patch, req.body.revision);
            record(req, 'Updated trigger settings', { channelId: req.params.channelId, ...patch });
            res.json({ ok: true, options });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.delete(`${base}/triggers/:channelId`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision']);
            if (!isId(req.params.channelId) || !isRevision(req.body.revision)) throw bad(400, 'Permintaan tidak valid.');

            await removeJoinToCreateTriggerConfig(client, req.guild.id, req.params.channelId, req.body.revision);
            record(req, 'Removed Join to Create trigger', { channelId: req.params.channelId });
            res.json({ ok: true });
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
