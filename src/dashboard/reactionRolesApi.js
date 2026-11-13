import express from 'express';
import {
    PANEL_CHANNEL_TYPES, addPanelRole, botCanPostIn, checkActorRole, checkPanelRole, createPanel, deletePanel, editPanelText,
    inspectPanels, panelErrorMessage, refreshPanelMessage, removePanelRole, repostPanel, resolveRole, roleReason,
} from '../services/reactionRoles/manage.js';
import { MAX_DESCRIPTION, MAX_PANELS, MAX_ROLES, MAX_TITLE } from '../services/reactionRoles/store.js';
import { recordPanelChange } from '../services/reactionRoles/audit.js';
import { logger } from '../utils/logger.js';

/**
 * Reaction role panels for the web dashboard.
 *
 * This page acts on Discord: creating or reposting a panel sends a message,
 * changing it edits that message and deleting it deletes the message. Every
 * change goes through the same functions as `/reactroles`, so the checks and
 * the order of effects are the same. Reading changes nothing.
 */

const MAX_LISTED = 250;
const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const isRevision = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (status, message) => Object.assign(new Error(message), { status });

const STATUS = {
    REACTROLES_TITLE: 400,
    REACTROLES_DESCRIPTION: 400,
    REACTROLES_CHANNEL: 400,
    REACTROLES_NO_ROLES: 400,
    REACTROLES_ROLE_LIMIT: 409,
    REACTROLES_ROLE_REFUSED: 409,
    REACTROLES_ROLE_DUPLICATE: 409,
    REACTROLES_ROLE_NOT_ON_PANEL: 409,
    REACTROLES_LAST_ROLE: 409,
    REACTROLES_LIMIT: 409,
    REACTROLES_BOT_PERMISSION: 409,
    REACTROLES_MISSING: 404,
    REACTROLES_STALE: 409,
    REACTROLES_NOT_MISSING: 409,
    REACTROLES_CHANNEL_MISSING: 409,
    REACTROLES_ROLES_GONE: 409,
    REACTROLES_INVALID: 409,
    REACTROLES_UNCERTAIN: 502,
    REACTROLES_DISCORD: 502,
    REACTROLES_UNAVAILABLE: 503,
    REACTROLES_MESSAGE_LEFT: 500,
    REACTROLES_RECORD_LEFT: 500,
};

function respond(res, error, fallback) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    const status = STATUS[error.code];
    if (status) {
        if (status >= 500) logger.warn(`[REACTROLES] Dashboard request failed (${error.code}): ${error.cause?.message ?? error.message}`);
        const body = { error: panelErrorMessage(error, 'id', fallback) };
        if (error.code === 'REACTROLES_MESSAGE_LEFT') body.messageUrl = error.url ?? null;
        return res.status(status).json(body);
    }
    // Includes a lost COMMIT response: the change may or may not be stored.
    logger.warn(`[REACTROLES] Dashboard request failed: ${error?.message ?? error}`);
    return res.status(503).json({ error: fallback });
}

function requireBody(body, required) {
    if (!isPlainObject(body)) throw bad(400, 'Permintaan tidak valid.');
    const keys = Object.keys(body);
    if (keys.length !== required.length || required.some((key) => !Object.hasOwn(body, key))) throw bad(400, 'Permintaan tidak valid.');
    if (body.confirmed !== true) throw bad(400, 'Konfirmasi diperlukan.');
}

const name = (value) => String(value ?? '').slice(0, 100);

function listChannels(guild) {
    const channels = [...guild.channels.cache.values()].filter((channel) => PANEL_CHANNEL_TYPES.includes(channel.type));
    channels.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || (a.id < b.id ? -1 : 1));
    return {
        truncated: channels.length > MAX_LISTED,
        // The bot's cached permissions, not a live Discord lookup.
        channels: channels.slice(0, MAX_LISTED).map((channel) => ({ id: channel.id, name: name(channel.name), usable: botCanPostIn(guild, channel) })),
    };
}

function listRoles(guild, member) {
    const roles = [...guild.roles.cache.values()].filter((role) => role.id !== guild.id);
    roles.sort((a, b) => (b.position ?? 0) - (a.position ?? 0) || (a.id < b.id ? -1 : 1));
    return {
        truncated: roles.length > MAX_LISTED,
        roles: roles.slice(0, MAX_LISTED).map((role) => {
            const check = checkPanelRole(guild, role);
            const mine = check.ok ? checkActorRole(guild, member, role) : check;
            return { id: role.id, name: name(role.name), usable: mine.ok, reason: mine.ok ? null : roleReason(mine.code, 'id') };
        }),
    };
}

