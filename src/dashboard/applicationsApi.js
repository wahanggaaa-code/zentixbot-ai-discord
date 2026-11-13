import express from 'express';
import { ChannelType } from 'discord.js';
import { LIMITS, isSnowflake, readAll } from '../services/applications/store.js';
import {
    canConfigure, checkFormRole, checkGrantable, createForm, deleteForm, questionsOf, updateForm, updateSettings,
} from '../services/applications/service.js';
import { loggingFor } from '../services/applications/notify.js';
import { logger } from '../utils/logger.js';

/**
 * Role applications for the web dashboard: the server-wide settings and the forms.
 *
 * Reading changes nothing. A change goes through the same functions as `/app-admin`, with the
 * signed-in member as the actor, so the checks are the same: a form can only be made for a role
 * that member could hand out by hand. Submitted applications are not shown or decided here; they
 * hold members' answers and are reviewed in Discord.
 */

const MAX_LISTED = 250;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (status, message) => Object.assign(new Error(message), { status });
const name = (value) => String(value ?? '').slice(0, 100);

const ROLE_REASONS = {
    ROLE_MISSING: 'Role sudah tidak ada.',
    ROLE_EVERYONE: 'Role @everyone tidak dapat dilamar.',
    ROLE_MANAGED: 'Role dikelola oleh integrasi dan tidak dapat diberikan kepada anggota.',
    BOT_NO_MANAGE_ROLES: 'Bot tidak punya izin Manage Roles.',
    ROLE_TOO_HIGH: 'Posisinya tidak di bawah role tertinggi bot.',
    ACTOR_NO_MANAGE_ROLES: 'Anda memerlukan izin Manage Roles untuk menawarkan role lewat lamaran.',
    ACTOR_TOO_LOW: 'Posisinya tidak di bawah role tertinggi Anda.',
};
const roleReason = (code) => ROLE_REASONS[code] ?? 'Role tidak dapat dipakai.';

const ERRORS = {
    APP_FORBIDDEN: [403, () => 'Akses ditolak.'],
    APP_ROLE_BLOCKED: [409, (error) => `${roleReason(error.reason)} Tidak ada yang diubah.`],
    APP_FORM_EXISTS: [409, () => 'Role itu sudah punya formulir lamaran.'],
    APP_FORM_MISSING: [404, () => 'Formulir lamaran tidak ditemukan. Muat ulang halaman.'],
    APP_FORM_LIMIT: [409, () => `Satu server paling banyak punya ${LIMITS.forms} formulir lamaran.`],
    APP_NAME_EMPTY: [400, () => 'Formulir perlu nama.'],
    APP_NAME_TAKEN: [409, () => 'Nama itu sudah dipakai formulir lain.'],
    APP_QUESTIONS_EMPTY: [400, () => 'Formulir perlu sedikitnya satu pertanyaan.'],
    APP_MANAGER_ROLE: [400, () => 'Role pengelola harus role server ini selain @everyone.'],
    APP_MANAGER_LIMIT: [400, () => `Role pengelola paling banyak ${LIMITS.managerRoles}.`],
    APP_RETENTION: [400, () => `Masa simpan harus bilangan bulat ${LIMITS.retentionMin} sampai ${LIMITS.retentionMax} hari.`],
    APP_STALE: [409, () => 'Pengaturan lamaran sudah diubah dari tempat lain. Tidak ada yang disimpan; muat ulang lalu coba lagi.'],
    APP_INVALID: [409, () => 'Data lamaran yang tersimpan tidak dapat dibaca. Tidak ada yang diubah.'],
    APP_UNCERTAIN: [503, () => 'Database tidak mengonfirmasi perubahan. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.'],
    APP_UNAVAILABLE: [503, () => 'Database sedang tidak dapat dipakai. Tidak ada yang diubah.'],
};

function respond(res, error, fallback, { reading = false } = {}) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    const known = ERRORS[error.code];
    if (known) {
        const [status, text] = known;
        if (status >= 500) logger.warn(`[APPLICATIONS] Dashboard request failed (${error.code}): ${error.cause?.message ?? error.message}`);
        // "Nothing was changed" is the wrong thing to say about a read that changes nothing anyway.
        return res.status(status).json({ error: reading && status >= 500 ? fallback : text(error) });
    }
    logger.warn(`[APPLICATIONS] Dashboard request failed: ${error?.message ?? error}`);
    return res.status(503).json({ error: fallback });
}

/** The body must hold exactly `required`, be confirmed, and carry the revision the page last saw. */
function requireBody(body, required) {
    if (!isPlainObject(body)) throw bad(400, 'Permintaan tidak valid.');
    const keys = Object.keys(body);
    if (keys.length !== required.length || required.some((key) => !Object.hasOwn(body, key))) throw bad(400, 'Permintaan tidak valid.');
    if (body.confirmed !== true) throw bad(400, 'Konfirmasi diperlukan.');
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw bad(400, 'Permintaan tidak valid.');
}

const isText = (value, max) => typeof value === 'string' && value.length <= max;
function requireQuestions(value) {
    if (!Array.isArray(value) || value.length > LIMITS.questions || !value.every((entry) => isText(entry, LIMITS.question))) throw bad(400, 'Permintaan tidak valid.');
}

