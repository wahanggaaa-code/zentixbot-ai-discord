// manage.js — create, change, delete and inspect server stats counters.
//
// One entry point per action, used by the slash command, its confirm button and
// the web dashboard, so the checks and the order of effects are the same
// everywhere. Failures are thrown with a `code`; callers turn it into a message.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { formatCounterChannelName, getCounterBaseName } from '../serverstatsService.js';
import { COUNTER_TYPES, MAX_COUNTERS, fail, mutateCounters, readCounters } from './store.js';
import {
    COUNTER_CHANNEL_TYPES, botCanManageChannel, countFor, countMembers, counterRefresher, findChannel, needsBots,
} from './refresh.js';

const SNOWFLAKE = /^\d{17,20}$/;
const UNKNOWN_CHANNEL = 10003;
const DELETABLE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildText];

/** Message for a failure code, in the language of the caller. Unknown codes get `fallback`. */
export const COUNTER_ERRORS = {
    SERVERSTATS_TYPE: { en: 'Unknown counter type.', id: 'Jenis counter tidak dikenal.' },
    SERVERSTATS_CHANNEL_TYPE: { en: 'Choose a voice or a text channel.', id: 'Pilih channel suara atau channel teks.' },
    SERVERSTATS_CATEGORY: { en: 'Please select a category of this server.', id: 'Pilih kategori dari server ini.' },
    SERVERSTATS_BOT_PERMISSION: {
        en: 'I need **View Channel** and **Manage Channels** there. Nothing was changed.',
        id: 'Bot membutuhkan izin View Channel dan Manage Channels di sana. Tidak ada yang diubah.',
    },
    SERVERSTATS_DUPLICATE: { en: 'A counter of that type already exists for this server.', id: 'Counter dengan jenis itu sudah ada di server ini.' },
    SERVERSTATS_LIMIT: { en: 'This server already has the maximum number of counters.', id: 'Server ini sudah memiliki jumlah counter maksimum.' },
    SERVERSTATS_MISSING: { en: 'That counter no longer exists. Use `/serverstats list` to see the counters.', id: 'Counter itu sudah tidak ada. Muat ulang halaman.' },
    SERVERSTATS_STALE: { en: 'The counters changed in the meantime. Check the list and try again.', id: 'Daftar counter berubah sejak halaman dimuat. Muat ulang, periksa, lalu ulangi.' },
    SERVERSTATS_INVALID: { en: 'The stored counter data needs to be checked before it can be changed.', id: 'Data counter tersimpan perlu diperiksa sebelum dapat diubah.' },
    SERVERSTATS_UNAVAILABLE: { en: 'The database is not available right now. Nothing was changed.', id: 'Database PostgreSQL tidak tersedia. Tidak ada yang diubah.' },
    SERVERSTATS_CHANNEL_FAILED: {
        en: 'Discord refused the channel change. Nothing was changed.',
        id: 'Discord menolak perubahan channel. Tidak ada yang diubah.',
    },
    SERVERSTATS_CHANNEL_LEFT: {
        en: 'The counter could not be saved and the new channel could not be removed again. Please delete that channel by hand.',
        id: 'Counter gagal disimpan dan channel baru tidak dapat dihapus lagi. Hapus channel itu secara manual.',
    },
};

export function counterErrorMessage(error, language, fallback) {
    return COUNTER_ERRORS[error?.code]?.[language] ?? fallback;
}

function botCanCreateIn(guild, category) {
    const me = guild.members?.me;
    if (!me || typeof category?.permissionsFor !== 'function') return false;
    return Boolean(category.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]));
}

/**
 * The stored counters next to what Discord shows. Reads only; nothing is written or renamed.
 * `count` is null when it cannot be known right now, `channel` is null when the bot does not see the channel.
 */
export async function inspectCounters(client, guild, { refresher = counterRefresher } = {}) {
    const { counters, rejected, revision } = await readCounters(client, guild.id);
    // The member list is only read when a stored counter needs the number of bots.
    const stats = await countMembers(guild, { needBots: needsBots(counters.filter((counter) => COUNTER_TYPES.includes(counter.type))) });
    return {
        revision,
        rejected,
        stats,
        counters: counters.map((counter) => {
            const channel = guild.channels.cache.get(counter.channelId) ?? null;
            const known = COUNTER_TYPES.includes(counter.type);
            const count = known ? countFor(counter.type, stats) : null;
            const expectedName = count === null ? null : formatCounterChannelName(counter.type, count);
            return {
                ...counter,
                known,
                count,
                expectedName,
                channel,
                current: Boolean(channel && expectedName !== null && refresher.showsName(channel, expectedName)),
                botCanManage: channel ? botCanManageChannel(guild, channel) : null,
                nextRenameAt: refresher.nextRenameAt(counter.channelId),
            };
        }),
    };
}

