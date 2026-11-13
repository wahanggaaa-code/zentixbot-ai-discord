// lists.js — what members can do with to-do lists. Every function either returns
// `{ ok: true, … }`, returns `{ ok: false, reason }` for a request that is refused,
// or throws a TODO_* error when the storage could not be used. Nothing is half done.

import { randomBytes } from 'node:crypto';
import {
    decodeIndex, decodePersonal, decodeShared, emptyPersonal, fail, indexKey, isListId, isSnowflake,
    personalKey, readRow, readRows, sharedKey, transaction,
} from './store.js';

export const MAX_TASK_LENGTH = 200;
export const MAX_TASKS = 50;
export const MAX_NAME_LENGTH = 50;
export const MAX_MEMBERS = 25;
/** Shared lists one member can belong to, own lists included. */
export const MAX_LISTS_PER_MEMBER = 25;

/** Why a request was refused. */
export const Refusal = Object.freeze({
    INVALID_TEXT: 'invalid_text',
    INVALID_LIST_ID: 'invalid_list_id',
    NOT_FOUND: 'not_found',
    NO_ACCESS: 'no_access',
    NOT_OWNER: 'not_owner',
    TASK_NOT_FOUND: 'task_not_found',
    ALREADY_COMPLETED: 'already_completed',
    LIST_FULL: 'list_full',
    MEMBERS_FULL: 'members_full',
    TOO_MANY_LISTS: 'too_many_lists',
    ALREADY_MEMBER: 'already_member',
    NOT_MEMBER: 'not_member',
    IS_OWNER: 'is_owner',
});

const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const user = (userId) => {
    if (!isSnowflake(userId)) throw fail('Invalid user id', 'TODO_INVALID');
    return userId;
};