export function createApplicationsApi(client, { auth, csrf }) {
    const router = express.Router();
    const base = '/applications';
    router.use(base, express.json({ limit: '16kb' }));
    router.use(base, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const ready = () => {
        if (!client.isReady?.()) throw bad(503, 'Bot belum siap.');
    };
    /** The member the session belongs to. Settings are for the server owner and Manage Server, as in Discord. */
    const actorOf = (req) => {
        if (!req.member?.id || !canConfigure(req.guild, req.member)) throw bad(403, 'Akses ditolak.');
        return req.member;
    };
    const roleId = (req) => {
        if (!isSnowflake(req.params.roleId)) throw bad(400, 'Permintaan tidak valid.');
        return req.params.roleId;
    };
    const unknownResult = 'Perubahan tidak dapat diselesaikan saat ini. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.';

    const publicSettings = (settings) => ({
        enabled: settings.enabled,
        managerRoles: settings.managerRoles,
        pendingDays: settings.pendingDays,
        reviewedDays: settings.reviewedDays,
    });
    const publicForm = (guild, form, settings, applications = []) => {
        const role = guild.roles.cache.get(form.roleId);
        const grantable = checkGrantable(guild, role);
        const own = applications.filter((application) => application.roleId === form.roleId);
        return {
            roleId: form.roleId,
            // The bot's cache: null means the role no longer exists.
            roleName: role ? name(role.name) : null,
            name: form.name,
            enabled: form.enabled,
            questions: questionsOf(form, settings),
            ownQuestions: form.questions.length > 0,
            logChannelId: form.logChannelId,
            usable: grantable.ok,
            problem: grantable.ok ? null : roleReason(grantable.code),
            pending: own.filter((application) => application.status === 'pending').length,
            stored: own.length,
        };
    };

    function listRoles(guild, actor) {
        const roles = [...guild.roles.cache.values()].filter((role) => role.id !== guild.id);
        roles.sort((a, b) => (b.position ?? 0) - (a.position ?? 0) || (a.id < b.id ? -1 : 1));
        return {
            truncated: roles.length > MAX_LISTED,
            roles: roles.slice(0, MAX_LISTED).map((role) => {
                const offer = checkFormRole(guild, role, actor);
                return { id: role.id, name: name(role.name), offerable: offer.ok, reason: offer.ok ? null : roleReason(offer.code) };
            }),
        };
    }

    router.get(base, auth, async (req, res) => {
        try {
            if (Object.keys(req.query).length) throw bad(400, 'Parameter tidak valid.');
            const actor = actorOf(req);
            const { settings, forms, applications } = await readAll(client, req.guild.id);
            const logging = await loggingFor(client, req.guild.id, settings);
            const channel = logging.channelId ? req.guild.channels.cache.get(logging.channelId) : null;
            const roles = listRoles(req.guild, actor);
            res.json({
                settings: publicSettings(settings),
                revision: settings.revision,
                forms: forms.map((form) => publicForm(req.guild, form, settings, applications)),
                counts: {
                    pending: applications.filter((application) => application.status === 'pending').length,
                    approved: applications.filter((application) => application.status === 'approved').length,
                    denied: applications.filter((application) => application.status === 'denied').length,
                },
                logging: {
                    channelId: logging.channelId,
                    channelName: channel ? name(channel.name) : null,
                    channelUsable: Boolean(channel) && channel.type === ChannelType.GuildText,
                    enabled: logging.enabled,
                    applicationEvents: logging.applicationEvents,
                },
                roles: roles.roles,
                rolesTruncated: roles.truncated,
                limits: {
                    forms: LIMITS.forms, questions: LIMITS.questions, question: LIMITS.question, formName: LIMITS.formName,
                    managerRoles: LIMITS.managerRoles, retentionMin: LIMITS.retentionMin, retentionMax: LIMITS.retentionMax,
                },
            });
        } catch (error) {
            respond(res, error, 'Pengaturan lamaran tidak dapat dibaca dari database.', { reading: true });
        }
    });

    router.put(`${base}/settings`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'enabled', 'managerRoles', 'pendingDays', 'reviewedDays']);
            const { enabled, managerRoles, pendingDays, reviewedDays, revision } = req.body;
            if (typeof enabled !== 'boolean' || !Array.isArray(managerRoles) || !managerRoles.every(isSnowflake)) throw bad(400, 'Permintaan tidak valid.');
            ready();
            const actor = actorOf(req);
            const { settings } = await updateSettings(client, req.guild, actor, { enabled, managerRoles, pendingDays, reviewedDays }, { revision, source: 'dashboard' });
            res.json({ ok: true, settings: publicSettings(settings), revision: settings.revision });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/forms`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'roleId', 'name', 'questions']);
            const { revision, questions } = req.body;
            if (!isSnowflake(req.body.roleId) || !isText(req.body.name, LIMITS.formName)) throw bad(400, 'Permintaan tidak valid.');
            requireQuestions(questions);
            ready();
            const actor = actorOf(req);
            const { result, settings } = await createForm(client, req.guild, actor, {
                role: req.guild.roles.cache.get(req.body.roleId) ?? null, name: req.body.name, questions,
            }, { revision, source: 'dashboard' });
            res.json({ ok: true, form: publicForm(req.guild, result, settings), settings: publicSettings(settings), revision: settings.revision });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.put(`${base}/forms/:roleId`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'name', 'enabled', 'questions']);
            const { revision, enabled, questions } = req.body;
            if (typeof enabled !== 'boolean' || !isText(req.body.name, LIMITS.formName)) throw bad(400, 'Permintaan tidak valid.');
            requireQuestions(questions);
            ready();
            const actor = actorOf(req);
            const { result, settings } = await updateForm(client, req.guild, actor, roleId(req), { name: req.body.name, enabled, questions }, { revision, source: 'dashboard' });
            res.json({ ok: true, form: publicForm(req.guild, result, settings), revision: settings.revision });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/forms/:roleId/delete`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision']);
            ready();
            const actor = actorOf(req);
            const { result, settings, removedApplications } = await deleteForm(client, req.guild, actor, roleId(req), { revision: req.body.revision, source: 'dashboard' });
            res.json({ ok: true, deleted: { roleId: result.roleId, name: result.name, applications: removedApplications }, revision: settings.revision });
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