/**
 * Remove the records of counters whose channel Discord reports as gone.
 * A channel that merely cannot be looked up right now keeps its record.
 */
export async function pruneMissingCounters(client, guild, { refresher = counterRefresher } = {}) {
    const { counters } = await readCounters(client, guild.id);
    const gone = [];
    for (const counter of counters) {
        const found = await findChannel(guild, counter.channelId);
        if (found.missing) gone.push(counter);
    }
    if (!gone.length) return [];

    const removed = await mutateCounters(client, guild.id, (current) => {
        const isGone = (counter) => gone.some((entry) => entry.id === counter.id && entry.channelId === counter.channelId);
        const dropped = current.filter(isGone);
        if (!dropped.length) return { write: false, result: [] };
        return { counters: current.filter((counter) => !isGone(counter)), result: dropped };
    });
    for (const counter of removed) {
        refresher.forgetChannel(counter.channelId);
        logger.info(`[SERVERSTATS] Removed counter ${counter.id} (${counter.type}) of guild ${guild.id}: channel ${counter.channelId} no longer exists`);
    }
    return removed;
}

/** The record of a channel that was just deleted in Discord, if it was a counter. */
export async function forgetDeletedCounterChannel(client, guildId, channelId, { refresher = counterRefresher } = {}) {
    const { counters } = await readCounters(client, guildId);
    if (!counters.some((counter) => counter.channelId === channelId)) return null;
    const removed = await mutateCounters(client, guildId, (current) => {
        const hit = current.find((counter) => counter.channelId === channelId);
        if (!hit) return { write: false, result: null };
        return { counters: current.filter((counter) => counter.channelId !== channelId), result: hit };
    });
    refresher.forgetChannel(channelId);
    return removed;
}

function newCounterId(existing) {
    let stamp = Date.now();
    while (existing.some((counter) => counter.id === String(stamp))) stamp += 1;
    return String(stamp);
}

/**
 * Create a counter: a new channel in `categoryId` plus its record.
 *
 * Order: checks, channel, record. When the record cannot be stored the new
 * channel is deleted again; if that fails too the error says so
 * (SERVERSTATS_CHANNEL_LEFT, with `channelId`).
 */
export async function createCounter(client, guild, { type, channelType, categoryId, actor = 'unknown' }, { refresher = counterRefresher } = {}) {
    if (!COUNTER_TYPES.includes(type)) throw fail('Unknown counter type', 'SERVERSTATS_TYPE');
    if (!Object.hasOwn(COUNTER_CHANNEL_TYPES, channelType)) throw fail('Unknown channel type', 'SERVERSTATS_CHANNEL_TYPE');
    const category = SNOWFLAKE.test(categoryId || '') ? guild.channels.cache.get(categoryId) : null;
    if (category?.type !== ChannelType.GuildCategory) throw fail('Not a category of this guild', 'SERVERSTATS_CATEGORY');
    if (!botCanCreateIn(guild, category)) throw fail('Bot cannot manage channels in the category', 'SERVERSTATS_BOT_PERMISSION');

    // A counter whose channel was deleted while the bot was away must not block a new one.
    await pruneMissingCounters(client, guild, { refresher });
    const { counters } = await readCounters(client, guild.id);
    const duplicate = counters.find((counter) => counter.type === type);
    if (duplicate) throw fail('Counter type exists', 'SERVERSTATS_DUPLICATE', { channelId: duplicate.channelId });
    if (counters.length >= MAX_COUNTERS) throw fail('Counter limit reached', 'SERVERSTATS_LIMIT');

    // Created with its final name where the count is known: a rename right after creation would use up the rename allowance.
    const stats = await countMembers(guild, { needBots: type !== 'members' });
    const count = countFor(type, stats);
    const requestedName = count === null ? getCounterBaseName(type) : formatCounterChannelName(type, count);

    let channel;
    try {
        channel = await guild.channels.create({
            name: requestedName,
            type: COUNTER_CHANNEL_TYPES[channelType],
            parent: category.id,
            reason: `Server stats counter created by ${actor}`.slice(0, 500),
        });
    } catch (error) {
        throw fail('Discord refused to create the channel', 'SERVERSTATS_CHANNEL_FAILED', { cause: error });
    }

    let counter;
    try {
        counter = await mutateCounters(client, guild.id, (current) => {
            const taken = current.find((entry) => entry.type === type);
            if (taken) throw fail('Counter type exists', 'SERVERSTATS_DUPLICATE', { channelId: taken.channelId });
            if (current.length >= MAX_COUNTERS) throw fail('Counter limit reached', 'SERVERSTATS_LIMIT');
            const created = {
                id: newCounterId(current),
                type,
                channelId: channel.id,
                guildId: guild.id,
                createdAt: new Date().toISOString(),
                enabled: true,
            };
            return { counters: [...current, created], result: created };
        });
    } catch (error) {
        try {
            await channel.delete('Server stats counter could not be saved');
        } catch (deleteError) {
            if (deleteError?.code !== UNKNOWN_CHANNEL) {
                logger.error(`[SERVERSTATS] Channel ${channel.id} of an unsaved counter could not be deleted:`, deleteError);
                throw fail('Counter not saved and channel left behind', 'SERVERSTATS_CHANNEL_LEFT', { channelId: channel.id, cause: error });
            }
        }
        throw error;
    }

    if (count !== null) refresher.noteName(channel, requestedName);
    else refresher.schedule(client, guild);
    return { counter, channel, count };
}

