import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { resolveDashboardOrigin } from './origin.js';

/**
 * Read-only "control center" for the main settings page.
 *
 * Nothing here is stored by this module and nothing is changed. Each part of
 * the response says where it comes from:
 *   discord   - what the bot sees in Discord at the moment of the request
 *   storage   - which database the bot is using and whether it answers
 *   access    - why this session may use the dashboard
 *   hosting   - whether the hosting panel connection is configured (bot owner only)
 *   dashboard - how this dashboard process is set up
 * Secrets and environment values are never returned, only yes/no facts.
 */

const MAX_ADMIN_ROLES = 50;

/**
 * Guild-level permissions of the bot. Channel overrides can still differ.
 * The third column names examples of features that need the permission; it is a hint, not a full list.
 */
const BOT_PERMISSIONS = [
    ['ViewChannel', 'Melihat channel', 'semua fitur'],
    ['SendMessages', 'Mengirim pesan', 'welcome, goodbye, birthday, giveaway, tiket'],
    ['EmbedLinks', 'Menyematkan tautan', 'hampir semua pesan bot'],
    ['AttachFiles', 'Melampirkan file', 'tiket'],
    ['ReadMessageHistory', 'Membaca riwayat pesan', 'tiket'],
    ['ManageMessages', 'Mengelola pesan', 'moderation'],
    ['ManageRoles', 'Mengelola peran', 'autorole, verification, reaction role'],
    ['ManageChannels', 'Mengelola channel', 'tiket, Join to Create, server stats'],
    ['MoveMembers', 'Memindahkan anggota', 'Join to Create'],
    ['KickMembers', 'Mengeluarkan anggota', 'moderation'],
    ['BanMembers', 'Memblokir anggota', 'moderation'],
    ['ModerateMembers', 'Timeout anggota', 'moderation'],
    ['Connect', 'Terhubung ke voice', 'music, Join to Create'],
    ['Speak', 'Berbicara di voice', 'music'],
];

const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const finite = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const text = (value, max = 100) => String(value ?? '').slice(0, max);

export function botOwnerIds(env) {
    return String(env.OWNER_IDS || '').split(',').map((x) => x.trim()).filter(isId);
}

/**
 * Whether the hosting panel settings are present and well-formed.
 * Mirrors the checks of hostingApi.js without contacting the panel.
 */
export function hostingConfigured(env) {
    try {
        const url = new URL(env.HOSTING_PANEL_URL);
        const plain = url.protocol === 'https:' && !url.username && !url.password
            && !url.search && !url.hash && url.pathname === '/';
        if (!plain) return false;
    } catch {
        return false;
    }
    return Boolean(env.HOSTING_API_KEY) && /^[a-zA-Z0-9_-]{1,64}$/.test(env.HOSTING_SERVER_ID || '');
}

function describeBot(client, guild) {
    const me = guild.members?.me ?? null;
    const permissions = me?.permissions ?? null;
    const bot = {
        id: isId(client.user?.id) ? client.user.id : null,
        ready: client.isReady?.() === true,
        ping: finite(client.ws?.ping) === null ? null : Math.round(client.ws.ping),
        uptimeMs: finite(client.uptime),
        permissions: null,
        highestRole: null,
    };
    if (permissions?.has) {
        const administrator = permissions.has(PermissionFlagsBits.Administrator);
        bot.permissions = {
            administrator,
            items: BOT_PERMISSIONS.map(([key, label, usedBy]) => ({
                key,
                label,
                usedBy,
                granted: administrator || permissions.has(PermissionFlagsBits[key]),
            })),
        };
    }
    const highest = me?.roles?.highest;
    const roles = guild.roles?.cache;
    if (highest && Number.isInteger(highest.position) && roles?.values) {
        // Roles above the bot's highest role cannot be given or removed by it.
        let rolesAbove = 0;
        for (const role of roles.values()) if (role.position > highest.position) rolesAbove++;
        bot.highestRole = { id: highest.id, name: text(highest.name), rolesAbove };
    }
    return bot;
}

function administratorRoles(guild) {
    const roles = [];
    for (const role of guild.roles?.cache?.values?.() ?? []) {
        if (role.permissions?.has?.(PermissionFlagsBits.Administrator)) roles.push(role);
    }
    roles.sort((a, b) => (b.position ?? 0) - (a.position ?? 0) || (a.id < b.id ? -1 : 1));
    return {
        truncated: roles.length > MAX_ADMIN_ROLES,
        roles: roles.slice(0, MAX_ADMIN_ROLES).map((role) => ({
            id: role.id,
            name: text(role.name),
            // Managed roles belong to a bot or an integration, not to people.
            managed: role.managed === true,
        })),
    };
}

function describeStorage(client) {
    const status = client.db?.getStatus?.();
    const type = typeof status?.connectionType === 'string' ? status.connectionType : 'unknown';
    const backend = ['postgresql', 'sqlite', 'memory', 'none'].includes(type) ? type : 'unknown';
    const answering = Boolean(client.db?.isAvailable?.());
    // Degraded means the bot fell back to memory: it runs, but not on its database.
    const state = status?.isDegraded === true ? 'degraded' : answering ? 'connected' : 'unavailable';
    return { backend, status: state };
}

export function createSettingsApi(client, { auth, env = process.env }) {
    const router = express.Router();
    router.get('/control-center', auth, (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (Object.keys(req.query).length) return res.status(400).json({ error: 'Parameter tidak valid.' });

        const guild = req.guild;
        const user = req.session.user;
        const isBotOwner = botOwnerIds(env).includes(user.id);
        const listed = administratorRoles(guild);
        let origin = null;
        try {
            origin = new URL(env.DASHBOARD_URL).origin;
        } catch { /* reported as not available */ }
        // True when the dashboard is reached over plain HTTP on a public address.
        const insecureHttp = resolveDashboardOrigin(env).insecure;

        res.json({
            readAt: Date.now(),
            discord: {
                guild: {
                    id: guild.id,
                    name: text(guild.name),
                    memberCount: finite(guild.memberCount),
                    ownerId: isId(guild.ownerId) ? guild.ownerId : null,
                },
                bot: describeBot(client, guild),
            },
            storage: describeStorage(client),
            access: {
                user: { id: user.id, username: text(user.username) },
                isGuildOwner: guild.ownerId === user.id,
                isAdministrator: req.member?.permissions?.has?.(PermissionFlagsBits.Administrator) === true,
                isBotOwner,
                sessionExpiresAt: finite(req.session.expires),
                adminRoles: listed.roles,
                adminRolesTruncated: listed.truncated,
            },
            // Whether a panel is configured is itself owner-only information.
            hosting: { configured: isBotOwner ? hostingConfigured(env) : null },
            dashboard: { origin, sessionStore: 'process', insecureHttp },
        });
    });
    return router;
}