// Control characters, direction overrides and invisible separators; a task and a name are one visible line.
// U+200C and U+200D stay: they join letters in several scripts and build emoji.
const UNPRINTABLE = /[\u0000-\u001F\u007F\u200B\u200E\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g;

/** One line of member text, or `null` when nothing visible is left or it is too long. */
export function cleanLine(value, limit) {
    if (typeof value !== 'string') return null;
    const text = value.replace(UNPRINTABLE, ' ').replace(/ {2,}/g, ' ').trim();
    if (text.replace(/[\s\u200C\u200D]/g, '') === '') return null;
    return text.length <= limit ? text : null;
}

const taskNumber = (value) => (Number.isSafeInteger(value) && value >= 1 ? value : null);

// ---- personal list ------------------------------------------------------------

export async function readPersonal(client, userId) {
    const raw = await readRow(client, personalKey(user(userId)));
    return raw === undefined ? emptyPersonal() : decodePersonal(raw);
}

/** Change the personal list of a member. `change(list)` returns a refusal, or `{ ok: true, … }` after editing `list`. */
async function changePersonal(client, userId, change) {
    user(userId);
    return transaction(client, async (tx) => {
        await tx.lock(`personal:${userId}`);
        const raw = await tx.get(personalKey(userId));
        const list = raw === undefined ? emptyPersonal() : decodePersonal(raw);
        const out = change(list);
        if (out.ok) await tx.put(personalKey(userId), list);
        return out;
    });
}

function addTo(list, text, extra = {}) {
    if (list.tasks.length >= MAX_TASKS) return no(Refusal.LIST_FULL);
    const task = { id: list.nextId, text, completed: false, createdAt: new Date().toISOString(), ...extra };
    list.nextId += 1;
    list.tasks.push(task);
    return { ok: true, task };
}

function completeIn(list, number, extra = {}) {
    const task = list.tasks.find((entry) => entry.id === number);
    if (!task) return no(Refusal.TASK_NOT_FOUND);
    if (task.completed) return no(Refusal.ALREADY_COMPLETED, { task });
    Object.assign(task, { completed: true }, extra);
    return { ok: true, task };
}

function removeFrom(list, number) {
    const at = list.tasks.findIndex((entry) => entry.id === number);
    if (at === -1) return no(Refusal.TASK_NOT_FOUND);
    const [task] = list.tasks.splice(at, 1);
    return { ok: true, task };
}

export async function addPersonalTask(client, userId, rawText) {
    const text = cleanLine(rawText, MAX_TASK_LENGTH);
    if (!text) return no(Refusal.INVALID_TEXT);
    return changePersonal(client, userId, (list) => addTo(list, text));
}

export async function completePersonalTask(client, userId, number) {
    if (!taskNumber(number)) return no(Refusal.TASK_NOT_FOUND);
    return changePersonal(client, userId, (list) => completeIn(list, number));
}

export async function removePersonalTask(client, userId, number) {
    if (!taskNumber(number)) return no(Refusal.TASK_NOT_FOUND);
    return changePersonal(client, userId, (list) => removeFrom(list, number));
}

// ---- shared lists ---------------------------------------------------------------

/** The shared list `listId` for a member of it; a refusal otherwise. */
export async function readShared(client, listId, userId) {
    user(userId);
    if (!isListId(listId)) return no(Refusal.INVALID_LIST_ID);
    const raw = await readRow(client, sharedKey(listId));
    if (raw === undefined) return no(Refusal.NOT_FOUND);
    const list = decodeShared(raw, listId);
    if (!list.members.includes(userId)) return no(Refusal.NO_ACCESS);
    return { ok: true, list };
}

/** The lists among `ids` that exist and have `userId` as a member, in the order of `ids`. */
function membershipsOf(userId, ids, rows) {
    const lists = [];
    for (const id of ids) {
        const raw = rows.get(sharedKey(id));
        if (raw === undefined) continue;
        let list;
        try {
            list = decodeShared(raw, id);
        } catch {
            continue;
        }
        if (list.members.includes(userId)) lists.push(list);
    }
    return lists;
}

/**
 * The shared lists of a member. The stored index is only a hint: a list counts
 * when it exists and names the member, whatever the index says about it.
 */
export async function listShared(client, userId) {
    user(userId);
    const raw = await readRow(client, indexKey(userId));
    const ids = raw === undefined ? [] : decodeIndex(raw);
    return membershipsOf(userId, ids, await readRows(client, ids.map(sharedKey)));
}

/** Inside a transaction that holds the index lock of `userId`: the lists the member really belongs to. */
async function lockedMemberships(tx, userId) {
    await tx.lock(`index:${userId}`);
    const raw = await tx.get(indexKey(userId));
    const ids = raw === undefined ? [] : decodeIndex(raw);
    return membershipsOf(userId, ids, await tx.getMany(ids.map(sharedKey))).map((list) => list.id);
}

export async function createShared(client, userId, rawName) {
    user(userId);
    const name = cleanLine(rawName, MAX_NAME_LENGTH);
    if (!name) return no(Refusal.INVALID_TEXT);
    return transaction(client, async (tx) => {
        const current = await lockedMemberships(tx, userId);
        if (current.length >= MAX_LISTS_PER_MEMBER) return no(Refusal.TOO_MANY_LISTS);
        const list = { id: randomBytes(16).toString('hex'), name, creatorId: userId, members: [userId], tasks: [], nextId: 1, createdAt: new Date().toISOString() };
        await tx.put(sharedKey(list.id), list);
        await tx.put(indexKey(userId), [...current, list.id]);
        return { ok: true, list };
    });
}

/**
 * Change a shared list as `actorId`. `change(list, tx)` returns a refusal, `{ ok: true, … }` after
 * editing `list`, or `{ ok: true, deleted: true }` to delete it.
 */
async function changeShared(client, listId, actorId, change, { ownerOnly = false } = {}) {
    user(actorId);
    if (!isListId(listId)) return no(Refusal.INVALID_LIST_ID);
    return transaction(client, async (tx) => {
        await tx.lock(`shared:${listId}`);
        const raw = await tx.get(sharedKey(listId));
        if (raw === undefined) return no(Refusal.NOT_FOUND);
        const list = decodeShared(raw, listId);
        if (!list.members.includes(actorId)) return no(Refusal.NO_ACCESS);
        if (ownerOnly && list.creatorId !== actorId) return no(Refusal.NOT_OWNER, { list });
        const out = await change(list, tx);
        if (!out.ok) return { list, ...out };
        if (out.deleted) await tx.del(sharedKey(listId));
        else await tx.put(sharedKey(listId), list);
        return { list, ...out };
    });
}

export async function addSharedTask(client, listId, userId, rawText) {
    const text = cleanLine(rawText, MAX_TASK_LENGTH);
    if (!text) return no(Refusal.INVALID_TEXT);
    return changeShared(client, listId, userId, (list) => addTo(list, text, { createdBy: userId }));
}

export async function completeSharedTask(client, listId, userId, number) {
    if (!taskNumber(number)) return no(Refusal.TASK_NOT_FOUND);
    return changeShared(client, listId, userId, (list) => completeIn(list, number, { completedBy: userId }));
}

export async function removeSharedTask(client, listId, userId, number) {
    if (!taskNumber(number)) return no(Refusal.TASK_NOT_FOUND);
    return changeShared(client, listId, userId, (list) => removeFrom(list, number));
}

/** The owner gives another member access. */
export async function addSharedMember(client, listId, ownerId, targetId) {
    user(targetId);
    return changeShared(client, listId, ownerId, async (list, tx) => {
        if (list.members.includes(targetId)) return no(Refusal.ALREADY_MEMBER);
        if (list.members.length >= MAX_MEMBERS) return no(Refusal.MEMBERS_FULL);
        const current = await lockedMemberships(tx, targetId);
        if (current.length >= MAX_LISTS_PER_MEMBER) return no(Refusal.TOO_MANY_LISTS);
        list.members.push(targetId);
        await tx.put(indexKey(targetId), [...current.filter((id) => id !== list.id), list.id]);
        return { ok: true };
    }, { ownerOnly: true });
}

async function dropMember(list, tx, targetId) {
    list.members = list.members.filter((id) => id !== targetId);
    const current = await lockedMemberships(tx, targetId);
    await tx.put(indexKey(targetId), current.filter((id) => id !== list.id));
    return { ok: true };
}

/** The owner takes access away from a member. */
export async function removeSharedMember(client, listId, ownerId, targetId) {
    user(targetId);
    return changeShared(client, listId, ownerId, (list, tx) => {
        if (targetId === list.creatorId) return no(Refusal.IS_OWNER);
        if (!list.members.includes(targetId)) return no(Refusal.NOT_MEMBER);
        return dropMember(list, tx, targetId);
    }, { ownerOnly: true });
}

/** A member gives up their own access. The owner cannot; a list without an owner could never be deleted. */
export async function leaveShared(client, listId, userId) {
    return changeShared(client, listId, userId, (list, tx) => {
        if (userId === list.creatorId) return no(Refusal.IS_OWNER);
        return dropMember(list, tx, userId);
    });
}

/**
 * The owner deletes the list for everyone. The indexes of the other members keep the id until
 * they are next written; they are only hints and an id without a list is ignored.
 */
export async function deleteShared(client, listId, ownerId) {
    return changeShared(client, listId, ownerId, async () => ({ ok: true, deleted: true }), { ownerOnly: true });
}
