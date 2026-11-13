// manage.js — create, change, repost, delete and inspect reaction role panels,
// and apply a member's choice on a panel.
//
// One entry point per action, used by `/reactroles`, the panel's select menu and
// the web dashboard, so the checks and the order of effects are the same
// everywhere. Failures are thrown with a `code`; callers turn it into a message.
//
// The stored record is the authority; the Discord message is drawn from it.
// A change is stored first and the message is redrawn afterwards. If the redraw
// fails the caller is told so (`message.state`), and "Refresh panel message"
// draws it again. Nothing here deletes a record because Discord could not be
// reached: only an answer that says "this does not exist" counts as missing.

import { ActionRowBuilder, ChannelType, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { getColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import {
    MAX_DESCRIPTION, MAX_PANELS, MAX_ROLES, MAX_TITLE, fail, isSnowflake, mutatePanels, readPanel, readPanels, revisionOf,
} from './store.js';

export const PANEL_SELECT_ID = 'reaction_roles';
export const PANEL_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const DEFAULT_TITLE = 'Reaction Roles';
const DEFAULT_DESCRIPTION = 'Select your roles using the menu below.';
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_ROLE = 10011;

/** A role with one of these must never be handed out by a menu anyone can use. */
export const BLOCKED_PERMISSIONS = [
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'MentionEveryone',
];

/** Message for a failure code, in the language of the caller. Unknown codes get `fallback`. */
export const PANEL_ERRORS = {
    REACTROLES_TITLE: { en: `The title must be 1 to ${MAX_TITLE} characters long.`, id: `Judul harus 1 sampai ${MAX_TITLE} karakter.` },
    REACTROLES_DESCRIPTION: { en: `The description must be 1 to ${MAX_DESCRIPTION} characters long.`, id: `Deskripsi harus 1 sampai ${MAX_DESCRIPTION} karakter.` },
    REACTROLES_CHANNEL: { en: 'Please select a text or announcement channel of this server.', id: 'Pilih channel teks atau pengumuman dari server ini.' },
    REACTROLES_BOT_PERMISSION: {
        en: 'I need **View Channel**, **Send Messages** and **Embed Links** in that channel. Nothing was changed.',
        id: 'Bot membutuhkan izin View Channel, Send Messages, dan Embed Links di channel itu. Tidak ada yang diubah.',
    },
    REACTROLES_NO_ROLES: { en: 'Choose at least one role.', id: 'Pilih minimal satu role.' },
    REACTROLES_ROLE_LIMIT: { en: `A panel can hold at most ${MAX_ROLES} roles.`, id: `Satu panel paling banyak memuat ${MAX_ROLES} role.` },
    REACTROLES_ROLE_REFUSED: { en: 'That role cannot be offered on a panel.', id: 'Role itu tidak dapat ditawarkan di panel.' },
    REACTROLES_ROLE_DUPLICATE: { en: 'That role is already on this panel.', id: 'Role itu sudah ada di panel ini.' },
    REACTROLES_ROLE_NOT_ON_PANEL: { en: 'That role is not on this panel.', id: 'Role itu tidak ada di panel ini.' },
    REACTROLES_LAST_ROLE: {
        en: 'That is the last role on this panel. Delete the panel instead if it is no longer needed.',
        id: 'Itu role terakhir di panel ini. Hapus panelnya jika memang tidak diperlukan lagi.',
    },
    REACTROLES_LIMIT: {
        en: `This server already has the maximum of ${MAX_PANELS} reaction role panels. Delete a panel to create a new one.`,
        id: `Server ini sudah memiliki ${MAX_PANELS} panel (batas maksimum). Hapus satu panel untuk membuat yang baru.`,
    },
    REACTROLES_MISSING: { en: 'That panel no longer exists. Run `/reactroles dashboard` again.', id: 'Panel itu sudah tidak ada. Muat ulang halaman.' },
    REACTROLES_STALE: { en: 'The panel changed in the meantime. Check it and try again.', id: 'Panel berubah sejak halaman dimuat. Muat ulang, periksa, lalu ulangi.' },
    REACTROLES_NOT_MISSING: { en: 'The panel message still exists, so there is nothing to repost.', id: 'Pesan panel masih ada, jadi tidak perlu dipasang ulang.' },
    REACTROLES_ROLES_GONE: {
        en: 'None of the roles on this panel exist any more, so it cannot be posted again. Delete the panel.',
        id: 'Tidak ada lagi role panel ini yang masih ada di server, jadi panel tidak dapat dipasang ulang. Hapus panel ini.',
    },
    REACTROLES_CHANNEL_MISSING: {
        en: 'The channel of this panel no longer exists. Delete the panel and create a new one in another channel.',
        id: 'Channel panel ini sudah tidak ada. Hapus panel ini lalu buat panel baru di channel lain.',
    },
    REACTROLES_UNCERTAIN: {
        en: 'I could not check the panel message at Discord right now. Nothing was changed. Please try again.',
        id: 'Pesan panel tidak dapat diperiksa di Discord saat ini. Tidak ada yang diubah. Coba lagi nanti.',
    },
    REACTROLES_INVALID: { en: 'The stored panel data needs to be checked before it can be changed.', id: 'Data panel tersimpan perlu diperiksa sebelum dapat diubah.' },
    REACTROLES_UNAVAILABLE: { en: 'The database is not available right now. Nothing was changed.', id: 'Database PostgreSQL tidak tersedia. Tidak ada yang diubah.' },
    REACTROLES_DISCORD: { en: 'Discord refused the request. Nothing was changed.', id: 'Discord menolak permintaan. Tidak ada yang diubah.' },
    REACTROLES_MESSAGE_LEFT: {
        en: 'The panel could not be saved and its new message could not be removed again. Please delete that message by hand; its menu does not work.',
        id: 'Panel gagal disimpan dan pesan barunya tidak dapat dihapus lagi. Hapus pesan itu secara manual; menunya tidak berfungsi.',
    },
    REACTROLES_RECORD_LEFT: {
        en: 'The panel message was deleted, but its stored record could not be removed. Delete the panel again to finish.',
        id: 'Pesan panel sudah dihapus, tetapi catatannya gagal dihapus. Hapus panel sekali lagi untuk menyelesaikan.',
    },
};

export function panelErrorMessage(error, language, fallback) {
    const text = PANEL_ERRORS[error?.code]?.[language] ?? fallback;
    if (error?.code === 'REACTROLES_ROLE_REFUSED' && error.reason) return `${text} ${roleReason(error.reason, language)}`;
    return text;
}

const ROLE_REASONS = {
    ROLE_MISSING: { en: 'It no longer exists.', id: 'Role sudah tidak ada.' },
    ROLE_UNKNOWN: { en: 'It could not be looked up at Discord right now.', id: 'Role tidak dapat diperiksa di Discord saat ini.' },
    ROLE_EVERYONE: { en: '@everyone cannot be used.', id: '@everyone tidak dapat dipakai.' },
    ROLE_MANAGED: { en: 'It is managed by a bot or an integration.', id: 'Role dikelola oleh bot atau integrasi.' },
    ROLE_DANGEROUS: {
        en: 'It grants server management, moderation or @everyone mention permissions.',
        id: 'Role memberi izin pengelolaan server, moderasi, atau mention @everyone.',
    },
    BOT_NO_MANAGE_ROLES: { en: 'I do not have the Manage Roles permission.', id: 'Bot tidak memiliki izin Manage Roles.' },
    ROLE_TOO_HIGH: { en: 'It is not below my highest role.', id: 'Posisinya tidak di bawah role tertinggi bot.' },
    ACTOR_TOO_LOW: { en: 'It is not below your own highest role.', id: 'Posisinya tidak di bawah role tertinggi Anda.' },
};
export const roleReason = (code, language = 'en') => ROLE_REASONS[code]?.[language] ?? ROLE_REASONS.ROLE_UNKNOWN[language];

function has(holder, name) {
    try {
        return holder?.permissions?.has?.(PermissionFlagsBits[name]) === true;
    } catch {
        return false;
    }
}

/**
 * May the bot hand out `role` through a panel right now?
 * `{ok: true}` or `{ok: false, code}`. Never throws.
 */
export function checkPanelRole(guild, role) {
    if (!role || !isSnowflake(role.id)) return { ok: false, code: 'ROLE_MISSING' };
    if (role.id === guild?.id) return { ok: false, code: 'ROLE_EVERYONE' };
    if (role.managed === true) return { ok: false, code: 'ROLE_MANAGED' };
    if (BLOCKED_PERMISSIONS.some((name) => has(role, name))) return { ok: false, code: 'ROLE_DANGEROUS' };
    const me = guild?.members?.me;
    if (!me || !has(me, 'ManageRoles')) return { ok: false, code: 'BOT_NO_MANAGE_ROLES' };
    const highest = me.roles?.highest;
    if (!highest || !(Number(highest.position) > Number(role.position))) return { ok: false, code: 'ROLE_TOO_HIGH' };
    return { ok: true };
}

/**
 * May `member` put `role` on a panel? Discord lets a member give out only roles
 * below their own highest role; a panel must not be a way around that.
 */
export function checkActorRole(guild, member, role) {
    if (!member) return { ok: true };
    if (guild?.ownerId && member.id === guild.ownerId) return { ok: true };
    const highest = member.roles?.highest;
    if (!highest || !(Number(highest.position) > Number(role.position))) return { ok: false, code: 'ACTOR_TOO_LOW' };
    return { ok: true };
}

/** `{role}`, `{missing: true}` (Discord says it does not exist) or `{error}` (nothing is known). */
export async function resolveRole(guild, roleId) {
    const cached = guild?.roles?.cache?.get?.(roleId);
    if (cached) return { role: cached };
    if (typeof guild?.roles?.fetch !== 'function') return { missing: true };
    try {
        const fetched = await guild.roles.fetch(roleId);
        if (!fetched) return { missing: true };
        return { role: fetched };
    } catch (error) {
        if (Number(error?.code) === UNKNOWN_ROLE) return { missing: true };
        return { error };
    }
}

function assertRoleAllowed(guild, role, actor) {
    const check = checkPanelRole(guild, role);
    if (!check.ok) throw fail('Role refused for panel', 'REACTROLES_ROLE_REFUSED', { reason: check.code, roleId: role?.id });
    const mine = checkActorRole(guild, actor, role);
    if (!mine.ok) throw fail('Role above the member who asked', 'REACTROLES_ROLE_REFUSED', { reason: mine.code, roleId: role.id });
}

function cleanText(value, max, code) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < 1 || text.length > max) throw fail('Invalid panel text', code);
    return text;
}

