// store.js — role applications, read and written directly on PostgreSQL.
//
// Rows in `temp_data`, all under `guild:{guildId}:applications:`
//   settings                  switch, manager roles, retention, default questions
//   roles                     the application forms: [{ roleId, name, enabled }]
//   role:{roleId}:settings    questions and log channel of one form
//   {applicationId}           one submitted application
//   users:{userId}            written by older versions; no longer read or written
//
// The generic key-value layer answers a failed read with "no data" and a failed
// write with `false`. Here that meant: a failed read made the feature look switched
// off or the list of forms look empty, a new form was saved over the others, and an
// approval that was never stored was reported as done. Every failure is thrown here,
// and every change is one transaction under one lock per server, so two reviewers
// deciding the same application are served one after the other.

import { randomBytes } from 'node:crypto';
import { pgConfig } from '../../config/database/postgres.js';
import { sqliteFor, readRows as readSQLiteRows, readPrefixes, rowTransaction } from '../storage/sqliteRows.js';

const table = pgConfig.tables.temp_data;
const SNOWFLAKE = /^\d{17,20}$/;
// `{milliseconds}-{random}`: what this bot has always issued. Nothing else is looked up,
// so "settings" or "roles" can never be read as an application.
const APPLICATION_ID = /^\d{10,16}-[a-z0-9]{1,16}$/;
const DAY = 24 * 60 * 60 * 1000;

export const LIMITS = Object.freeze({
    forms: 25,
    questions: 5,
    question: 100,
    formName: 50,
    answer: 1000,
    reason: 500,
    managerRoles: 10,
    retentionMin: 1,
    retentionMax: 3650,
});
export const DEFAULT_RETENTION_DAYS = 30;

export const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const isSnowflake = (value) => typeof value === 'string' && SNOWFLAKE.test(value);
export const isApplicationId = (value) => typeof value === 'string' && APPLICATION_ID.test(value);

const guildOf = (guildId) => {
    if (!isSnowflake(guildId)) throw fail('Invalid guild id', 'APP_INVALID');
    return guildId;
};
export const prefixOf = (guildId) => `guild:${guildOf(guildId)}:applications:`;
export const settingsKey = (guildId) => `${prefixOf(guildId)}settings`;
export const formsKey = (guildId) => `${prefixOf(guildId)}roles`;
export const formSettingsKey = (guildId, roleId) => `${prefixOf(guildId)}role:${roleId}:settings`;
export const applicationKey = (guildId, id) => `${prefixOf(guildId)}${id}`;

/** Older storage sometimes kept JSON as text. Text that is not JSON stays text, so it is seen as unreadable rather than as "nothing stored". */
const parse = (raw) => {
    if (typeof raw !== 'string') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
};
/** Older storage wrapped values as `{ ok, value }`. */
const unwrap = (raw) => {
    const value = parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value && 'value' in value ? parse(value.value) : value;
};
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const days = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), LIMITS.retentionMin), LIMITS.retentionMax) : DEFAULT_RETENTION_DAYS;
};

/** Stored questions as questions: trimmed, non-empty, at most five of at most 100 characters. */
export function cleanQuestions(raw) {
    const out = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
        const text = typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim().slice(0, LIMITS.question) : '';
        if (text && out.length < LIMITS.questions) out.push(text);
    }
    return out;
}

/** The settings row. A missing row is "switched off, nothing configured". */
export function decodeSettings(raw) {
    const value = unwrap(raw);
    if (value !== undefined && value !== null && !isRecord(value)) throw fail('Stored application settings are not an object', 'APP_INVALID');
    const stored = value ?? {};
    return {
        enabled: stored.enabled === true,
        managerRoles: [...new Set((Array.isArray(stored.managerRoles) ? stored.managerRoles : []).filter(isSnowflake))].slice(0, LIMITS.managerRoles),
        logChannelId: isSnowflake(stored.logChannelId) ? stored.logChannelId : null,
        questions: cleanQuestions(stored.questions),
        pendingDays: days(stored.pendingApplicationRetentionDays),
        reviewedDays: days(stored.reviewedApplicationRetentionDays),
        revision: Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0,
        stored,
    };
}

