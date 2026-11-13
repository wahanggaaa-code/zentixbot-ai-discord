import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    MAX_NAME_LENGTH, MAX_TASK_LENGTH,
    addPersonalTask, completePersonalTask, removePersonalTask, readPersonal,
    createShared, readShared, listShared, addSharedTask, completeSharedTask, removeSharedTask,
    addSharedMember, removeSharedMember, leaveShared, deleteShared,
} from '../../services/todo/lists.js';
import { personalEmbed, refusalMessage, sharedIndexEmbed, sharedPayload, shown, storageFailureMessage } from '../../services/todo/view.js';

const listId = (option) => option.setName('list_id').setDescription('ID of the shared list (see /todo share lists)').setRequired(true).setMinLength(1).setMaxLength(64);
const taskText = (option) => option.setName('task').setDescription('The task to add').setRequired(true).setMinLength(1).setMaxLength(MAX_TASK_LENGTH);
const taskNumber = (option, verb) => option.setName('number').setDescription(`The number of the task to ${verb}`).setRequired(true).setMinValue(1);
const pageNumber = (option) => option.setName('page').setDescription('Which page to show when the list has more than 10 tasks').setMinValue(1);

export default {
    data: new SlashCommandBuilder()
        .setName('todo')
        .setDescription('Manage your personal to-do list')
        .addSubcommand((subcommand) => subcommand.setName('add').setDescription('Add a task to your to-do list').addStringOption(taskText))
        .addSubcommand((subcommand) => subcommand.setName('list').setDescription('View your to-do list (only you can see it)').addIntegerOption(pageNumber))
        .addSubcommand((subcommand) => subcommand.setName('complete').setDescription('Mark a task as complete').addIntegerOption((option) => taskNumber(option, 'complete')))
        .addSubcommand((subcommand) => subcommand.setName('remove').setDescription('Remove a task from your to-do list').addIntegerOption((option) => taskNumber(option, 'remove')))
        .addSubcommandGroup((group) => group
            .setName('share')
            .setDescription('Manage shared to-do lists')
            .addSubcommand((subcommand) => subcommand.setName('create').setDescription('Create a new shared to-do list')
                .addStringOption((option) => option.setName('name').setDescription('Name for the shared list').setRequired(true).setMinLength(1).setMaxLength(MAX_NAME_LENGTH)))
            .addSubcommand((subcommand) => subcommand.setName('lists').setDescription('Show the shared lists you are in, with their IDs'))
            .addSubcommand((subcommand) => subcommand.setName('add').setDescription('Add a member to a shared list you own').addStringOption(listId)
                .addUserOption((option) => option.setName('user').setDescription('User to add to the list').setRequired(true)))
            .addSubcommand((subcommand) => subcommand.setName('removemember').setDescription('Remove a member from a shared list you own').addStringOption(listId)
                .addUserOption((option) => option.setName('user').setDescription('User to remove from the list').setRequired(true)))
            .addSubcommand((subcommand) => subcommand.setName('leave').setDescription('Leave a shared list somebody else owns').addStringOption(listId))
            .addSubcommand((subcommand) => subcommand.setName('delete').setDescription('Delete a shared list you own, for all its members').addStringOption(listId))
            .addSubcommand((subcommand) => subcommand.setName('view').setDescription('View a shared to-do list').addStringOption(listId).addIntegerOption(pageNumber)
                .addBooleanOption((option) => option.setName('public').setDescription('Post the list in this channel for everyone to see (default: only you)')))
            .addSubcommand((subcommand) => subcommand.setName('addtask').setDescription('Add a task to a shared to-do list').addStringOption(listId).addStringOption(taskText))
            .addSubcommand((subcommand) => subcommand.setName('complete').setDescription('Mark a task of a shared to-do list as complete').addStringOption(listId)
                .addIntegerOption((option) => taskNumber(option, 'complete')))
            .addSubcommand((subcommand) => subcommand.setName('remove').setDescription('Remove a task from a shared to-do list').addStringOption(listId)
                .addIntegerOption((option) => taskNumber(option, 'remove'))))
        .setDMPermission(false)
        .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),
    category: 'Utility',

    async execute(interaction, config, client) {
        const userId = interaction.user.id;
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const options = interaction.options;

        // A to-do list is private. Only a shared list is posted in the channel, and only on request.
        const inPublic = group === 'share' && subcommand === 'view' && options.getBoolean('public') === true;
        const deferSuccess = await InteractionHelper.safeDefer(interaction, inPublic ? {} : { flags: MessageFlags.Ephemeral });
        if (!deferSuccess) {
            logger.warn('Todo interaction defer failed', { userId, guildId: interaction.guildId, commandName: 'todo' });
            return;
        }

        const done = (title, body) => InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(title, body)] });
        const refuse = (reason) => replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: refusalMessage(reason) });

        try {
            if (group === 'share') {
                const id = subcommand === 'create' || subcommand === 'lists' ? null : (options.getString('list_id') ?? '').trim();
                switch (subcommand) {
                    case 'create': {
                        const out = await createShared(client, userId, options.getString('name'));
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Shared List Created', `Created the shared list **${shown(out.list.name, 120)}** with ID \`${out.list.id}\`.\nAdd members with \`/todo share add\`; find the ID again with \`/todo share lists\`.`);
                    }
                    case 'lists':
                        return await InteractionHelper.safeEditReply(interaction, { embeds: [sharedIndexEmbed(await listShared(client, userId), userId)] });
                    case 'view': {
                        const out = await readShared(client, id, userId);
                        if (!out.ok) return await refuse(out.reason);
                        return await InteractionHelper.safeEditReply(interaction, sharedPayload(out.list, options.getInteger('page') ?? 1));
                    }
                    case 'add': {
                        const target = options.getUser('user');
                        if (!target || target.bot) return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'A bot cannot be a member of a shared list.' });
                        const out = await addSharedMember(client, id, userId, target.id);
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Member Added', `<@${target.id}> can now see and change the shared list **${shown(out.list.name, 120)}**. They can leave it with \`/todo share leave\`.`);
                    }
                    case 'removemember': {
                        const target = options.getUser('user');
                        const out = await removeSharedMember(client, id, userId, target.id);
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Member Removed', `<@${target.id}> no longer has access to the shared list **${shown(out.list.name, 120)}**.`);
                    }
                    case 'leave': {
                        const out = await leaveShared(client, id, userId);
                        if (!out.ok) return await refuse(out.reason);
                        return await done('List Left', `You left the shared list **${shown(out.list.name, 120)}**.`);
                    }
                    case 'delete': {
                        const out = await deleteShared(client, id, userId);
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Shared List Deleted', `Deleted the shared list **${shown(out.list.name, 120)}** and its ${out.list.tasks.length} task${out.list.tasks.length === 1 ? '' : 's'} for all members.`);
                    }
                    case 'addtask': {
                        const out = await addSharedTask(client, id, userId, options.getString('task'));
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Task Added', `Added #${out.task.id} ${shown(out.task.text)} to the shared list **${shown(out.list.name, 120)}**.`);
                    }
                    case 'complete': {
                        const out = await completeSharedTask(client, id, userId, options.getInteger('number'));
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Task Completed', `Marked #${out.task.id} ${shown(out.task.text)} as complete in the shared list **${shown(out.list.name, 120)}**.`);
                    }
                    case 'remove': {
                        const out = await removeSharedTask(client, id, userId, options.getInteger('number'));
                        if (!out.ok) return await refuse(out.reason);
                        return await done('Task Removed', `Removed #${out.task.id} ${shown(out.task.text)} from the shared list **${shown(out.list.name, 120)}**.`);
                    }
                    default:
                        return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Invalid subcommand.' });
                }
            }

            switch (subcommand) {
                case 'add': {
                    const out = await addPersonalTask(client, userId, options.getString('task'));
                    if (!out.ok) return await refuse(out.reason);
                    return await done('Task Added', `Added #${out.task.id} ${shown(out.task.text)} to your to-do list.`);
                }
                case 'list': {
                    const list = await readPersonal(client, userId);
                    return await InteractionHelper.safeEditReply(interaction, { embeds: [personalEmbed(list, options.getInteger('page') ?? 1)] });
                }
                case 'complete': {
                    const out = await completePersonalTask(client, userId, options.getInteger('number'));
                    if (!out.ok) return await refuse(out.reason);
                    return await done('Task Completed', `Marked #${out.task.id} ${shown(out.task.text)} as complete.`);
                }
                case 'remove': {
                    const out = await removePersonalTask(client, userId, options.getInteger('number'));
                    if (!out.ok) return await refuse(out.reason);
                    return await done('Task Removed', `Removed #${out.task.id} ${shown(out.task.text)} from your to-do list.`);
                }
                default:
                    return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Invalid subcommand.' });
            }
        } catch (error) {
            const message = storageFailureMessage(error);
            if (!message) throw error;
            logger.error(`Todo command storage failure (${error.code}): ${error.cause?.message ?? error.message}`, { userId, subcommand, group });
            return await replyUserError(interaction, { type: ErrorTypes.DATABASE, message });
        }
    },
};
