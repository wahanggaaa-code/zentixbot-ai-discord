// refresh.js — keeps the counter channel names in step with the member count.
//
// A channel name is a scarce thing to change: Discord lets a channel be renamed
// only a few times per ten minutes, and discord.js does not refuse a request
// over that limit, it holds the request until the limit ends. The old code
// renamed inline in the member join and leave handlers, so one busy minute left
// those handlers waiting for minutes with everything after the rename undone.
//
// Here a join or leave only asks for a refresh. Requests are collected, one
// refresh runs at a time per guild, a channel is renamed at most once per
// `minRenameIntervalMs`, at most one rename per channel is ever waiting, and a
// name that had to wait is applied by a later run. State is kept in memory;
// after a restart the first rename of each channel is not held back.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { logEvent, EVENT_TYPES } from '../loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';
import { formatCounterChannelName, getCounterTypeLabel } from '../serverstatsService.js';
import { COUNTER_TYPES, readCounters } from './store.js';

const UNKNOWN_CHANNEL = 10003;
// discord.js waits two minutes for a member list by default; a command or a dashboard page should not.
const MEMBER_FETCH_MS = 15_000;

/**
 * Member counts of a guild. `bots` and `humans` are null when the member list
 * could not be read in full: a partial list would give a number that is wrong.
 */
export async function countMembers(guild, { needBots = true, fresh = false } = {}) {
    const total = Number.isSafeInteger(guild.memberCount) && guild.memberCount >= 0 ? guild.memberCount : null;
    if (!needBots) return { total, bots: null, humans: null };

    let list = guild.members.cache;
    // The cache is complete once it holds as many members as the guild reports.
    if (fresh || total === null || list.size < total) {
        try {
            list = await guild.members.fetch({ time: MEMBER_FETCH_MS });
        } catch (error) {
            logger.warn(`[SERVERSTATS] Member list of guild ${guild.id} could not be fetched: ${error?.message ?? error}`);
            return { total, bots: null, humans: null };
        }
    }
    const bots = list.filter((member) => member.user?.bot).size;
    const all = total ?? list.size;
    return { total: all, bots, humans: Math.max(all - bots, 0) };
}

export function countFor(type, stats) {
    if (type === 'members') return stats.total;
    if (type === 'bots') return stats.bots;
    if (type === 'members_only') return stats.humans;
    return null;
}

export const needsBots = (counters) => counters.some((counter) => counter.type !== 'members');

/** Whether the bot may rename and delete this channel. */
export function botCanManageChannel(guild, channel) {
    const me = guild.members?.me;
    if (!me || typeof channel?.permissionsFor !== 'function') return false;
    return Boolean(channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels]));
}

/** Channel from the cache or from Discord. `{channel}`, `{missing: true}` (Discord says it is gone) or `{error}`. */
export async function findChannel(guild, channelId) {
    const cached = guild.channels.cache.get(channelId);
    if (cached) return { channel: cached };
    try {
        const fetched = await guild.channels.fetch(channelId);
        return fetched ? { channel: fetched } : { missing: true };
    } catch (error) {
        if (error?.code === UNKNOWN_CHANNEL) return { missing: true };
        return { error };
    }
}