export function createReactionRolesApi(client, { auth, csrf, audit = recordPanelChange }) {
    const router = express.Router();
    const base = '/reaction-roles';
    router.use(base, express.json({ limit: '16kb' }));
    router.use(base, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    });

    const ready = () => {
        if (!client.isReady?.()) throw bad(503, 'Bot belum siap.');
    };
    /** The member the session belongs to. Role rules are checked against this member, so a request without one is refused. */
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
    const panelId = (req) => {
        if (!isId(req.params.id)) throw bad(400, 'Permintaan tidak valid.');
        return req.params.id;
    };
    /** The role as the server knows it now; an id the server does not know is refused before anything else. */
    async function roleOf(guild, id) {
        const found = await resolveRole(guild, id);
        if (found.role) return found.role;
        if (found.missing) throw bad(400, 'Role itu tidak ada di server ini.');
        throw bad(502, 'Role tidak dapat diperiksa di Discord saat ini. Tidak ada yang diubah.');
    }
    const unknownResult = 'Perubahan tidak dapat diselesaikan saat ini. Muat ulang untuk melihat keadaan terbaru sebelum mencoba lagi.';

    router.get(base, auth, async (req, res) => {
        try {
            if (Object.keys(req.query).length) throw bad(400, 'Parameter tidak valid.');
            actorOf(req);
            const view = await inspectPanels(client, req.guild);
            const channels = listChannels(req.guild);
            const roles = listRoles(req.guild, actorOf(req));
            res.json({
                rejected: view.rejected,
                panels: view.panels.map((panel) => ({
                    messageId: panel.messageId,
                    channelId: panel.channelId,
                    // The bot's cache: null means the bot does not see the channel right now.
                    channelName: panel.channel ? name(panel.channel.name) : null,
                    status: panel.status,
                    url: panel.url,
                    title: panel.title,
                    description: panel.description,
                    revision: panel.revision,
                    createdAt: panel.createdAt,
                    roles: panel.roleStates.map((state) => ({
                        id: state.id,
                        name: state.name === null ? null : name(state.name),
                        ok: state.ok,
                        reason: state.ok ? null : roleReason(state.reason, 'id'),
                    })),
                })),
                channels: channels.channels,
                channelsTruncated: channels.truncated,
                roles: roles.roles,
                rolesTruncated: roles.truncated,
                limits: { panels: MAX_PANELS, roles: MAX_ROLES, title: MAX_TITLE, description: MAX_DESCRIPTION },
            });
        } catch (error) {
            respond(res, error, 'Panel tidak dapat dibaca dari database.');
        }
    });

    router.post(`${base}/panels`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'channelId', 'title', 'description', 'roleIds']);
            const { channelId, title, description, roleIds } = req.body;
            if (!isId(channelId) || typeof title !== 'string' || typeof description !== 'string'
                || !Array.isArray(roleIds) || roleIds.length > MAX_ROLES || !roleIds.every(isId) || new Set(roleIds).size !== roleIds.length) {
                throw bad(400, 'Permintaan tidak valid.');
            }
            ready();
            actorOf(req);
            const roles = [];
            for (const id of roleIds) roles.push(await roleOf(req.guild, id));
            const { panel, message } = await createPanel(client, req.guild, {
                channel: req.guild.channels.cache.get(channelId) ?? null, title, description, roles, actor: actorOf(req),
            });
            record(req, 'create', { messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleIds: panel.roles });
            res.json({ ok: true, messageId: panel.messageId, url: message.url ?? null });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.patch(`${base}/panels/:id`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'title', 'description']);
            if (!isRevision(req.body.revision) || typeof req.body.title !== 'string' || typeof req.body.description !== 'string') throw bad(400, 'Permintaan tidak valid.');
            ready();
            actorOf(req);
            const { panel, message } = await editPanelText(client, req.guild, panelId(req), {
                title: req.body.title, description: req.body.description, revision: req.body.revision,
            });
            record(req, 'text', { messageId: panel.messageId, channelId: panel.channelId, title: panel.title });
            res.json({ ok: true, message: message.state });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/panels/:id/roles`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision', 'roleId']);
            if (!isRevision(req.body.revision) || !isId(req.body.roleId)) throw bad(400, 'Permintaan tidak valid.');
            ready();
            actorOf(req);
            const role = await roleOf(req.guild, req.body.roleId);
            const { panel, message } = await addPanelRole(client, req.guild, panelId(req), role, { revision: req.body.revision, actor: actorOf(req) });
            record(req, 'role_add', { messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleId: role.id });
            res.json({ ok: true, message: message.state });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.delete(`${base}/panels/:id/roles/:roleId`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision']);
            if (!isRevision(req.body.revision) || !isId(req.params.roleId)) throw bad(400, 'Permintaan tidak valid.');
            ready();
            actorOf(req);
            const { panel, message } = await removePanelRole(client, req.guild, panelId(req), req.params.roleId, { revision: req.body.revision });
            record(req, 'role_remove', { messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleId: req.params.roleId });
            res.json({ ok: true, message: message.state });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/panels/:id/repost`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed']);
            ready();
            actorOf(req);
            const { panel, message } = await repostPanel(client, req.guild, panelId(req));
            record(req, 'repost', { messageId: panel.messageId, channelId: panel.channelId, title: panel.title, roleIds: panel.roles });
            res.json({ ok: true, messageId: panel.messageId, url: message.url ?? null });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.post(`${base}/panels/:id/refresh`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed']);
            ready();
            actorOf(req);
            const { message } = await refreshPanelMessage(client, req.guild, panelId(req));
            res.json({ ok: true, message: message.state });
        } catch (error) {
            respond(res, error, unknownResult);
        }
    });

    router.delete(`${base}/panels/:id`, auth, csrf, async (req, res) => {
        try {
            requireBody(req.body, ['confirmed', 'revision']);
            if (!isRevision(req.body.revision)) throw bad(400, 'Permintaan tidak valid.');
            ready();
            actorOf(req);
            const { messageDeleted, panel, title } = await deletePanel(client, req.guild, panelId(req), { revision: req.body.revision });
            record(req, 'delete', { messageId: panel.messageId, channelId: panel.channelId, title });
            res.json({ ok: true, messageDeleted });
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
