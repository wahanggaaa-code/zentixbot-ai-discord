import { createHash, randomUUID } from 'node:crypto';
import { pgConfig } from '../../config/database/postgres.js';
import { getJoinToCreateConfigKey, getJoinToCreateChannelsKey } from '../../utils/database/keys.js';
import { parseJoinToCreatePending } from '../../utils/joinToCreatePending.js';

/**
 * Join to Create storage protocol (PostgreSQL).
 *
 * One JSONB record per guild lives in temp_data under `guild:{id}:jointocreate`.
 * EVERY writer must go through transaction() below: it takes an advisory lock for
 * the guild, locks the row, validates the whole record and writes it back in one
 * transaction. The generic key/value writer (client.db.set/delete) refuses these
 * keys, so this module is the only way the bot changes Join to Create data.
 *
 * Direct SQL, restores and other software do not honour the advisory lock.
 *
 * Error codes (error.code):
 *   JTC_SCOPE        guild is not the configured home guild
 *   JTC_UNAVAILABLE  PostgreSQL is not available
 *   JTC_INVALID      stored data or input is malformed / too large; nothing was written
 *   JTC_LEGACY       data exists under an unsupported key (cache or :channels)
 *   JTC_EXPIRY       the record has a TTL; refuse to touch it
 *   JTC_STALE        the expected state no longer matches
 *   JTC_MISSING      the trigger is not configured
 *   JTC_CONFLICT     the trigger/owner/channel is already present
 *   JTC_PENDING      a channel create is in flight (or was interrupted); other writes wait
 */

export const JTC_LIMITS = Object.freeze({
    recordBytes: 512 * 1024,
    triggers: 100,
    temporaryChannels: 5000,
    templateLength: 100,
});

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONFIG_FIELDS = ['enabled', 'triggerChannels', 'categoryId', 'channelNameTemplate', 'userLimit', 'bitrate', 'channelOptions'];
const PATCH_FIELDS = ['nameTemplate', 'userLimit', 'bitrate'];

const isId = (value) => typeof value === 'string' && /^\d{17,20}$/.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => fail('JTC_INVALID', 'Join to Create data requires review');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const isValidDate = (value) => Number.isSafeInteger(value) && value >= 0 && !Number.isNaN(new Date(value).getTime());
const isUserLimit = (value) => Number.isInteger(value) && value >= 0 && value <= 99;
const isBitrate = (value) => Number.isInteger(value) && value >= 8000 && value <= 384000;

const defaults = () => ({
    enabled: false,
    triggerChannels: [],
    categoryId: null,
    channelNameTemplate: "{username}'s Room",
    userLimit: 0,
    bitrate: 64000,
    temporaryChannels: {},
    channelOptions: {},
    pendingCreates: {},
});

/** Deterministic JSON so a revision does not depend on object key order. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/** Revision of the administrator-editable configuration only (not channels or pending). */
function configRevisionOf(data) {
    return sha256(canonicalJson(Object.fromEntries(CONFIG_FIELDS.map((field) => [field, data[field]]))));
}

function getPool(client, guildId) {
    if (!isId(guildId) || !isId(client?.homeGuildId) || client.homeGuildId !== guildId) {
        throw fail('JTC_SCOPE', 'Invalid guild scope');
    }
    const db = client?.db;
    const status = db?.getStatus?.();
    if (
        status?.connectionType !== 'postgresql'
        || status.isDegraded
        || !db.isAvailable?.()
        || !db.db?.isAvailable?.()
        || !db.db.pool?.connect
    ) {
        throw fail('JTC_UNAVAILABLE', 'PostgreSQL unavailable');
    }
    return db.db.pool;
}

function validateOptionEntry(value) {
    return isPlainObject(value)
        && (value.nameTemplate === undefined || (typeof value.nameTemplate === 'string' && value.nameTemplate.length <= 1000))
        && (value.userLimit === undefined || isUserLimit(value.userLimit))
        && (value.bitrate === undefined || isBitrate(value.bitrate))
        && (value.categoryId == null || isId(value.categoryId));
}

