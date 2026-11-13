// view.js — how to-do lists look in Discord, and the sentences for refused requests.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createEmbed } from '../../utils/embeds.js';
import { plainText } from '../searchLookup.js';
import { MAX_LISTS_PER_MEMBER, MAX_MEMBERS, MAX_NAME_LENGTH, MAX_TASK_LENGTH, MAX_TASKS, Refusal } from './lists.js';

export const PAGE_SIZE = 10;
// Escaping can double a text. Ten lines of this length, plus the heading, stay below the 4096 of an embed.
const SHOWN_TASK_LENGTH = 250;

/** Member text as ordinary text: it cannot format itself, hide a link or mention anyone. */
export const shown = (text, limit = SHOWN_TASK_LENGTH) => plainText(String(text ?? ''), limit) || '(empty)';

export const pageCount = (list) => Math.max(1, Math.ceil(list.tasks.length / PAGE_SIZE));
const clampPage = (list, page) => Math.min(Math.max(Number.isSafeInteger(page) ? page : 1, 1), pageCount(list));
/** The page on which task `number` is shown; the last page when there is no such task. */
export function pageOfTask(list, number) {
    const at = list.tasks.findIndex((task) => task.id === number);
    return at === -1 ? pageCount(list) : Math.floor(at / PAGE_SIZE) + 1;
}

function taskLine(task, { shared }) {
    const text = shown(task.text);
    if (task.completed) {
        const by = shared && task.completedBy ? ` by <@${task.completedBy}>` : '';
        return `**#${task.id}** ~~${text}~~ · done${by}`;
    }
    const created = task.createdAt ? Math.floor(Date.parse(task.createdAt) / 1000) : null;
    return `**#${task.id}** ${text}${created === null ? '' : ` · <t:${created}:d>`}`;
}

function taskSection(list, page, { shared, more }) {
    const current = clampPage(list, page);
    const pages = pageCount(list);
    const lines = list.tasks.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map((task) => taskLine(task, { shared }));
    const open = list.tasks.filter((task) => !task.completed).length;
    let summary = `${open} open, ${list.tasks.length - open} done`;
    if (pages > 1) summary += ` · page ${current} of ${pages} (${more})`;
    return `${lines.join('\n')}\n\n${summary}`;
}

export function personalEmbed(list, page = 1) {
    const description = list.tasks.length === 0
        ? 'Your to-do list is empty. Add a task with `/todo add`.'
        : taskSection(list, page, { shared: false, more: 'choose another with the `page` option of `/todo list`' });
    return createEmbed({ title: 'Your To-Do List', description, color: 'success' });
}

function sharedButtons(listId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`shared_todo_add_${listId}`).setLabel('Add Task').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`shared_todo_complete_${listId}`).setLabel('Complete Task').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`shared_todo_remove_${listId}`).setLabel('Remove Task').setStyle(ButtonStyle.Danger),
    );
}

/** The message that shows a shared list, with its three buttons. */
export function sharedPayload(list, page = 1) {
    const head = `**${shown(list.name, 120)}**\nID: \`${list.id}\`\nOwner: <@${list.creatorId}>`;
    const body = list.tasks.length === 0
        ? 'This list is empty. Use the **Add Task** button or `/todo share addtask`.'
        : taskSection(list, page, { shared: true, more: 'choose another with the `page` option of `/todo share view`' });
    const embed = createEmbed({ title: 'Shared To-Do List', description: `${head}\n\n${body}`, color: 'success' })
        .addFields({ name: `Members (${list.members.length})`, value: list.members.map((id) => `<@${id}>`).join(', ') });
    // Mentions in an embed notify nobody; this also keeps it that way if the layout ever changes.
    return { embeds: [embed], components: [sharedButtons(list.id)], allowedMentions: { parse: [] } };
}

/** True when `message` is a view of shared list `listId` that this bot posted. */
export function isSharedViewOf(message, listId, botId) {
    if (!message || !botId || message.author?.id !== botId) return false;
    const wanted = `shared_todo_add_${listId}`;
    return (message.components ?? []).some((row) => (row.components ?? []).some((part) => (part.customId ?? part.custom_id ?? part.data?.custom_id) === wanted));
}

/** The lists of a member, one per line. */
export function sharedIndexEmbed(lists, userId) {
    const description = lists.length === 0
        ? 'You are not in any shared list. Create one with `/todo share create`.'
        : lists.map((list) => {
            const open = list.tasks.filter((task) => !task.completed).length;
            const role = list.creatorId === userId ? 'owner' : `shared by <@${list.creatorId}>`;
            return `**${shown(list.name, 120)}** · \`${list.id}\`\n${open} open of ${list.tasks.length} · ${list.members.length} member${list.members.length === 1 ? '' : 's'} · ${role}`;
        }).join('\n\n');
    return createEmbed({ title: 'Your Shared Lists', description, color: 'success' });
}

/** What a member is told when a request is refused. Nothing was changed in any of these cases. */
export function refusalMessage(reason) {
    switch (reason) {
        case Refusal.INVALID_TEXT:
            return `Please enter text of 1 to ${MAX_TASK_LENGTH} characters for a task, or 1 to ${MAX_NAME_LENGTH} for a list name.`;
        case Refusal.INVALID_LIST_ID:
            return 'That is not a valid shared list ID. Copy it from `/todo share lists`.';
        case Refusal.NOT_FOUND:
            return 'Shared list not found. It may have been deleted.';
        case Refusal.NO_ACCESS:
            return 'You don\'t have access to this list.';
        case Refusal.NOT_OWNER:
            return 'Only the owner of the list can do that.';
        case Refusal.TASK_NOT_FOUND:
            return 'Task not found. Use the number shown in front of the task, for example `3` for #3.';
        case Refusal.ALREADY_COMPLETED:
            return 'That task is already completed.';
        case Refusal.LIST_FULL:
            return `This list already has ${MAX_TASKS} tasks. Remove a task before adding another.`;
        case Refusal.MEMBERS_FULL:
            return `This list already has ${MAX_MEMBERS} members.`;
        case Refusal.TOO_MANY_LISTS:
            return `A member can be in at most ${MAX_LISTS_PER_MEMBER} shared lists. One has to be left or deleted first.`;
        case Refusal.ALREADY_MEMBER:
            return 'That user is already a member of this list.';
        case Refusal.NOT_MEMBER:
            return 'That user is not a member of this list.';
        case Refusal.IS_OWNER:
            return 'The owner cannot leave or be removed. Use `/todo share delete` to delete the list for everyone.';
        default:
            return 'That request could not be carried out. Nothing was changed.';
    }
}

/** What a member is told when the storage failed; `null` when `error` is not a storage failure. */
export function storageFailureMessage(error) {
    switch (error?.code) {
        case 'TODO_UNCERTAIN':
            return 'The database did not confirm the change, so it may or may not have been saved. Look at the list before trying again.';
        case 'TODO_INVALID':
            return 'The stored list cannot be read, so nothing was changed. Please tell the bot owner.';
        case 'TODO_UNAVAILABLE':
            return 'To-do lists are unavailable right now. Nothing was changed. Please try again later.';
        default:
            return null;
    }
}