const encodeSettings = (settings) => {
    const { stored, pendingDays, reviewedDays, ...rest } = settings;
    return { ...stored, ...rest, pendingApplicationRetentionDays: pendingDays, reviewedApplicationRetentionDays: reviewedDays };
};

/** The forms row joined with the per-form settings rows. Entries without a usable role id or a second entry for one role are left out. */
export function decodeForms(rawForms, formSettings = new Map()) {
    const value = unwrap(rawForms);
    if (value !== undefined && value !== null && !Array.isArray(value)) throw fail('Stored application forms are not a list', 'APP_INVALID');
    const forms = [];
    const seen = new Set();
    for (const entry of value ?? []) {
        if (!isRecord(entry) || !isSnowflake(entry.roleId) || seen.has(entry.roleId)) continue;
        seen.add(entry.roleId);
        const own = unwrap(formSettings.get(entry.roleId));
        const extra = isRecord(own) ? own : {};
        const name = typeof entry.name === 'string' ? entry.name.replace(/\s+/g, ' ').trim().slice(0, LIMITS.formName) : '';
        forms.push({
            roleId: entry.roleId,
            name: name || 'Application',
            enabled: entry.enabled !== false,
            questions: cleanQuestions(extra.questions),
            logChannelId: isSnowflake(extra.logChannelId) ? extra.logChannelId : null,
        });
    }
    return forms;
}

const STATUSES = ['pending', 'approved', 'denied'];
const millis = (value) => {
    const number = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(number) && number > 0 ? number : null;
};

/** A stored application, or null when the row is not one (wrong shape, wrong server, unknown status). */
export function decodeApplication(raw, guildId, id) {
    const value = unwrap(raw);
    if (!isRecord(value) || !isSnowflake(value.userId) || !isSnowflake(value.roleId)) return null;
    if (value.guildId !== undefined && value.guildId !== guildId) return null;
    const status = typeof value.status === 'string' ? value.status.toLowerCase() : 'pending';
    if (!STATUSES.includes(status)) return null;
    const createdAt = millis(value.createdAt) ?? millis(Number(String(id).split('-')[0]));
    if (createdAt === null) return null;
    const answers = (Array.isArray(value.answers) ? value.answers : [])
        .filter((entry) => isRecord(entry) && typeof entry.question === 'string' && typeof entry.answer === 'string')
        .map((entry) => ({ question: entry.question, answer: entry.answer }));
    return {
        ...value,
        id,
        guildId,
        status,
        createdAt,
        answers,
        roleName: typeof value.roleName === 'string' && value.roleName.trim() ? value.roleName : 'Application',
        reviewedAt: status === 'pending' ? null : millis(value.reviewedAt) ?? millis(value.updatedAt) ?? createdAt,
        reviewer: isSnowflake(value.reviewer) ? value.reviewer : null,
        reviewMessage: typeof value.reviewMessage === 'string' ? value.reviewMessage : '',
        // Answers written by this store are kept as typed; older ones were stored with markdown already escaped.
        rawText: value.rawText === true,
    };
}

/** Has this application outlived the retention the server chose? */
export function isExpired(application, settings, now = Date.now()) {
    if (application.status === 'pending') return now - application.createdAt > settings.pendingDays * DAY;
    return now - application.reviewedAt > settings.reviewedDays * DAY;
}

/** The PostgreSQL pool. Throws APP_UNAVAILABLE when PostgreSQL cannot be used right now. */
export function applicationsPool(client) {
    const db = client?.db;
    const status = db?.getStatus?.();
    if (status?.connectionType !== 'postgresql' || status.isDegraded || !db.isAvailable?.()
        || !db.db?.isAvailable?.() || typeof db.db.pool?.connect !== 'function') {
        throw fail('PostgreSQL unavailable for applications', 'APP_UNAVAILABLE');
    }
    return db.db.pool;
}

const wrap = (error) => (error?.code?.startsWith?.('APP_') ? error : fail('Application storage failed', 'APP_UNAVAILABLE', { cause: error }));

async function query(client, text, params) {
    const pool = applicationsPool(client);
    try {
        return await pool.query(text, params);
    } catch (error) {
        throw wrap(error);
    }
}

const FORM_SETTINGS_KEY = /:applications:role:(\d{17,20}):settings$/;