// ---- the Discord message ---------------------------------------------------------

export function botCanPostIn(guild, channel) {
    const me = guild.members?.me;
    if (!me || typeof channel?.permissionsFor !== 'function') return false;
    return Boolean(channel.permissionsFor(me)?.has([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ]));
}

/**
 * Where the panel message is.
 * `{state: 'ok', channel, message}`, `{state: 'message_missing', channel}`, `{state: 'channel_missing'}`
 * or `{state: 'unknown', error}` when Discord could not be asked.
 */
export async function locatePanel(guild, panel) {
    let channel = guild.channels?.cache?.get?.(panel.channelId) ?? null;
    if (!channel) {
        try {
            channel = await guild.channels.fetch(panel.channelId);
        } catch (error) {
            if (Number(error?.code) === UNKNOWN_CHANNEL) return { state: 'channel_missing' };
            return { state: 'unknown', error };
        }
        if (!channel) return { state: 'channel_missing' };
    }
    if (typeof channel.messages?.fetch !== 'function') return { state: 'channel_missing' };
    try {
        const message = await channel.messages.fetch(panel.messageId);
        if (!message) return { state: 'message_missing', channel };
        return { state: 'ok', channel, message };
    } catch (error) {
        if (Number(error?.code) === UNKNOWN_MESSAGE) return { state: 'message_missing', channel };
        if (Number(error?.code) === UNKNOWN_CHANNEL) return { state: 'channel_missing' };
        return { state: 'unknown', error, channel };
    }
}