/**
 * Change the type of a counter and ask for its channel name to follow.
 * `revision`, when given, must match the stored list (SERVERSTATS_STALE otherwise).
 * Returns `{counter, changed, refresh}`; `refresh` is what happened to the channel name, or null when it is unknown.
 */
export async function changeCounterType(client, guild, counterId, type, { revision = null, refresher = counterRefresher } = {}) {
    if (!COUNTER_TYPES.includes(type)) throw fail('Unknown counter type', 'SERVERSTATS_TYPE');
    const outcome = await mutateCounters(client, guild.id, (current, storedRevision) => {
        if (revision !== null && revision !== storedRevision) throw fail('Counters changed', 'SERVERSTATS_STALE');
        const counter = current.find((entry) => entry.id === counterId);
        if (!counter) throw fail('Counter not found', 'SERVERSTATS_MISSING');
        if (counter.type === type) return { write: false, result: { counter, changed: false, previousType: type } };
        const taken = current.find((entry) => entry.type === type);
        if (taken) throw fail('Counter type exists', 'SERVERSTATS_DUPLICATE', { channelId: taken.channelId });
        const previousType = counter.type;
        counter.type = type;
        counter.updatedAt = new Date().toISOString();
        return { counters: current, result: { counter, changed: true, previousType } };
    });

    let refresh = null;
    try {
        const results = await refresher.run(client, guild);
        refresh = results.find((result) => result.id === counterId) ?? null;
    } catch (error) {
        logger.warn(`[SERVERSTATS] Counter ${counterId} was changed but its channel name could not be refreshed: ${error?.message ?? error}`);
    }
    return { ...outcome, refresh };
}

/**
 * Delete a counter: its channel first, then its record.
 *
 * When Discord refuses to delete the channel nothing is changed, so the
 * counter does not vanish from the bot while its channel stays behind.
 * A channel that is not a voice or text channel is never deleted; only the
 * record goes. Returns `{counter, channelName, channelDeleted}`.
 */
export async function deleteCounter(client, guild, counterId, { actor = 'unknown', revision = null, refresher = counterRefresher } = {}) {
    const { counters, revision: storedRevision } = await readCounters(client, guild.id);
    if (revision !== null && revision !== storedRevision) throw fail('Counters changed', 'SERVERSTATS_STALE');
    const counter = counters.find((entry) => entry.id === counterId);
    if (!counter) throw fail('Counter not found', 'SERVERSTATS_MISSING');

    const found = await findChannel(guild, counter.channelId);
    if (found.error) throw fail('Channel lookup failed', 'SERVERSTATS_CHANNEL_FAILED', { cause: found.error });

    let channelDeleted = false;
    let channelKept = false;
    const channel = found.channel ?? null;
    if (channel) {
        if (!DELETABLE_TYPES.includes(channel.type)) {
            channelKept = true;
        } else {
            if (!botCanManageChannel(guild, channel)) throw fail('Bot cannot delete the channel', 'SERVERSTATS_BOT_PERMISSION');
            try {
                await channel.delete(`Server stats counter deleted by ${actor}`.slice(0, 500));
                channelDeleted = true;
            } catch (error) {
                if (error?.code !== UNKNOWN_CHANNEL) throw fail('Discord refused to delete the channel', 'SERVERSTATS_CHANNEL_FAILED', { cause: error });
            }
        }
    }

    // The channel is gone from here on. If this fails, the channel delete event and the scheduled check remove the record.
    await mutateCounters(client, guild.id, (current) => {
        const hit = current.find((entry) => entry.id === counter.id && entry.channelId === counter.channelId);
        if (!hit) return { write: false, result: null };
        return { counters: current.filter((entry) => entry !== hit), result: hit };
    });
    refresher.forgetChannel(counter.channelId);
    return { counter, channelName: channel?.name ?? null, channelDeleted, channelKept };
}

/** Scheduled upkeep: drop records of deleted channels, then bring every name up to date. */
export async function maintainCounters(client, guild, { refresher = counterRefresher } = {}) {
    const removed = await pruneMissingCounters(client, guild, { refresher });
    const results = await refresher.run(client, guild, { fresh: true });
    return { removed, results };
}