export function createCounterRefresher({
    now = Date.now,
    minRenameIntervalMs = 305_000,
    debounceMs = 5_000,
    renameWaitMs = 8_000,
    audit = true,
} = {}) {
    /** channelId → { lastAt, pending, requested, result } */
    const channelState = new Map();
    /** guildId → { timer, timerAt, running, queued, fresh } */
    const guildState = new Map();
    let stopped = false;

    const ofChannel = (id) => {
        if (!channelState.has(id)) channelState.set(id, { lastAt: null, pending: null, requested: null, result: null });
        return channelState.get(id);
    };
    const ofGuild = (id) => {
        if (!guildState.has(id)) guildState.set(id, { timer: null, timerAt: 0, running: null, queued: null, fresh: false });
        return guildState.get(id);
    };

    /**
     * Whether the channel already shows `name`. Discord rewrites the name of a text channel (lower case, dashes), so
     * the name it gave back for the last request counts as showing that request.
     */
    function showsName(channel, name) {
        if (channel.name === name) return true;
        const state = channelState.get(channel.id);
        return Boolean(state && state.requested === name && state.result === channel.name);
    }

    /** Record that `channel` was created or renamed with `requested` as its name. */
    function noteName(channel, requested) {
        const state = ofChannel(channel.id);
        state.requested = requested;
        state.result = channel.name;
    }

    function nextRenameAt(channelId) {
        const state = channelState.get(channelId);
        if (!state || state.lastAt === null) return null;
        const at = state.lastAt + minRenameIntervalMs;
        return at > now() ? at : null;
    }

    async function rename(client, guild, channel, counter, name, count) {
        const state = ofChannel(channel.id);
        if (state.pending) return { status: 'pending' };
        if (showsName(channel, name)) return { status: 'current' };
        const retryAt = nextRenameAt(channel.id);
        if (retryAt !== null) return { status: 'deferred', retryAt };
        if (!botCanManageChannel(guild, channel)) return { status: 'no_permission' };

        state.lastAt = now();
        const request = Promise.resolve()
            .then(() => channel.setName(name, 'Server stats counter'))
            .then((renamed) => {
                state.requested = name;
                state.result = (renamed ?? channel).name;
                if (audit) {
                    Promise.resolve().then(() => logEvent({
                        client,
                        guildId: guild.id,
                        eventType: EVENT_TYPES.COUNTER_UPDATE,
                        data: {
                            title: 'Counter Updated',
                            lines: [
                                formatLogLine('Type', getCounterTypeLabel(counter.type)),
                                formatLogLine('Count', String(count)),
                                formatLogLine('Channel', channel.toString()),
                            ],
                            channelId: channel.id,
                        },
                    })).catch(() => {});
                }
                return 'renamed';
            }, (error) => {
                logger.warn(`[SERVERSTATS] Counter channel ${channel.id} could not be renamed: ${error?.message ?? error}`);
                return 'failed';
            })
            .finally(() => {
                state.pending = null;
            });
        state.pending = request;

        let waitTimer;
        const slow = new Promise((resolve) => {
            waitTimer = setTimeout(() => resolve('slow'), renameWaitMs);
            waitTimer.unref?.();
        });
        const status = await Promise.race([request, slow]);
        clearTimeout(waitTimer);
        if (status === 'slow') {
            // Discord is holding the request. Look again once it is through; the count may have moved on.
            request.then(() => schedule(client, guild));
        }
        return { status };
    }

    async function refreshNow(client, guild, { fresh }) {
        const { counters } = await readCounters(client, guild.id);
        const active = counters.filter((counter) => counter.enabled !== false && COUNTER_TYPES.includes(counter.type));
        if (!active.length) return [];

        const stats = await countMembers(guild, { needBots: needsBots(active), fresh });
        const results = [];
        for (const counter of active) {
            const entry = { id: counter.id, type: counter.type, channelId: counter.channelId };
            const found = await findChannel(guild, counter.channelId);
            if (!found.channel) {
                results.push({ ...entry, status: found.missing ? 'missing' : 'unreachable' });
                continue;
            }
            const count = countFor(counter.type, stats);
            if (count === null) {
                results.push({ ...entry, status: 'count_unknown' });
                continue;
            }
            const name = formatCounterChannelName(counter.type, count);
            results.push({ ...entry, count, name, ...(await rename(client, guild, found.channel, counter, name, count)) });
        }

        const retryAt = Math.min(...results.filter((result) => result.status === 'deferred').map((result) => result.retryAt));
        if (Number.isFinite(retryAt)) schedule(client, guild, retryAt - now() + 250);
        return results;
    }

    /**
     * Refresh the counters of a guild and report what happened to each.
     * Calls made while a refresh is waiting to start share that refresh. Throws when the counters cannot be read.
     */
    function run(client, guild, { fresh = false } = {}) {
        const state = ofGuild(guild.id);
        state.fresh ||= fresh;
        if (state.queued) return state.queued;
        const queued = Promise.resolve(state.running).catch(() => {}).then(() => {
            const options = { fresh: state.fresh };
            state.fresh = false;
            state.queued = null;
            const running = refreshNow(client, guild, options).finally(() => {
                if (state.running === running) state.running = null;
            });
            state.running = running;
            return running;
        });
        state.queued = queued;
        return queued;
    }

    /** Ask for a refresh soon. Returns at once and never throws; a failure is logged. */
    function schedule(client, guild, delayMs = debounceMs) {
        if (stopped || !guild?.id) return;
        const state = ofGuild(guild.id);
        const at = now() + delayMs;
        if (state.timer) {
            if (state.timerAt <= at) return;
            clearTimeout(state.timer);
        }
        state.timerAt = at;
        state.timer = setTimeout(() => {
            state.timer = null;
            run(client, guild).catch((error) => {
                logger.warn(`[SERVERSTATS] Counter refresh failed for guild ${guild.id}: ${error?.message ?? error}`);
            });
        }, Math.max(0, delayMs));
        state.timer.unref?.();
    }

    function forgetChannel(channelId) {
        channelState.delete(channelId);
    }

    /** Cancel every timer. Renames already sent to Discord are not recalled. */
    function stop() {
        stopped = true;
        for (const state of guildState.values()) {
            if (state.timer) clearTimeout(state.timer);
            state.timer = null;
        }
    }

    /** Forget everything remembered about channels and cancel the timers, without stopping. For tests. */
    function reset() {
        for (const state of guildState.values()) {
            if (state.timer) clearTimeout(state.timer);
        }
        guildState.clear();
        channelState.clear();
    }

    return { run, schedule, showsName, noteName, nextRenameAt, forgetChannel, stop, reset, minRenameIntervalMs };
}

/** The refresher used by the bot. */
export const counterRefresher = createCounterRefresher();

export const COUNTER_CHANNEL_TYPES = { voice: ChannelType.GuildVoice, text: ChannelType.GuildText };