/** Validate a stored record. Unknown extra fields are preserved, never dropped. */
function validate(data) {
    if (!isPlainObject(data) || (Object.hasOwn(data, 'ok') && Object.hasOwn(data, 'value'))) throw invalid();
    const d = { ...defaults(), ...data };

    if (
        typeof d.enabled !== 'boolean'
        || !Array.isArray(d.triggerChannels)
        || d.triggerChannels.length > JTC_LIMITS.triggers
        || !d.triggerChannels.every(isId)
        || new Set(d.triggerChannels).size !== d.triggerChannels.length
        || (d.categoryId !== null && !isId(d.categoryId))
        || typeof d.channelNameTemplate !== 'string'
        || d.channelNameTemplate.length > 1000
        || !isUserLimit(d.userLimit)
        || !isBitrate(d.bitrate)
        || !isPlainObject(d.channelOptions)
        || !isPlainObject(d.temporaryChannels)
        || !isPlainObject(d.pendingCreates)
    ) throw invalid();

    const options = Object.entries(d.channelOptions);
    const temporary = Object.entries(d.temporaryChannels);
    let pending;
    try {
        pending = parseJoinToCreatePending(d.pendingCreates);
    } catch {
        throw invalid();
    }

    if (options.length > JTC_LIMITS.triggers || temporary.length + pending.length > JTC_LIMITS.temporaryChannels || pending.length > 1) {
        throw invalid();
    }
    for (const [key, value] of options) {
        if (!isId(key) || !validateOptionEntry(value)) throw invalid();
    }

    const owners = new Set();
    for (const [key, value] of temporary) {
        if (
            !isId(key)
            || !isPlainObject(value)
            || !isId(value.ownerId)
            || !isId(value.triggerChannelId)
            || (value.createdAt !== undefined && !isValidDate(value.createdAt))
            || owners.has(value.ownerId)
        ) throw invalid();
        owners.add(value.ownerId);
    }
    for (const [, value] of pending) {
        if (owners.has(value.ownerId)) throw invalid();
        owners.add(value.ownerId);
    }
    return d;
}

function requireIds(...ids) {
    if (!ids.every(isId)) throw invalid();
}

function requireToken(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalid();
}

function requireOptionalRevision(value) {
    if (value === null || value === undefined) return;
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw invalid();
}

function validatePatch(patch) {
    if (!isPlainObject(patch) || !Object.keys(patch).length || Object.keys(patch).some((key) => !PATCH_FIELDS.includes(key))) throw invalid();
    if (Object.hasOwn(patch, 'nameTemplate')) {
        const template = patch.nameTemplate;
        if (typeof template !== 'string' || !template.trim() || template.length > JTC_LIMITS.templateLength || /[\x00-\x1f\x7f]/.test(template)) throw invalid();
    }
    if (Object.hasOwn(patch, 'userLimit') && !isUserLimit(patch.userLimit)) throw invalid();
    if (Object.hasOwn(patch, 'bitrate') && !isBitrate(patch.bitrate)) throw invalid();
}

const ownerHasChannel = (data, ownerId, exceptChannelId = null) =>
    Object.entries(data.temporaryChannels).some(([channelId, info]) => channelId !== exceptChannelId && info.ownerId === ownerId);
const ownerHasPending = (data, ownerId) => Object.values(data.pendingCreates).some((pending) => pending.ownerId === ownerId);
const triggerHasPending = (data, triggerId) => Object.values(data.pendingCreates).some((pending) => pending.triggerId === triggerId);
const triggerIsActive = (data, triggerId) => data.enabled && data.triggerChannels.includes(triggerId);