function splitRows(guildId, rows) {
    const prefix = prefixOf(guildId);
    const formSettings = new Map();
    const applicationRows = [];
    let settingsRaw;
    let formsRaw;
    for (const row of rows) {
        const name = row.key.slice(prefix.length);
        if (name === 'settings') settingsRaw = row.value;
        else if (name === 'roles') formsRaw = row.value;
        else if (FORM_SETTINGS_KEY.test(row.key)) formSettings.set(row.key.match(FORM_SETTINGS_KEY)[1], row.value);
        else if (isApplicationId(name)) applicationRows.push({ id: name, value: row.value });
    }
    return { settingsRaw, formsRaw, formSettings, applicationRows };
}

function decodeAll(guildId, rows, now) {
    const { settingsRaw, formsRaw, formSettings, applicationRows } = splitRows(guildId, rows);
    const settings = decodeSettings(settingsRaw);
    const forms = decodeForms(formsRaw, formSettings);
    const applications = [];
    const expired = [];
    for (const row of applicationRows) {
        const application = decodeApplication(row.value, guildId, row.id);
        if (!application) continue;
        if (isExpired(application, settings, now)) expired.push(application.id);
        else applications.push(application);
    }
    applications.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    return { settings, forms, applications, expired };
}

const unavailable = () => fail('Database unavailable for applications', 'APP_UNAVAILABLE');

/**
 * The stored rows with one of `keys` or under one of `prefixes`, as `{ key, value }`.
 * `text` and `params` are the same question for PostgreSQL.
 */
async function rowsOf(client, { keys = [], prefixes = [] }, text, params) {
    const sqlite = sqliteFor(client, unavailable);
    if (!sqlite) return (await query(client, text, params)).rows;
    try {
        return [
            ...[...readSQLiteRows(sqlite, keys)].map(([key, value]) => ({ key, value })),
            ...readPrefixes(sqlite, ...prefixes),
        ];
    } catch (error) {
        throw wrap(error);
    }
}

/** Settings and forms of a server: one query. */
export async function readConfig(client, guildId) {
    const rows = await rowsOf(
        client,
        { keys: [settingsKey(guildId), formsKey(guildId)], prefixes: [`${prefixOf(guildId)}role:`] },
        `SELECT key, value FROM ${table} WHERE key = ANY($1::text[]) OR key LIKE $2`,
        [[settingsKey(guildId), formsKey(guildId)], `${prefixOf(guildId)}role:%`],
    );
    const { settings, forms } = decodeAll(guildId, rows, Date.now());
    return { settings, forms };
}

/**
 * Settings, forms and every application the server still keeps, newest first: one query.
 * Applications past their retention are left out whether or not they were deleted yet.
 */
export async function readAll(client, guildId, now = Date.now()) {
    const rows = await rowsOf(client, { prefixes: [prefixOf(guildId)] }, `SELECT key, value FROM ${table} WHERE key LIKE $1`, [`${prefixOf(guildId)}%`]);
    const { settings, forms, applications } = decodeAll(guildId, rows, now);
    return { settings, forms, applications };
}

/** One application, or null when there is none with this id (or it is past its retention). */
export async function readApplication(client, guildId, id, now = Date.now()) {
    if (!isApplicationId(id)) return null;
    const rows = await rowsOf(
        client,
        { keys: [settingsKey(guildId), applicationKey(guildId, id)] },
        `SELECT key, value FROM ${table} WHERE key = ANY($1::text[])`,
        [[settingsKey(guildId), applicationKey(guildId, id)]],
    );
    const { applications } = decodeAll(guildId, rows, now);
    return applications[0] ?? null;
}

/**
 * Run `work(tx)` in one transaction that holds the server's applications lock, and return what it returns.
 * Anything `work` throws rolls everything back and is passed on.
 */