/** Title and description as the posted message shows them (for panels stored before the text was kept). */
function shownText(message) {
    const embed = message?.embeds?.[0];
    const text = {};
    if (typeof embed?.title === 'string' && embed.title.trim() && embed.title.length <= MAX_TITLE) text.title = embed.title.trim();
    if (typeof embed?.description === 'string' && embed.description.trim() && embed.description.length <= MAX_DESCRIPTION) text.description = embed.description.trim();
    return text;
}

/** The roles of a panel that exist in the server, in stored order. Unknown lookups are left out as well. */
async function existingRoles(guild, panel) {
    const roles = [];
    for (const id of panel.roles) {
        const found = await resolveRole(guild, id);
        if (found.role) roles.push(found.role);
    }
    return roles;
}

function buildPanelMessage(panel, roles) {
    const embed = new EmbedBuilder()
        .setTitle(panel.title ?? DEFAULT_TITLE)
        .setDescription(panel.description ?? DEFAULT_DESCRIPTION)
        .setColor(getColor('info'))
        .addFields({ name: 'Available Roles', value: roles.map((role) => `• ${role}`).join('\n').slice(0, 1024) })
        .setFooter({ text: 'Select roles from the dropdown menu below' });
    const menu = new StringSelectMenuBuilder()
        .setCustomId(PANEL_SELECT_ID)
        .setPlaceholder('Select your roles')
        .setMinValues(0)
        .setMaxValues(roles.length)
        .addOptions(roles.map((role) => ({
            label: String(role.name ?? role.id).slice(0, 100),
            description: `Add/remove the ${role.name} role`.slice(0, 100),
            value: role.id,
            emoji: '🎭',
        })));
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

/**
 * Draw the stored panel onto its message.
 * `{state: 'updated'}` or `{state: 'missing' | 'channel_missing' | 'no_roles' | 'unknown' | 'failed'}`. Never throws.
 */
async function redraw(guild, panel, located = null) {
    try {
        const where = located ?? await locatePanel(guild, panel);
        if (where.state === 'message_missing') return { state: 'missing' };
        if (where.state !== 'ok') return { state: where.state };
        const roles = await existingRoles(guild, panel);
        if (roles.length === 0) return { state: 'no_roles' };
        await where.message.edit(buildPanelMessage(panel, roles));
        return { state: 'updated', url: where.message.url ?? null };
    } catch (error) {
        if (Number(error?.code) === UNKNOWN_MESSAGE) return { state: 'missing' };
        logger.warn(`[REACTROLES] Could not redraw panel ${panel.messageId}: ${error?.message ?? error}`);
        return { state: 'failed' };
    }
}

async function removeMessage(message) {
    try {
        await message.delete();
        return true;
    } catch (error) {
        if (Number(error?.code) === UNKNOWN_MESSAGE) return true;
        logger.warn(`[REACTROLES] Could not delete message ${message?.id}: ${error?.message ?? error}`);
        return false;
    }
}

function discordFailure(error) {
    return fail('Discord refused the request', 'REACTROLES_DISCORD', { cause: error });
}

// ---- reading ----------------------------------------------------------------------

/**
 * The stored panels next to what Discord shows. Reads only; nothing is written, edited or deleted.
 * Each panel gets `status` (`ok`, `message_missing`, `channel_missing`, `unknown`), the text it shows
 * and its roles with a reason when a role cannot be handed out.
 */
export async function inspectPanels(client, guild) {
    const { panels, rejected } = await readPanels(client, guild.id);
    const view = [];
    for (const panel of panels) {
        const where = await locatePanel(guild, panel);
        const shown = where.state === 'ok' ? shownText(where.message) : {};
        const roles = [];
        for (const id of panel.roles) {
            const found = await resolveRole(guild, id);
            if (found.role) {
                const check = checkPanelRole(guild, found.role);
                roles.push({ id, name: String(found.role.name ?? id), ok: check.ok, reason: check.ok ? null : check.code });
            } else {
                roles.push({ id, name: null, ok: false, reason: found.missing ? 'ROLE_MISSING' : 'ROLE_UNKNOWN' });
            }
        }
        view.push({
            ...panel,
            revision: revisionOf(panel),
            status: where.state,
            channel: where.channel ?? guild.channels?.cache?.get?.(panel.channelId) ?? null,
            url: where.state === 'ok' ? where.message.url ?? null : null,
            title: panel.title ?? shown.title ?? null,
            description: panel.description ?? shown.description ?? null,
            roleStates: roles,
        });
    }
    return { panels: view, rejected };
}

// ---- changes ----------------------------------------------------------------------

/**
 * Post a new panel and store it.
 * The message is sent first because its id is the key of the record; if the record cannot be stored
 * the message is deleted again, and if that fails too the error says a message was left behind.
 */
export async function createPanel(client, guild, { channel, title, description, roles, actor = null } = {}) {
    const cleanTitle = cleanText(title, MAX_TITLE, 'REACTROLES_TITLE');
    const cleanDescription = cleanText(description, MAX_DESCRIPTION, 'REACTROLES_DESCRIPTION');
    // The server's own copy of the channel: an object from elsewhere is not trusted.
    const target = guild.channels?.cache?.get?.(channel?.id) ?? null;
    if (!target || !PANEL_CHANNEL_TYPES.includes(target.type)) throw fail('Invalid panel channel', 'REACTROLES_CHANNEL');
    const unique = [...new Map((Array.isArray(roles) ? roles : []).filter(Boolean).map((role) => [role.id, role])).values()];
    if (unique.length === 0) throw fail('No roles', 'REACTROLES_NO_ROLES');
    if (unique.length > MAX_ROLES) throw fail('Too many roles', 'REACTROLES_ROLE_LIMIT');
    for (const role of unique) assertRoleAllowed(guild, role, actor);
    if (!botCanPostIn(guild, target)) throw fail('Bot cannot post in the panel channel', 'REACTROLES_BOT_PERMISSION');

    // Checked before posting so that a full server does not get a message that is deleted a moment later.
    const before = await readPanels(client, guild.id);
    if (before.panels.length >= MAX_PANELS) throw fail('Panel limit reached', 'REACTROLES_LIMIT', { limit: MAX_PANELS });

    const draft = { guildId: guild.id, channelId: target.id, roles: unique.map((role) => role.id), title: cleanTitle, description: cleanDescription };
    let message;
    try {
        message = await target.send(buildPanelMessage(draft, unique));
    } catch (error) {
        throw discordFailure(error);
    }

    const panel = { ...draft, messageId: message.id, createdAt: new Date().toISOString() };
    try {
        await mutatePanels(client, guild.id, (panels) => {
            if (panels.length >= MAX_PANELS) throw fail('Panel limit reached', 'REACTROLES_LIMIT', { limit: MAX_PANELS });
            return { put: [panel] };
        });
    } catch (error) {
        if (await removeMessage(message)) throw error;
        throw fail('Panel message left behind', 'REACTROLES_MESSAGE_LEFT', { cause: error, url: message.url ?? null, messageId: message.id });
    }
    return { panel, message, roles: unique };
}

/** Run a change on one stored panel. `change(panel)` edits the copy it gets or throws. */
async function changePanel(client, guild, messageId, { revision = null, fallbackText = {} } = {}, change) {
    return mutatePanels(client, guild.id, (panels) => {
        const panel = panels.find((entry) => entry.messageId === messageId);
        if (!panel) throw fail('Panel not found', 'REACTROLES_MISSING');
        if (revision && revision !== revisionOf(panel)) throw fail('Panel changed', 'REACTROLES_STALE');
        change(panel);
        // Panels stored before the text was kept get it from the message they show.
        if (!panel.title && fallbackText.title) panel.title = fallbackText.title;
        if (!panel.description && fallbackText.description) panel.description = fallbackText.description;
        panel.updatedAt = new Date().toISOString();
        return { put: [panel], result: panel };
    });
}

async function stored(client, guild, messageId) {
    if (!isSnowflake(messageId)) throw fail('Panel not found', 'REACTROLES_MISSING');
    const panel = await readPanel(client, guild.id, messageId);
    if (!panel) throw fail('Panel not found', 'REACTROLES_MISSING');
    return panel;
}

/** Add a role to a panel. Returns `{panel, message}`; `message.state` says whether the posted panel shows it. */
export async function addPanelRole(client, guild, messageId, role, { revision = null, actor = null } = {}) {
    assertRoleAllowed(guild, role, actor);
    const current = await stored(client, guild, messageId);
    const where = await locatePanel(guild, current);
    const panel = await changePanel(client, guild, messageId, { revision, fallbackText: shownText(where.message) }, (entry) => {
        if (entry.roles.includes(role.id)) throw fail('Role already on panel', 'REACTROLES_ROLE_DUPLICATE');
        if (entry.roles.length >= MAX_ROLES) throw fail('Too many roles', 'REACTROLES_ROLE_LIMIT');
        entry.roles.push(role.id);
    });
    return { panel, message: await redraw(guild, panel, where) };
}

/** Take a role off a panel. The last role is refused: an empty menu cannot be posted. */
export async function removePanelRole(client, guild, messageId, roleId, { revision = null } = {}) {
    const current = await stored(client, guild, messageId);
    const where = await locatePanel(guild, current);
    const panel = await changePanel(client, guild, messageId, { revision, fallbackText: shownText(where.message) }, (entry) => {
        if (!entry.roles.includes(roleId)) throw fail('Role not on panel', 'REACTROLES_ROLE_NOT_ON_PANEL');
        if (entry.roles.length === 1) throw fail('Last role', 'REACTROLES_LAST_ROLE');
        entry.roles = entry.roles.filter((id) => id !== roleId);
    });
    return { panel, message: await redraw(guild, panel, where) };
}

/** Change title and description. */
export async function editPanelText(client, guild, messageId, { title, description, revision = null } = {}) {
    const cleanTitle = cleanText(title, MAX_TITLE, 'REACTROLES_TITLE');
    const cleanDescription = cleanText(description, MAX_DESCRIPTION, 'REACTROLES_DESCRIPTION');
    const panel = await changePanel(client, guild, messageId, { revision }, (entry) => {
        entry.title = cleanTitle;
        entry.description = cleanDescription;
    });
    return { panel, message: await redraw(guild, panel) };
}

/** Draw the stored panel onto its message again. Stores the shown text for panels that had none stored. */
export async function refreshPanelMessage(client, guild, messageId) {
    let panel = await stored(client, guild, messageId);
    const where = await locatePanel(guild, panel);
    const text = shownText(where.message);
    if ((!panel.title && text.title) || (!panel.description && text.description)) {
        panel = await changePanel(client, guild, messageId, { fallbackText: text }, () => {});
    }
    return { panel, message: await redraw(guild, panel, where) };
}

/**
 * Delete a panel: the Discord message first, then the record.
 * If Discord refuses or cannot be asked, nothing is changed. A message that is already gone is fine.
 */
export async function deletePanel(client, guild, messageId, { revision = null } = {}) {
    const panel = await stored(client, guild, messageId);
    if (revision && revision !== revisionOf(panel)) throw fail('Panel changed', 'REACTROLES_STALE');
    const where = await locatePanel(guild, panel);
    if (where.state === 'unknown') throw fail('Panel message could not be checked', 'REACTROLES_UNCERTAIN', { cause: where.error });

    let messageDeleted = false;
    if (where.state === 'ok') {
        try {
            await where.message.delete();
            messageDeleted = true;
        } catch (error) {
            if (Number(error?.code) !== UNKNOWN_MESSAGE) throw discordFailure(error);
        }
    }
    try {
        await mutatePanels(client, guild.id, (panels) => (
            panels.some((entry) => entry.messageId === messageId) ? { remove: [messageId] } : { write: false }
        ));
    } catch (error) {
        throw fail('Record left behind', 'REACTROLES_RECORD_LEFT', { cause: error });
    }
    return { panel, messageDeleted, title: panel.title ?? shownText(where.message).title ?? null };
}

/**
 * Post the panel again after its message was deleted. The record moves to the new message id.
 * Refused while the old message still exists or cannot be checked.
 */
export async function repostPanel(client, guild, messageId) {
    const panel = await stored(client, guild, messageId);
    const where = await locatePanel(guild, panel);
    if (where.state === 'ok') throw fail('Panel message still exists', 'REACTROLES_NOT_MISSING');
    if (where.state === 'channel_missing') throw fail('Panel channel missing', 'REACTROLES_CHANNEL_MISSING');
    if (where.state === 'unknown') throw fail('Panel message could not be checked', 'REACTROLES_UNCERTAIN', { cause: where.error });
    if (!botCanPostIn(guild, where.channel)) throw fail('Bot cannot post in the panel channel', 'REACTROLES_BOT_PERMISSION');

    const roles = await existingRoles(guild, panel);
    if (roles.length === 0) throw fail('No roles left', 'REACTROLES_ROLES_GONE');

    let message;
    try {
        message = await where.channel.send(buildPanelMessage(panel, roles));
    } catch (error) {
        throw discordFailure(error);
    }
    const moved = { ...panel, messageId: message.id, updatedAt: new Date().toISOString() };
    try {
        await mutatePanels(client, guild.id, (panels) => {
            // Someone else reposted or deleted it in the meantime.
            if (!panels.some((entry) => entry.messageId === messageId)) throw fail('Panel not found', 'REACTROLES_MISSING');
            return { remove: [messageId], put: [moved] };
        });
    } catch (error) {
        if (await removeMessage(message)) throw error;
        throw fail('Panel message left behind', 'REACTROLES_MESSAGE_LEFT', { cause: error, url: message.url ?? null, messageId: message.id });
    }
    return { panel: moved, message };
}

// ---- a member's choice -------------------------------------------------------------

const memberQueues = new Map();

/** One choice at a time per member, so two quick submits do not interleave their role changes. */
function inMemberOrder(key, run) {
    const previous = memberQueues.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => {});
    memberQueues.set(key, tail);
    tail.then(() => {
        if (memberQueues.get(key) === tail) memberQueues.delete(key);
    });
    return next;
}

