/**
 * Canonical database key registry.
 * All storage keys should be built through these helpers.
 */

export const getGuildConfigKey = (guildId) => `guild:${guildId}:config`;
export const getGuildBirthdaysKey = (guildId) => `guild:${guildId}:birthdays`;
export const getBirthdayLeftBackupKey = (guildId) => `guild:${guildId}:birthdays:left`;
export const getBirthdayTrackingKey = (guildId) => `guild:${guildId}:birthdays:tracking`;

export function getTicketKey(guildId, channelId) {
    return `guild:${guildId}:ticket:${channelId}`;
}

export function getTicketCounterKey(guildId) {
    return `guild:${guildId}:ticket:counter`;
}

export function getInviteTrackingKey(guildId) {
    return `guild:${guildId}:invites`;
}

export function getMemberInvitesKey(guildId, userId) {
    return `guild:${guildId}:invites:${userId}`;
}

export function getInviteUsesKey(guildId, inviteCode) {
    return `guild:${guildId}:invite_uses:${inviteCode}`;
}

export function getFakeAccountKey(guildId, userId) {
    return `guild:${guildId}:fake_account:${userId}`;
}

export function getEconomyKey(guildId, userId) {
    return `guild:${guildId}:economy:${userId}`;
}

export function getEconomyPrefix(guildId) {
    return `guild:${guildId}:economy:`;
}

export function getAFKKey(guildId, userId) {
    return `guild:${guildId}:afk:${userId}`;
}

export function getWelcomeConfigKey(guildId) {
    return `guild:${guildId}:welcome`;
}

export function getLevelingKey(guildId) {
    return `guild:${guildId}:leveling:config`;
}

export function getUserLevelKey(guildId, userId) {
    return `guild:${guildId}:leveling:users:${userId}`;
}

export function getUserLevelPrefix(guildId) {
    return `guild:${guildId}:leveling:users:`;
}

// Role applications build their own keys (src/services/applications/store.js); this prefix is what
// the guild data reset uses to find them.
export function getApplicationsPrefix(guildId) {
    return `guild:${guildId}:applications:`;
}

export function getJoinToCreateConfigKey(guildId) {
    return `guild:${guildId}:jointocreate`;
}

export function getJoinToCreateChannelsKey(guildId) {
    return `guild:${guildId}:jointocreate:channels`;
}

export function getWarningsKey(guildId, userId) {
    return `guild:${guildId}:warnings:${userId}`;
}

export function getWarningsPrefix(guildId) {
    return `guild:${guildId}:warnings:`;
}

export function getUserNotesKey(guildId, userId) {
    return `guild:${guildId}:usernotes:${userId}`;
}

export function getUserNotesListKey(guildId) {
    return `guild:${guildId}:usernotes:list`;
}

export function getReactionRoleKey(guildId, messageId) {
    return `guild:${guildId}:reaction_roles:${messageId}`;
}

export function getReactionRolesPrefix(guildId) {
    return `guild:${guildId}:reaction_roles:`;
}

export function getServerCountersKey(guildId) {
    return `guild:${guildId}:counters`;
}

export function getGiveawayEntryKey(userId, giveawayId) {
    return `giveaway:${userId}:${giveawayId}`;
}

export function getGiveawayLockKey(messageId) {
    return `giveaway:lock:${messageId}`;
}

/**
 * Legacy key patterns mapped to canonical builders.
 * Used by migration script and read-time fallback.
 */
export const LEGACY_KEY_RESOLVERS = [
    {
        pattern: /^economy:([^:]+):([^:]+)$/,
        toCanonical: ([, guildId, userId]) => getEconomyKey(guildId, userId),
    },
    {
        pattern: /^birthdays:([^:]+)$/,
        toCanonical: ([, guildId]) => getGuildBirthdaysKey(guildId),
    },
    {
        pattern: /^([^:]+):leveling:users:([^:]+)$/,
        toCanonical: ([, guildId, userId]) => getUserLevelKey(guildId, userId),
        skipIf: (guildId) => guildId === 'guild',
    },
    {
        pattern: /^moderation:warnings:([^:]+):([^:]+)$/,
        toCanonical: ([, guildId, userId]) => getWarningsKey(guildId, userId),
    },
    {
        // Specific list key must precede the general two-part note pattern.
        pattern: /^moderation_user_notes_list_([^_]+)$/,
        toCanonical: ([, guildId]) => getUserNotesListKey(guildId),
    },
    {
        pattern: /^moderation_user_notes_([^_]+)_([^_]+)$/,
        toCanonical: ([, guildId, userId]) => getUserNotesKey(guildId, userId),
    },
    {
        pattern: /^reaction_roles:([^:]+):([^:]+)$/,
        toCanonical: ([, guildId, messageId]) => getReactionRoleKey(guildId, messageId),
    },
    {
        pattern: /^counters:([^:]+)$/,
        toCanonical: ([, guildId]) => getServerCountersKey(guildId),
    },
    {
        pattern: /^bday-role-tracking-([^:]+)$/,
        toCanonical: ([, guildId]) => getBirthdayTrackingKey(guildId),
    },
];

/**
 * Returns the canonical key for a legacy or already-canonical key.
 */
export function canonicalizeKey(key) {
    if (typeof key !== 'string' || !key) {
        return key;
    }

    for (const { pattern, toCanonical, skipIf } of LEGACY_KEY_RESOLVERS) {
        const match = key.match(pattern);
        if (!match) continue;
        if (skipIf?.(match[1])) continue;
        return toCanonical(match);
    }

    return key;
}

/**
 * Returns legacy key variants that may still hold data for a canonical key.
 */
export function getLegacyVariantsForCanonical(canonicalKey) {
    if (typeof canonicalKey !== 'string') return [];
    let match;
    if ((match = canonicalKey.match(/^guild:([^:]+):economy:([^:]+)$/))) return [`economy:${match[1]}:${match[2]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):birthdays$/))) return [`birthdays:${match[1]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):leveling:users:([^:]+)$/))) return [`${match[1]}:leveling:users:${match[2]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):warnings:([^:]+)$/))) return [`moderation:warnings:${match[1]}:${match[2]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):usernotes:list$/))) return [`moderation_user_notes_list_${match[1]}`, `moderation_user_notes_${match[1]}_list`];
    if ((match = canonicalKey.match(/^guild:([^:]+):usernotes:([^:]+)$/))) return [`moderation_user_notes_${match[1]}_${match[2]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):reaction_roles:([^:]+)$/))) return [`reaction_roles:${match[1]}:${match[2]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):counters$/))) return [`counters:${match[1]}`];
    if ((match = canonicalKey.match(/^guild:([^:]+):birthdays:tracking$/))) return [`bday-role-tracking-${match[1]}`];
    return [];
}