async function transaction(client, guildId, work) {
    const prefix = prefixOf(guildId);
    const sqlite = sqliteFor(client, unavailable);
    if (sqlite) {
        try {
            return await rowTransaction(sqlite, `applications:${guildId}`, (rows) => work({
                all: (now) => decodeAll(guildId, rows.rows(prefix), now),
                put: rows.put,
                del: (keys) => rows.del(keys),
            }));
        } catch (error) {
            throw wrap(error);
        }
    }
    const pool = applicationsPool(client);
    let conn;
    try {
        conn = await pool.connect();
    } catch (error) {
        throw wrap(error);
    }
    let committing = false;
    const tx = {
        all: async (now) => decodeAll(guildId, (await conn.query(`SELECT key, value FROM ${table} WHERE key LIKE $1`, [`${prefix}%`])).rows, now),
        put: (key, value) => conn.query(
            `INSERT INTO ${table} (key, value, expires_at) VALUES ($1, $2::jsonb, NULL)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = NULL`,
            [key, JSON.stringify(value)],
        ),
        del: (keys) => (keys.length === 0 ? null : conn.query(`DELETE FROM ${table} WHERE key = ANY($1::text[])`, [keys])),
    };
    try {
        await conn.query('BEGIN');
        await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`zentix:applications:${guildId}`]);
        const result = await work(tx);
        committing = true;
        await conn.query('COMMIT');
        return result;
    } catch (error) {
        await conn.query('ROLLBACK').catch(() => {});
        // A COMMIT whose answer was lost may or may not have been applied.
        if (committing) throw fail('Application commit outcome unknown', 'APP_UNCERTAIN', { cause: error });
        throw wrap(error);
    } finally {
        conn.release();
    }
}

const putSettings = (tx, guildId, settings) => tx.put(settingsKey(guildId), encodeSettings({ ...settings, revision: settings.revision + 1 }));
const putForms = (tx, guildId, forms) => tx.put(formsKey(guildId), forms.map(({ roleId, name, enabled }) => ({ roleId, name, enabled })));

/**
 * Change settings and forms in one step. `change({ settings, forms })` edits the two in place
 * (and may throw to refuse); every changed form's own row is rewritten, a removed form's row and
 * applications are deleted. `revision`, when given, must be the revision the caller last saw.
 * Returns `{ settings, forms, removedApplications, result }` as stored.
 */
export async function changeConfig(client, guildId, change, { revision = null } = {}) {
    return transaction(client, guildId, async (tx) => {
        const state = await tx.all(Date.now());
        if (revision !== null && revision !== state.settings.revision) throw fail('Application settings changed meanwhile', 'APP_STALE', { revision: state.settings.revision });
        const before = new Map(state.forms.map((form) => [form.roleId, form]));
        const draft = { settings: { ...state.settings, managerRoles: [...state.settings.managerRoles] }, forms: state.forms.map((form) => ({ ...form })) };
        const result = await change(draft);
        if (draft.forms.length > LIMITS.forms) throw fail('Too many application forms', 'APP_FORM_LIMIT');

        const kept = new Set(draft.forms.map((form) => form.roleId));
        const removedRoles = [...before.keys()].filter((roleId) => !kept.has(roleId));
        const removedApplications = state.applications.filter((application) => removedRoles.includes(application.roleId)).map((application) => application.id);
        await tx.del([
            ...removedRoles.map((roleId) => formSettingsKey(guildId, roleId)),
            ...removedApplications.map((id) => applicationKey(guildId, id)),
        ]);
        for (const form of draft.forms) {
            await tx.put(formSettingsKey(guildId, form.roleId), { questions: form.questions, logChannelId: form.logChannelId });
        }
        await putForms(tx, guildId, draft.forms);
        await putSettings(tx, guildId, draft.settings);
        return {
            settings: { ...draft.settings, revision: draft.settings.revision + 1 },
            forms: draft.forms,
            removedApplications: removedApplications.length,
            result,
        };
    });
}

/**
 * Store a new application. Everything that decides whether the member may apply is checked
 * here, under the lock, against what is stored at that moment.
 *
 * Throws APP_DISABLED, APP_FORM_MISSING, APP_FORM_DISABLED, APP_PENDING (with `application`)
 * or APP_COOLDOWN (with `retryAt`).
 */
