// The three buttons under a shared to-do list, and the forms they open.

import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';
import { replyUserError, ErrorTypes } from '../utils/errorHandler.js';
import { MAX_TASK_LENGTH, addSharedTask, completeSharedTask, readShared, removeSharedTask } from '../services/todo/lists.js';
import { isSharedViewOf, pageOfTask, refusalMessage, sharedPayload, shown, storageFailureMessage } from '../services/todo/view.js';

const refuse = (interaction, reason) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: refusalMessage(reason) });

async function storageFailure(interaction, error, where) {
    const message = storageFailureMessage(error);
    if (!message) throw error;
    logger.error(`Shared to-do ${where} storage failure (${error.code}): ${error.cause?.message ?? error.message}`, { userId: interaction.user.id });
    return replyUserError(interaction, { type: ErrorTypes.DATABASE, message });
}

const taskIdInput = (verb) => new TextInputBuilder()
    .setCustomId('task_id')
    .setLabel(`Enter the task number to ${verb}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(10)
    .setPlaceholder('e.g., 1, 2, 3');

const FORMS = {
    add: {
        title: 'Add Task to Shared List',
        input: () => new TextInputBuilder().setCustomId('task_text').setLabel('Enter the task description').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(MAX_TASK_LENGTH),
    },
    complete: { title: 'Complete Task in Shared List', input: () => taskIdInput('complete') },
    remove: { title: 'Remove Task from Shared List', input: () => taskIdInput('remove') },
};

/** A button: only a member of the list gets the form. */
function buttonHandler(kind) {
    return {
        name: `shared_todo_${kind}`,
        async execute(interaction, client, args) {
            const listId = args[0];
            try {
                const access = await readShared(client, listId, interaction.user.id);
                if (!access.ok) return await refuse(interaction, access.reason);
            } catch (error) {
                return await storageFailure(interaction, error, `${kind} button`);
            }
            const modal = new ModalBuilder().setCustomId(`shared_todo_${kind}_modal:${listId}`).setTitle(FORMS[kind].title);
            modal.addComponents(new ActionRowBuilder().addComponents(FORMS[kind].input()));
            await interaction.showModal(modal);
        },
    };
}

/**
 * After a change: redraw the list message the button belongs to, and say what was done.
 * Only a message of this bot that already shows this very list is redrawn. The change is
 * stored at this point, so a redraw that fails is not reported as a failed change.
 */
async function showChange(interaction, client, list, page, title, body) {
    const confirmation = { embeds: [successEmbed(title, body)], flags: MessageFlags.Ephemeral };
    const botId = client?.user?.id ?? interaction.client?.user?.id;
    if (!isSharedViewOf(interaction.message, list.id, botId) || typeof interaction.update !== 'function') {
        return interaction.reply(confirmation);
    }
    try {
        await interaction.update(sharedPayload(list, page));
    } catch (error) {
        logger.warn('Unable to refresh shared todo view message', { listId: list.id, guildId: interaction.guildId, channelId: interaction.channelId, error: error.message });
        // The form may or may not count as answered; say what was done either way.
        return interaction.replied || interaction.deferred ? interaction.followUp(confirmation).catch(() => null) : interaction.reply(confirmation);
    }
    return interaction.followUp(confirmation).catch((error) => {
        logger.warn('Unable to confirm shared todo change', { listId: list.id, error: error.message });
        return null;
    });
}

const numberFrom = (interaction) => {
    const raw = String(interaction.fields.getTextInputValue('task_id') ?? '').trim().replace(/^#/, '');
    return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
};

/** A submitted form. `act` does the change and returns the result of the list operation. */
function modalHandler(kind, tooFast, act, describe) {
    return {
        name: `shared_todo_${kind}_modal`,
        async execute(interaction, client, args) {
            const listId = args[0];
            const userId = interaction.user.id;
            if (!(await checkRateLimit(`${userId}:shared_todo_${kind}`, 5, 30000))) {
                return await replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: tooFast });
            }
            try {
                const out = await act(client, listId, userId, interaction);
                if (!out.ok) return await refuse(interaction, out.reason);
                const page = kind === 'remove' ? 1 : pageOfTask(out.list, out.task.id);
                return await showChange(interaction, client, out.list, page, ...describe(out));
            } catch (error) {
                return await storageFailure(interaction, error, `${kind} form`);
            }
        },
    };
}

const sharedTodoAddHandler = buttonHandler('add');
const sharedTodoCompleteHandler = buttonHandler('complete');
const sharedTodoRemoveHandler = buttonHandler('remove');

const sharedTodoAddModalHandler = modalHandler(
    'add',
    'You are adding tasks too quickly. Please wait and try again.',
    (client, listId, userId, interaction) => addSharedTask(client, listId, userId, interaction.fields.getTextInputValue('task_text')),
    (out) => ['Task Added', `Added #${out.task.id} ${shown(out.task.text)} to the shared list.`],
);

const sharedTodoCompleteModalHandler = modalHandler(
    'complete',
    'You are completing tasks too quickly. Please wait and try again.',
    (client, listId, userId, interaction) => completeSharedTask(client, listId, userId, numberFrom(interaction)),
    (out) => ['Task Completed', `Marked #${out.task.id} ${shown(out.task.text)} as complete.`],
);

const sharedTodoRemoveModalHandler = modalHandler(
    'remove',
    'You are removing tasks too quickly. Please wait and try again.',
    (client, listId, userId, interaction) => removeSharedTask(client, listId, userId, numberFrom(interaction)),
    (out) => ['Task Removed', `Removed #${out.task.id} ${shown(out.task.text)} from the shared list.`],
);

export default sharedTodoAddHandler;
export {
    sharedTodoCompleteHandler,
    sharedTodoRemoveHandler,
    sharedTodoAddModalHandler,
    sharedTodoCompleteModalHandler,
    sharedTodoRemoveModalHandler,
};