/**
 * Make the member's panel roles match what they selected.
 *
 * Returns `null` when no panel is stored for the message, otherwise
 * `{added, removed, skipped, failed}`: lists of `{id, name, reason?}`.
 * A role the bot may not hand out (see checkPanelRole) is not touched in either direction.
 * Throws when the database cannot be read: "no panel" must never be guessed.
 */
export async function applyMemberChoice(client, guild, member, messageId, selectedIds) {
    const panel = await readPanel(client, guild.id, messageId);
    if (!panel) return null;
    const wanted = new Set((Array.isArray(selectedIds) ? selectedIds : []).filter((id) => panel.roles.includes(id)));

    return inMemberOrder(`${guild.id}:${member.id}`, async () => {
        const outcome = { added: [], removed: [], skipped: [], failed: [] };
        for (const id of panel.roles) {
            const holds = member.roles.cache.has(id);
            const wants = wanted.has(id);
            if (holds === wants) continue;

            const found = await resolveRole(guild, id);
            if (!found.role) {
                // A role that is gone cannot be held; only a wish to get it is worth reporting.
                if (wants || found.error) outcome.skipped.push({ id, name: null, reason: found.missing ? 'ROLE_MISSING' : 'ROLE_UNKNOWN' });
                continue;
            }
            const entry = { id, name: String(found.role.name ?? id) };
            const check = checkPanelRole(guild, found.role);
            if (!check.ok) {
                outcome.skipped.push({ ...entry, reason: check.code });
                continue;
            }
            try {
                if (wants) {
                    await member.roles.add(found.role, 'Reaction roles panel');
                    outcome.added.push(entry);
                } else {
                    await member.roles.remove(found.role, 'Reaction roles panel');
                    outcome.removed.push(entry);
                }
            } catch (error) {
                logger.warn(`[REACTROLES] Could not ${wants ? 'give' : 'take'} role ${id} for ${member.id}: ${error?.message ?? error}`);
                outcome.failed.push({ ...entry, wanted: wants });
            }
        }
        return outcome;
    });
}

/** A one-line summary for the startup log. Reads only. */
export async function summarizePanels(client, guild) {
    const { panels, rejected } = await inspectPanels(client, guild);
    const count = (status) => panels.filter((panel) => panel.status === status).length;
    return {
        stored: panels.length,
        ok: count('ok'),
        messageMissing: count('message_missing'),
        channelMissing: count('channel_missing'),
        unknown: count('unknown'),
        unreadable: rejected,
    };
}