export async function createApplication(client, { guildId, userId, username = null, roleId, answers, cooldownMs = 0, now = Date.now() }) {
    if (!isSnowflake(userId) || !isSnowflake(roleId)) throw fail('Invalid application', 'APP_INVALID');
    return transaction(client, guildId, async (tx) => {
        const state = await tx.all(now);
        // Applications past their retention go now, while the lock is held anyway.
        await tx.del(state.expired.map((id) => applicationKey(guildId, id)));
        if (!state.settings.enabled) throw fail('Applications are switched off', 'APP_DISABLED');
        const form = state.forms.find((entry) => entry.roleId === roleId);
        if (!form) throw fail('No such application form', 'APP_FORM_MISSING');
        if (!form.enabled) throw fail('Application form is switched off', 'APP_FORM_DISABLED');

        const own = state.applications.filter((application) => application.userId === userId);
        const pending = own.find((application) => application.status === 'pending');
        if (pending) throw fail('Member already has a pending application', 'APP_PENDING', { application: pending });
        const latest = own[0];
        if (latest && cooldownMs > 0 && now - latest.createdAt < cooldownMs) {
            throw fail('Member applied too recently', 'APP_COOLDOWN', { retryAt: latest.createdAt + cooldownMs });
        }

        const id = `${now}-${randomBytes(5).toString('hex')}`;
        const application = {
            id,
            guildId,
            userId,
            username,
            roleId,
            roleName: form.name,
            answers,
            rawText: true,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            reviewer: null,
            reviewedAt: null,
            reviewMessage: '',
        };
        await tx.put(applicationKey(guildId, id), application);
        return decodeApplication(application, guildId, id);
    });
}

/**
 * Decide a pending application. Only one decision can win: the second caller gets APP_REVIEWED
 * with the application as decided. An approval is stored with `roleGranted: false` until the
 * role was really given.
 */
export async function decideApplication(client, { guildId, id, action, reason = '', reviewerId, now = Date.now() }) {
    if (action !== 'approve' && action !== 'deny') throw fail('Invalid review action', 'APP_INVALID');
    if (!isApplicationId(id) || !isSnowflake(reviewerId)) throw fail('Invalid review', 'APP_INVALID');
    return transaction(client, guildId, async (tx) => {
        const state = await tx.all(now);
        const application = state.applications.find((entry) => entry.id === id);
        if (!application) throw fail('No such application', 'APP_NOT_FOUND');
        if (application.status !== 'pending') throw fail('Application already reviewed', 'APP_REVIEWED', { application });
        const next = {
            ...application,
            status: action === 'approve' ? 'approved' : 'denied',
            reviewer: reviewerId,
            reviewMessage: reason,
            reviewedAt: new Date(now).toISOString(),
            updatedAt: now,
        };
        if (action === 'approve') next.roleGranted = false;
        await tx.put(applicationKey(guildId, id), next);
        return decodeApplication(next, guildId, id);
    });
}

const NOTE_FIELDS = ['logMessageId', 'logChannelId', 'roleGranted'];

/** Record a side fact about an application (its log message, whether the role was given). No-op when the application is gone. */
export async function noteApplication(client, guildId, id, note) {
    if (!isApplicationId(id)) return null;
    return transaction(client, guildId, async (tx) => {
        const state = await tx.all(Date.now());
        const application = state.applications.find((entry) => entry.id === id);
        if (!application) return null;
        const next = { ...application, reviewedAt: application.reviewedAt ? new Date(application.reviewedAt).toISOString() : null };
        for (const field of NOTE_FIELDS) if (field in note) next[field] = note[field];
        await tx.put(applicationKey(guildId, id), next);
        return decodeApplication(next, guildId, id);
    });
}

/** Delete the applications that are past their retention. Returns how many went. */
export async function purgeExpired(client, guildId, now = Date.now()) {
    return transaction(client, guildId, async (tx) => {
        const state = await tx.all(now);
        await tx.del(state.expired.map((id) => applicationKey(guildId, id)));
        return state.expired.length;
    });
}

/** Delete every application of one member (the member left the server). Returns how many went. */
export async function deleteApplicationsOf(client, guildId, userId) {
    if (!isSnowflake(userId)) return 0;
    return transaction(client, guildId, async (tx) => {
        const state = await tx.all(Date.now());
        const own = state.applications.filter((application) => application.userId === userId).map((application) => application.id);
        // The index row older versions kept for this member goes with them.
        await tx.del([...own.map((id) => applicationKey(guildId, id)), `${prefixOf(guildId)}users:${userId}`]);
        return own.length;
    });
}
