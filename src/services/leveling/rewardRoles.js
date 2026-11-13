// rewardRoles.js — one place that decides whether a level reward role may be
// given and that gives it. Discord and the database are not one transaction:
// every function here is safe to repeat and never removes a role.

import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';

export const MAX_REWARD_LEVEL = 500;

// Same list as reaction roles: a reward must never hand out server control.
export const REWARD_ROLE_BLOCKED_PERMISSIONS = [
    'Administrator',
    'ManageGuild',
    'ManageRoles',
    'ManageChannels',
    'ManageWebhooks',
    'BanMembers',
    'KickMembers',
];

const REASONS = {
    ROLE_MISSING: 'The role no longer exists.',
    ROLE_EVERYONE: 'The @everyone role cannot be a reward.',
    ROLE_MANAGED: 'The role is managed by an integration and cannot be assigned.',
    ROLE_DANGEROUS: 'The role grants server management or moderation permissions.',
    BOT_MEMBER_UNKNOWN: 'The bot member is not available for this server.',
    BOT_NO_MANAGE_ROLES: 'The bot lacks the Manage Roles permission.',
    ROLE_TOO_HIGH: 'The role is not below the bot\'s highest role.',
};

function refusal(code, extra = {}) {
    return { ok: false, code, message: REASONS[code], ...extra };
}

function hasPermission(holder, name) {
    try {
        return holder?.permissions?.has?.(PermissionFlagsBits[name]) === true;
    } catch {
        return false;
    }
}

/**
 * Decide whether `role` may be used as a level reward in `guild` right now.
 * Returns `{ok:true}` or `{ok:false, code, message}`. Never throws.
 */
export function checkRewardRole(guild, role) {
    if (!role || typeof role.id !== 'string') return refusal('ROLE_MISSING');
    if (role.id === guild?.id) return refusal('ROLE_EVERYONE');
    if (role.managed === true) return refusal('ROLE_MANAGED');

    const dangerous = REWARD_ROLE_BLOCKED_PERMISSIONS.filter(name => hasPermission(role, name));
    if (dangerous.length > 0) return refusal('ROLE_DANGEROUS', { permissions: dangerous });

    const me = guild?.members?.me;
    if (!me) return refusal('BOT_MEMBER_UNKNOWN');
    if (!hasPermission(me, 'ManageRoles')) return refusal('BOT_NO_MANAGE_ROLES');

    let above = false;
    try {
        above = me.roles?.highest?.comparePositionTo?.(role) > 0;
    } catch {
        above = false;
    }
    if (!above) return refusal('ROLE_TOO_HIGH');

    return { ok: true };
}

/**
 * Valid reward entries of a leveling config, lowest level first.
 * Entries with an unusable level or role ID are left out.
 */
export function listRewardEntries(config) {
    const rewards = config?.roleRewards;
    if (!rewards || typeof rewards !== 'object' || Array.isArray(rewards)) return [];

    const entries = [];
    for (const [key, roleId] of Object.entries(rewards)) {
        const level = Number(key);
        if (!Number.isInteger(level) || level < 1 || level > 1000) continue;
        if (typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId)) continue;
        entries.push({ level, roleId });
    }
    return entries.sort((a, b) => a.level - b.level);
}

/**
 * Find a role in the cache, then at Discord.
 * Returns `{role}`, `{missing:true}` (Discord says it does not exist) or
 * `{error}` (the lookup itself failed, nothing is known).
 */
export async function resolveRewardRole(guild, roleId) {
    const cached = guild?.roles?.cache?.get?.(roleId);
    if (cached) return { role: cached };
    if (typeof guild?.roles?.fetch !== 'function') return { missing: true };

    try {
        const fetched = await guild.roles.fetch(roleId);
        if (!fetched) return { missing: true };
        if (fetched.id !== roleId) return { error: new Error('Role lookup returned a different role') };
        return { role: fetched };
    } catch (error) {
        if (Number(error?.code) === 10011) return { missing: true };
        return { error };
    }
}

/**
 * Give `member` every reward role configured for a level at or below `level`
 * that the member does not have yet.
 *
 * - additive only: a role is never removed, also not after a demotion;
 * - a role that fails `checkRewardRole` is skipped, not attempted;
 * - never throws; Discord failures are returned in `failed`.
 *
 * Returns `{added, skipped, failed}`; each item is `{level, roleId, ...}`.
 */
export async function syncMemberRewardRoles(guild, member, level, config, options = {}) {
    const result = { added: [], skipped: [], failed: [] };
    if (!guild || !member || !Number.isInteger(level) || level < 1) return result;
    if (!config || config.enabled === false) return result;

    const source = typeof options.source === 'string' && options.source ? ` (${options.source})` : '';

    for (const entry of listRewardEntries(config)) {
        if (entry.level > level) break;

        try {
            if (member.roles?.cache?.has?.(entry.roleId)) continue;

            const found = await resolveRewardRole(guild, entry.roleId);
            if (found.error) {
                result.failed.push({ ...entry, code: 'ROLE_LOOKUP_FAILED', message: found.error.message });
                logger.warn(`Could not look up level ${entry.level} reward role ${entry.roleId} in guild ${guild.id}: ${found.error.message}`);
                continue;
            }
            if (found.missing) {
                result.skipped.push({ ...entry, code: 'ROLE_MISSING', message: REASONS.ROLE_MISSING });
                logger.warn(`Level ${entry.level} reward role ${entry.roleId} no longer exists in guild ${guild.id}; configuration preserved.`);
                continue;
            }

            const verdict = checkRewardRole(guild, found.role);
            if (!verdict.ok) {
                result.skipped.push({ ...entry, code: verdict.code, message: verdict.message });
                logger.warn(`Level ${entry.level} reward role ${entry.roleId} not given in guild ${guild.id}: ${verdict.code}`);
                continue;
            }

            await member.roles.add(found.role, `Level ${entry.level} reward${source}`);
            result.added.push({ ...entry, name: found.role.name ?? null });
        } catch (error) {
            result.failed.push({ ...entry, code: 'DISCORD_ERROR', message: error?.message ?? 'Unknown error' });
            logger.warn(`Could not give level ${entry.level} reward role ${entry.roleId} to ${member.id ?? member.user?.id} in guild ${guild.id}: ${error?.message}`);
        }
    }

    return result;
}

/**
 * One line for a Discord reply that tells what happened to reward roles.
 * Returns an empty string when there is nothing to tell.
 */
export function describeRewardSync(result) {
    if (!result) return '';
    const parts = [];
    if (result.added.length > 0) {
        parts.push(`**Reward roles given:** ${result.added.map(item => `<@&${item.roleId}>`).join(', ')}`);
    }
    const problems = [...result.skipped, ...result.failed];
    if (problems.length > 0) {
        const list = problems.map(item => `<@&${item.roleId}> (level ${item.level}: ${item.message})`).join('\n');
        parts.push(`**Reward roles not given:**\n${list}`);
    }
    return parts.join('\n');
}