/** Settings used for a new temporary channel of this trigger (per-trigger option, else guild default). */
export function resolveJoinToCreateOptions(data, triggerId) {
    const option = data.channelOptions?.[triggerId] ?? {};
    return {
        nameTemplate: option.nameTemplate ?? data.channelNameTemplate,
        userLimit: option.userLimit ?? data.userLimit,
        bitrate: option.bitrate ?? data.bitrate,
    };
}

/**
 * Run `fn(data, state)` on the locked record. `fn` mutates `data` and returns
 * `{ write: boolean, value }`. With `allowPending: false` a write is refused
 * while a create reservation exists (JTC_PENDING).
 *
 * If COMMIT fails after being sent, the outcome is unknown: callers must re-read
 * the state before deciding anything; this function never retries.
 */
async function transaction(client, guildId, fn, { allowPending = false } = {}) {
    const key = getJoinToCreateConfigKey(guildId);
    const channelsKey = getJoinToCreateChannelsKey(guildId);
    const limit = JTC_LIMITS.recordBytes;
    const conn = await getPool(client, guildId).connect();
    let begun = false;
    try {
        await conn.query('BEGIN');
        begun = true;
        await conn.query("SET LOCAL lock_timeout = '5s'");
        await conn.query("SET LOCAL statement_timeout = '10s'");
        // Stable namespace per canonical key; also serialises writers while the record is absent.
        await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zentix:jtc:${key}`]);

        const otherData = await conn.query(
            `SELECT 1 FROM ${pgConfig.tables.cache_data} WHERE key = ANY($1::text[])
             UNION ALL SELECT 1 FROM ${pgConfig.tables.temp_data} WHERE key = $2 LIMIT 1`,
            [[key, channelsKey], channelsKey],
        );
        if (otherData.rows.length) throw fail('JTC_LEGACY', 'Conflicting Join to Create data requires review');

        const result = await conn.query(
            `SELECT CASE WHEN octet_length(value::text) <= $2 THEN value ELSE NULL END AS value,
                    CASE WHEN octet_length(value::text) <= $2 THEN value::text ELSE NULL END AS serialized,
                    expires_at IS NOT NULL AS has_expiry
             FROM ${pgConfig.tables.temp_data} WHERE key = $1 FOR UPDATE`,
            [key, limit],
        );
        const row = result.rows[0];
        if (row?.has_expiry) throw fail('JTC_EXPIRY', 'Expiring Join to Create record requires review');

        const data = row ? validate(row.value) : defaults();
        const revision = sha256(row ? `stored:${row.serialized}` : 'missing');
        const pendingBefore = Object.keys(data.pendingCreates).length;
        const outcome = fn(data, { exists: Boolean(row), revision, configRevision: configRevisionOf(data) });

        if (outcome.write) {
            // All other writes wait while a Discord create is in flight; this also
            // keeps the space reserved for its registration.
            if (pendingBefore && !allowPending) throw fail('JTC_PENDING', 'A channel create is pending');

            const text = JSON.stringify(data);
            if (Buffer.byteLength(text, 'utf8') > limit) throw invalid();
            validate(data);
            // PostgreSQL's canonical jsonb text can be larger than JSON.stringify.
            const size = await conn.query('SELECT octet_length($1::jsonb::text) AS bytes', [text]);
            if (size.rows[0].bytes > limit) throw invalid();

            const pending = Object.entries(data.pendingCreates);
            if (pending.length) {
                // Reserve room for the worst-case 20-digit channel ID and date so that
                // recording the result of the create can never fail for lack of space.
                const [token, item] = pending[0];
                let candidate = 99999999999999999999n;
                const completed = JSON.parse(text);
                while (Object.hasOwn(completed.temporaryChannels, String(candidate))) candidate--;
                const recorded = JSON.parse(text);
                recorded.pendingCreates[token] = { ...item, stage: 'created', channelId: String(candidate) };
                delete completed.pendingCreates[token];
                completed.temporaryChannels[String(candidate)] = { ownerId: item.ownerId, triggerChannelId: item.triggerId, createdAt: 8640000000000000 };
                const future = await conn.query(
                    'SELECT octet_length($1::jsonb::text) AS recorded, octet_length($2::jsonb::text) AS completed',
                    [JSON.stringify(recorded), JSON.stringify(completed)],
                );
                if (future.rows[0].recorded > limit || future.rows[0].completed > limit) throw invalid();
            }

            if (row) {
                const updated = await conn.query(
                    `UPDATE ${pgConfig.tables.temp_data} SET value = $2::jsonb WHERE key = $1 AND expires_at IS NULL RETURNING key`,
                    [key, text],
                );
                if (updated.rowCount !== 1) throw fail('JTC_STALE', 'Record changed');
            } else {
                await conn.query(`INSERT INTO ${pgConfig.tables.temp_data} (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)`, [key, text]);
            }
        }

        await conn.query('COMMIT');
        begun = false;
        return outcome.value;
    } catch (error) {
        if (begun) await conn.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        conn.release();
    }
}

/**
 * Safe summary for dashboards: no owner IDs, tokens or arbitrary JSON.
 * `revision` covers the whole record, `configRevision` only the editable
 * configuration. Both are content hashes, not counters: A→B→A is not detected.
 */
export async function inspectJoinToCreate(client, guildId) {
    return transaction(client, guildId, (d, { exists, revision, configRevision }) => ({
        value: {
            exists,
            revision,
            configRevision,
            enabled: d.enabled,
            triggerChannels: [...d.triggerChannels],
            // Effective settings per trigger, read in the same transaction
            // as configRevision so an editor never pairs old values with a
            // new revision.
            triggers: d.triggerChannels.map((channelId) => ({ channelId, ...resolveJoinToCreateOptions(d, channelId) })),
            temporaryCount: Object.keys(d.temporaryChannels).length,
            pendingCreateCount: Object.keys(d.pendingCreates).length,
        },
    }));
}

/**
 * INTERNAL snapshot for the bot runtime. Contains owner IDs and the pending
 * token: never send this object to a browser or write it to logs as a whole.
 */
export async function readJoinToCreateState(client, guildId) {
    return transaction(client, guildId, (d, { exists, revision, configRevision }) => ({
        value: {
            exists,
            revision,
            configRevision,
            enabled: d.enabled,
            triggerChannels: [...d.triggerChannels],
            channelNameTemplate: d.channelNameTemplate,
            userLimit: d.userLimit,
            bitrate: d.bitrate,
            channelOptions: structuredClone(d.channelOptions),
            temporaryChannels: structuredClone(d.temporaryChannels),
            pending: Object.entries(d.pendingCreates).map(([token, item]) => ({ token, ...item })),
        },
    }));
}

/** Configure the single trigger channel of the guild. */
export async function setupJoinToCreate(client, guildId, triggerId, options) {
    requireIds(triggerId);
    validatePatch(options);
    const stored = { ...options };
    return transaction(client, guildId, (d) => {
        if (d.triggerChannels.length || d.enabled || Object.keys(d.pendingCreates).length || Object.hasOwn(d.channelOptions, triggerId)) {
            throw fail('JTC_CONFLICT', 'Trigger or retained options already configured');
        }
        // A channel the bot deletes when it empties cannot also be the trigger.
        if (Object.hasOwn(d.temporaryChannels, triggerId)) throw fail('JTC_CONFLICT', 'Channel is a registered temporary channel');
        d.triggerChannels.push(triggerId);
        d.enabled = true;
        d.channelOptions[triggerId] = stored;
        return { write: true, value: true };
    });
}

/**
 * Patch only the given fields of one trigger. Pass `expectedConfigRevision`
 * (from inspect/read) to refuse the edit when the configuration changed since
 * it was displayed; without it the patch is last-writer-wins per field.
 */
export async function updateJoinToCreate(client, guildId, triggerId, patch, expectedConfigRevision = null) {
    requireIds(triggerId);
    validatePatch(patch);
    requireOptionalRevision(expectedConfigRevision);
    const fields = { ...patch };
    return transaction(client, guildId, (d, state) => {
        if (expectedConfigRevision && state.configRevision !== expectedConfigRevision) throw fail('JTC_STALE', 'Configuration changed');
        if (!d.triggerChannels.includes(triggerId)) throw fail('JTC_MISSING', 'Trigger missing');
        if (triggerHasPending(d, triggerId)) throw fail('JTC_PENDING', 'A channel create is pending');
        d.channelOptions[triggerId] = { ...(d.channelOptions[triggerId] || {}), ...fields };
        return { write: true, value: resolveJoinToCreateOptions(d, triggerId) };
    });
}

/**
 * Remove a trigger. Temporary-channel records are kept on purpose: their
 * Discord channels may still exist and are cleaned up when they empty.
 */
export async function removeJoinToCreateTrigger(client, guildId, triggerId, expectedConfigRevision = null) {
    requireIds(triggerId);
    requireOptionalRevision(expectedConfigRevision);
    return transaction(client, guildId, (d, state) => {
        if (expectedConfigRevision && state.configRevision !== expectedConfigRevision) throw fail('JTC_STALE', 'Configuration changed');
        if (!d.triggerChannels.includes(triggerId)) throw fail('JTC_MISSING', 'Trigger missing');
        if (triggerHasPending(d, triggerId)) throw fail('JTC_PENDING', 'A channel create is pending');
        d.triggerChannels = d.triggerChannels.filter((channelId) => channelId !== triggerId);
        d.enabled = d.triggerChannels.length > 0;
        delete d.channelOptions[triggerId];
        return { write: true, value: true };
    });
}

/** Register an existing Discord channel directly (no reservation). */
export async function registerJoinToCreateChannel(client, guildId, channelId, ownerId, triggerId, createdAt) {
    requireIds(channelId, ownerId, triggerId);
    if (!isValidDate(createdAt)) throw invalid();
    return transaction(client, guildId, (d) => {
        if (!triggerIsActive(d, triggerId)) throw fail('JTC_STALE', 'Trigger no longer active');
        if (Object.hasOwn(d.temporaryChannels, channelId) || ownerHasChannel(d, ownerId) || ownerHasPending(d, ownerId)) {
            throw fail('JTC_CONFLICT', 'Channel or owner already registered');
        }
        d.temporaryChannels[channelId] = { ownerId, triggerChannelId: triggerId, createdAt };
        return { write: true, value: true };
    });
}

/** Change the owner, only if the stored owner is still `expectedOwner`. */
export async function transferJoinToCreateOwner(client, guildId, channelId, expectedOwner, newOwner) {
    requireIds(channelId, expectedOwner, newOwner);
    return transaction(client, guildId, (d) => {
        const info = d.temporaryChannels[channelId];
        if (!info || info.ownerId !== expectedOwner) throw fail('JTC_STALE', 'Channel owner changed');
        if (ownerHasChannel(d, newOwner, channelId) || ownerHasPending(d, newOwner)) throw fail('JTC_CONFLICT', 'Owner already registered');
        info.ownerId = newOwner;
        return { write: true, value: true };
    });
}

/** Remove a channel record, only if owner and trigger still match. */
export async function unregisterJoinToCreateChannel(client, guildId, channelId, expectedOwner, expectedTrigger) {
    requireIds(channelId, expectedOwner, expectedTrigger);
    return transaction(client, guildId, (d) => {
        const info = d.temporaryChannels[channelId];
        if (!info || info.ownerId !== expectedOwner || info.triggerChannelId !== expectedTrigger) throw fail('JTC_STALE', 'Channel record changed');
        delete d.temporaryChannels[channelId];
        return { write: true, value: true };
    });
}

/**
 * Remove a channel record whoever owns it. Only for a channel that is known
 * to be gone from Discord (channelDelete event or "Unknown Channel").
 * Returns false when there was no record.
 */
export async function unregisterJoinToCreateChannelIfPresent(client, guildId, channelId) {
    requireIds(channelId);
    return transaction(client, guildId, (d) => {
        if (!Object.hasOwn(d.temporaryChannels, channelId)) return { write: false, value: false };
        delete d.temporaryChannels[channelId];
        return { write: true, value: true };
    });
}

/**
 * Step 1 of a create: durably reserve the owner BEFORE asking Discord for a
 * channel. Returns the token and the settings to create the channel with.
 */
export async function reserveJoinToCreate(client, guildId, ownerId, triggerId) {
    requireIds(ownerId, triggerId);
    const token = randomUUID();
    return transaction(client, guildId, (d) => {
        if (!triggerIsActive(d, triggerId)) throw fail('JTC_STALE', 'Trigger no longer active');
        if (Object.hasOwn(d.pendingCreates, token) || ownerHasPending(d, ownerId) || ownerHasChannel(d, ownerId)) {
            throw fail('JTC_CONFLICT', 'Owner already has a channel or pending create');
        }
        d.pendingCreates[token] = { ownerId, triggerId, createdAt: Date.now(), stage: 'reserved' };
        return { write: true, value: { token, options: resolveJoinToCreateOptions(d, triggerId) } };
    });
}

/**
 * Optional intermediate step: note the channel ID Discord returned while the
 * reservation stays open. The bot runtime completes directly; this stage is
 * kept for tools that want the ID stored before registration.
 */
export async function recordJoinToCreateCreated(client, guildId, ownerId, triggerId, token, channelId) {
    requireIds(ownerId, triggerId, channelId);
    requireToken(token);
    return transaction(client, guildId, (d) => {
        const pending = d.pendingCreates[token];
        if (!pending || pending.stage !== 'reserved' || pending.ownerId !== ownerId || pending.triggerId !== triggerId || !triggerIsActive(d, triggerId)) {
            throw fail('JTC_STALE', 'Reservation or trigger changed');
        }
        if (Object.hasOwn(d.temporaryChannels, channelId)) throw fail('JTC_CONFLICT', 'Channel already registered');
        d.pendingCreates[token] = { ...pending, stage: 'created', channelId };
        return { write: true, value: true };
    }, { allowPending: true });
}

/**
 * Step 2 of a create: register the channel and release the reservation in one
 * transaction. Accepts a reservation in stage `reserved`, or `created` when the
 * recorded ID matches.
 */
export async function completeJoinToCreate(client, guildId, ownerId, triggerId, token, channelId) {
    requireIds(ownerId, triggerId, channelId);
    requireToken(token);
    return transaction(client, guildId, (d) => {
        const pending = d.pendingCreates[token];
        if (
            !pending
            || pending.ownerId !== ownerId
            || pending.triggerId !== triggerId
            || (pending.stage === 'created' && pending.channelId !== channelId)
            || !triggerIsActive(d, triggerId)
        ) throw fail('JTC_STALE', 'Reservation or trigger changed');
        if (Object.hasOwn(d.temporaryChannels, channelId) || ownerHasChannel(d, ownerId)) throw fail('JTC_CONFLICT', 'Channel or owner already registered');
        d.temporaryChannels[channelId] = { ownerId, triggerChannelId: triggerId, createdAt: Date.now() };
        delete d.pendingCreates[token];
        return { write: true, value: true };
    }, { allowPending: true });
}

/**
 * Release a reservation without registering a channel. Call only when it is
 * established that no channel needs tracking (Discord rejected the request,
 * or recovery looked and found none). Returns false if the token is gone.
 */
export async function cancelJoinToCreatePending(client, guildId, token) {
    requireToken(token);
    return transaction(client, guildId, (d) => {
        if (!Object.hasOwn(d.pendingCreates, token)) return { write: false, value: false };
        delete d.pendingCreates[token];
        return { write: true, value: true };
    }, { allowPending: true });
}
