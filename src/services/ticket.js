// ticket.js

import {
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { buildStandardLogEmbed, formatLogLine } from '../utils/logging/logEmbeds.js';
import { getGuildConfig } from './config/guildConfig.js';
import { getTicketData, saveTicketData, getOpenTicketCountForUser, listOpenTicketsForUser, incrementTicketCounter } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { createEmbed, errorEmbed } from '../utils/embeds.js';
import { logTicketEvent } from '../utils/ticket/ticketLogging.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { ensureTypedServiceError, wrapServiceBoundary } from '../utils/serviceErrorBoundary.js';
import { PRIORITY_MAP } from '../utils/helpers.js';
import {db as ticketDb} from '../utils/database/wrapper.js';
import {isSQLiteTicketBackend} from './storage/sqliteTickets.js';
const TICKET_DELETE_DELAY_MS = 3000;
const TICKET_DELETE_DELAY_SECONDS = Math.floor(TICKET_DELETE_DELAY_MS / 1000);
const TICKET_SERVICE = 'ticketService';

function ticketUserError(message, userMessage, type = ErrorTypes.VALIDATION, context = {}) {
  throw createError(message, type, userMessage, { service: TICKET_SERVICE, ...context });
}

function requireTicket(ticketData, channel) {
  if (!ticketData) {
    ticketUserError(
      'Not a ticket channel',
      'This is not a ticket channel.',
      ErrorTypes.VALIDATION,
      { channelId: channel?.id, guildId: channel?.guild?.id }
    );
  }
  return ticketData;
}

function rethrowTicketError(error, operation, userMessage, context = {}) {
  if (error?.code === 'TICKET_STALE') {
    // The save is the first change of every action, so nothing else has happened yet.
    throw createError(
      `Ticket changed during ${operation}`,
      ErrorTypes.VALIDATION,
      'This ticket was changed by someone else at the same moment. Your action was not applied. Please try again.',
      { service: TICKET_SERVICE, operation, ticketCode: 'TICKET_STALE', ...context },
    );
  }
  throw ensureTypedServiceError(error, {
    service: TICKET_SERVICE,
    operation,
    message: `Ticket operation failed: ${operation}`,
    userMessage,
    context,
  });
}



function buildClosedControlRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_reopen')
      .setLabel('Reopen Ticket')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔓'),
    new ButtonBuilder()
      .setCustomId('ticket_delete')
      .setLabel('Delete Ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️')
  );
}

const DEFAULT_MAX_TICKETS_PER_USER = 3;

/** The configured per-user limit; anything that is not a positive whole number means the default. */
export function getTicketLimit(config) {
  const value = config?.maxTicketsPerUser;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_TICKETS_PER_USER;
}

/** Runs tasks with the same key one after another, within this bot process. */
const creationQueues = new Map();
function runInTurn(key, task) {
  const previous = creationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.catch(() => {});
  creationQueues.set(key, tail);
  tail.then(() => {
    if (creationQueues.get(key) === tail) creationQueues.delete(key);
  });
  return run;
}

/**
 * The first message of a ticket (embed and control buttons). New tickets store
 * its ID. Older tickets are searched in the most recent messages, which misses
 * the message once the conversation is longer than one page.
 */
async function findTicketMessage(channel, ticketData, recentMessages) {
  if (ticketData.messageId) {
    try {
      return await channel.messages.fetch(ticketData.messageId);
    } catch (error) {
      if (error?.code !== 10008) throw error;
    }
  }
  return recentMessages.find(m =>
    m.embeds.length > 0 &&
    m.embeds[0].title?.startsWith('Ticket #')
  );
}

/**
 * Open tickets of a user. When the limit seems reached, records whose channel
 * no longer exists in Discord are marked deleted first, so that a channel
 * removed while the bot was offline does not block the user forever.
 */
export async function countOpenTickets(guild, userId, limit) {
  const count = await getOpenTicketCountForUser(guild.id, userId);
  if (count < limit) return count;
  const open = await listOpenTicketsForUser(guild.id, userId);
  if (!open) return count;
  let missing = 0;
  for (const { channelId, data } of open) {
    if (guild.channels.cache.has(channelId)) continue;
    try {
      await guild.channels.fetch(channelId);
      continue;
    } catch (error) {
      // Only "Unknown Channel" proves that the channel is gone.
      if (error?.code !== 10003) continue;
    }
    try {
      data.status = 'deleted';
      data.closedAt = new Date().toISOString();
      data.deletedReason = 'channel_missing';
      await saveTicketData(guild.id, channelId, data);
      missing += 1;
      logger.info(`Ticket ${channelId} in guild ${guild.id} marked deleted: its channel no longer exists`);
    } catch (error) {
      logger.warn(`Could not mark ticket ${channelId} as deleted: ${error.message}`);
    }
  }
  return missing > 0 ? getOpenTicketCountForUser(guild.id, userId) : count;
}

function buildTicketControlRow({ claimedBy = null } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_claim')
      .setLabel(claimedBy ? 'Claimed' : 'Claim')
      .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setEmoji('🙋')
      .setDisabled(!!claimedBy),
    new ButtonBuilder()
      .setCustomId('ticket_pin')
      .setLabel('Pin')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📌'),
    new ButtonBuilder()
      .setCustomId('ticket_close')
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔒'),
  );
}

export const getUserTicketCount = wrapServiceBoundary(async function getUserTicketCount(guildId, userId) {
  return await getOpenTicketCountForUser(guildId, userId);
}, {
  service: TICKET_SERVICE,
  operation: 'getUserTicketCount',
  userMessage: 'Failed to count open tickets.',
  context: {},
});

export async function createTicket(guild, member, categoryId, reason = 'No reason provided', priority = 'none') {
  try {
    if (isSQLiteTicketBackend(ticketDb) || guild?.client?.db?.db?.sqlite?.dialect==='sqlite') ticketUserError('SQLite ticket creation unavailable','Ticket creation is temporarily unavailable. No channel was created.',ErrorTypes.DATABASE);
    // One creation at a time per user: the limit check and the new record must not interleave.
    return await runInTurn(`${guild.id}:${member.id}`, () => createTicketInTurn(guild, member, categoryId, reason, priority));
  } catch (error) {
    rethrowTicketError(error, 'createTicket', 'Failed to create ticket. Please try again in a moment.', { guildId: guild?.id, userId: member?.id });
  }
}

async function createTicketInTurn(guild, member, categoryId, reason, priority) {
    const config = await getGuildConfig(guild.client, guild.id);
    const ticketConfig = config.tickets || {};
    
    const maxTicketsPerUser = getTicketLimit(config);
    const currentTicketCount = await countOpenTickets(guild, member.id, maxTicketsPerUser);
    
    if (currentTicketCount >= maxTicketsPerUser) {
      ticketUserError(
        `Max open tickets reached for ${member.id}`,
        `You have reached the maximum number of open tickets (${maxTicketsPerUser}). Please close your existing tickets before creating a new one.`,
        ErrorTypes.VALIDATION,
        { guildId: guild.id, userId: member.id, operation: 'createTicket', ticketCode: 'TICKET_LIMIT' }
      );
    }
    
    // Allocate before any Discord mutation: a database failure must not create a category.
    const ticketNumber = await getNextTicketNumber(guild.id);

    let category = categoryId ? 
      guild.channels.cache.get(categoryId) :
      guild.channels.cache.find(c => 
        c.type === ChannelType.GuildCategory && 
        c.name.toLowerCase().includes('tickets')
      );
    
    if (!category && !categoryId) {
      category = await guild.channels.create({
        name: 'Tickets',
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
        ],
      });
    }
    
    let channelName = `ticket-${ticketNumber}`;
    
    if (priority !== 'none') {
      const priorityInfo = PRIORITY_MAP[priority];
      if (priorityInfo) {
        channelName = `${priorityInfo.emoji} ${channelName}`;
      }
    }
    
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...(config.ticketStaffRoleId ? [{
          id: config.ticketStaffRoleId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        }] : []),
      ],
    });
    
    const ticketData = {
      id: channel.id,
      userId: member.id,
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      status: 'open',
      claimedBy: null,
      priority: priority || 'none',
      reason,
    };

    // From here on a channel exists. If the ticket cannot be completed, the
    // channel is removed again so that no channel is left without a record.
    let ticketMessage;
    try {
      const priorityInfo = PRIORITY_MAP[priority] || PRIORITY_MAP.none;

      const embed = createEmbed({
        title: `Ticket #${ticketNumber}`,
        description: `${member.toString()}, thanks for creating a ticket!\n\n**Reason:** ${reason}\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
        color: priorityInfo.color,
        fields: [
          { name: 'Status', value: '🟢 Open', inline: true },
          { name: 'Claimed By', value: 'Not claimed', inline: true },
          { name: 'Created', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
        ],
      });

      const row = buildTicketControlRow();

      if (ticketConfig.enablePriority) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId('ticket_priority:low')
            .setLabel('Low')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔵'),
          new ButtonBuilder()
            .setCustomId('ticket_priority:high')
            .setLabel('High')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔴')
        );
      }

      const staffMention = config.ticketStaffRoleId ? ` <@&${config.ticketStaffRoleId}>` : '';
      const messageContent = `${member.toString()}${staffMention}`;

      ticketMessage = await channel.send({
        content: messageContent,
        embeds: [embed],
        components: [row]
      });
      ticketData.messageId = ticketMessage.id;

      await saveTicketData(guild.id, channel.id, ticketData);
    } catch (error) {
      let removed = false;
      try {
        await channel.delete('Ticket creation failed');
        removed = true;
      } catch (cleanupError) {
        if (cleanupError?.code === 10003) removed = true;
        else logger.error(`Could not remove channel ${channel.id} of a failed ticket: ${cleanupError.message}`);
      }
      logger.error(`Ticket creation failed after channel ${channel.id} was created (channel removed: ${removed}): ${error.message}`);
      ticketUserError(
        `Ticket creation failed after channel creation: ${error.message}`,
        removed
          ? 'The ticket could not be created. No ticket was opened; please try again in a moment.'
          : `The ticket could not be created, and the unfinished channel <#${channel.id}> could not be removed. Please ask staff to delete it.`,
        ErrorTypes.UNKNOWN,
        { guildId: guild.id, userId: member.id, channelId: channel.id, operation: 'createTicket', ticketCode: removed ? 'TICKET_CREATE_FAILED' : 'TICKET_CREATE_ORPHAN' }
      );
    }

    await ticketMessage.pin().catch(() => {});
    
    await logTicketEvent({
      client: guild.client,
      guildId: guild.id,
      event: {
        type: 'open',
        ticketId: channel.id,
        ticketNumber: ticketNumber,
        userId: member.id,
        executorId: member.id,
        reason: reason,
        priority: priority || 'none',
        metadata: {
          channelId: channel.id,
          categoryName: category?.name || 'Default'
        }
      }
    });
    
    return { channel, ticketData };
}

export async function closeTicket(channel, closer, reason = 'No reason provided') {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    if (ticketData.status === 'closed') {
      // An earlier close may have stopped after saving, before the Reopen and
      // Delete buttons were posted. Closing again restores them and does nothing else.
      let hasControls = false;
      try {
        const recent = await channel.messages.fetch();
        hasControls = recent.some(m => m.components?.some(row => row.components?.some(c => c.customId === 'ticket_reopen')));
      } catch (fetchError) {
        logger.warn(`Could not look for the controls of closed ticket ${channel.id}: ${fetchError.message}`);
      }
      if (!hasControls) {
        await channel.send({
          embeds: [createEmbed({
            title: 'Ticket Closed',
            description: `This ticket is closed.\n**Reason:** ${ticketData.closeReason || 'No reason provided'}`,
            color: '#e74c3c',
            footer: { text: `Ticket ID: ${ticketData.id}` }
          })],
          components: [buildClosedControlRow()]
        });
        return ticketData;
      }
      ticketUserError(
        'Ticket already closed',
        'This ticket is already closed.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'closeTicket', ticketCode: 'TICKET_NOT_OPEN' }
      );
    }

    const config = await getGuildConfig(channel.client, channel.guild.id);
    const dmOnClose = config.dmOnClose !== false;
    let dmSent = false;
    const closedCategoryId = config.ticketClosedCategoryId || null;
    let movedToClosedCategory = false;
    
    ticketData.status = 'closed';
    ticketData.closedBy = closer.id;
    ticketData.closedAt = new Date().toISOString();
    ticketData.closeReason = reason;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (closedCategoryId && channel.parentId !== closedCategoryId) {
      const closedCategory = channel.guild.channels.cache.get(closedCategoryId)
        || await channel.guild.channels.fetch(closedCategoryId).catch(() => null);

      if (closedCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(closedCategoryId, { lockPermissions: false });
          movedToClosedCategory = true;
        } catch (moveError) {
            logger.warn(`Could not move ticket ${channel.id} to closed category ${closedCategoryId}: ${moveError.message}`);
        }
      } else {
        logger.warn(`Configured closed category is invalid for guild ${channel.guild.id}: ${closedCategoryId}`);
      }
    }
    
    if (dmOnClose) {
      try {
        const ticketCreator = await channel.client.users.fetch(ticketData.userId).catch(() => null);
        if (ticketCreator) {
          const dmEmbed = createEmbed({
            title: '🎫 Your Ticket Has Been Closed',
            description: `Your ticket **${channel.name}** has been closed.\n\n**Reason:** ${reason}\n**Closed by:** ${closer.tag}\n**Closed at:** <t:${Math.floor(Date.now() / 1000)}:F>\n\nThank you for using our support system! If you have any further questions, feel free to create a new ticket.`,
            color: '#e74c3c',
            footer: { text: `Ticket ID: ${ticketData.id}` }
          });

          await ticketCreator.send({ embeds: [dmEmbed] });
          dmSent = true;

          try {
            const feedbackEmbed = createEmbed({
              title: '⭐ How was your support experience?',
              description: `We'd love to know how we did with **${channel.name}**.\nSelect a rating below — it only takes a second!`,
              color: '#F1C40F',
              footer: { text: 'Your feedback helps us improve.' },
            });

            const base = `ticket_feedback:${channel.guild.id}:${channel.id}`;
            const starsRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`${base}:1`).setLabel('⭐ 1').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:2`).setLabel('⭐ 2').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:3`).setLabel('⭐ 3').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:4`).setLabel('⭐ 4').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`${base}:5`).setLabel('⭐ 5').setStyle(ButtonStyle.Primary),
            );
            const declineRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`ticket_feedback_comment:${channel.guild.id}:${channel.id}`)
                .setLabel('✍️ Add Comment')
                .setStyle(ButtonStyle.Secondary),
              new ButtonBuilder()
                .setCustomId(`ticket_feedback_decline:${channel.guild.id}:${channel.id}`)
                .setLabel('❌ No thanks')
                .setStyle(ButtonStyle.Secondary),
            );

            await ticketCreator.send({
              embeds: [feedbackEmbed],
              components: [starsRow, declineRow],
            });
          } catch (feedbackError) {
            logger.warn(`Could not send feedback survey to ticket creator ${ticketData.userId}: ${feedbackError.message}`);
          }
        }
      } catch (dmError) {
          logger.warn(`Could not send DM to ticket creator ${ticketData.userId}: ${dmError.message}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      const targetUser = user?.user || await channel.client.users.fetch(ticketData.userId).catch(() => null);
      
      if (targetUser) {
        const overwrite = channel.permissionOverwrites.cache.get(ticketData.userId);
        if (overwrite) {
          await overwrite.edit({
            ViewChannel: false,
            SendMessages: false,
          });
        } else {
          await channel.permissionOverwrites.create(targetUser, {
            ViewChannel: false,
            SendMessages: false,
          });
        }
      }
    } catch (permError) {
        logger.warn(`Could not update user permissions for closed ticket: ${permError.message}`);
    }
    
    // Cosmetic: a failure here must not prevent the Reopen and Delete buttons below.
    try {
      const messages = await channel.messages.fetch();
      const ticketMessage = await findTicketMessage(channel, ticketData, messages);
    
      if (ticketMessage) {
        const embed = ticketMessage.embeds[0];
        const statusField = embed.fields?.find(f => f.name === 'Status');
      
        if (statusField) {
          statusField.value = '🔴 Closed';
        }
      
        const updatedEmbed = createEmbed({
          title: embed.title || 'Ticket',
          description: embed.description || 'Ticket discussion',
          color: '#e74c3c',
          fields: embed.fields || [],
          footer: embed.footer
        });
      
        await ticketMessage.edit({
          embeds: [updatedEmbed],
          components: []
        });
      }
    } catch (editError) {
      logger.warn(`Could not update the first message of closed ticket ${channel.id}: ${editError.message}`);
    }
    
    const closeEmbed = createEmbed({
      title: 'Ticket Closed',
      description: `This ticket has been closed by ${closer}.\n**Reason:** ${reason}${dmOnClose ? (dmSent ? '\n\n📩 A DM has been sent to the ticket creator.' : '\n\n⚠️ The ticket creator could not be notified by DM.') : ''}`,
      color: '#e74c3c',
      footer: { text: `Ticket ID: ${ticketData.id}` }
    });
    
    await channel.send({ embeds: [closeEmbed], components: [buildClosedControlRow()] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'close',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: closer.id,
        reason: reason,
        metadata: {
          dmSent,
          closedAt: ticketData.closedAt,
          movedToClosedCategory
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'closeTicket', 'Failed to close ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, closerId: closer?.id });
  }
}

export async function claimTicket(channel, claimer) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    if (ticketData.status === 'closed') {
      ticketUserError(
        'Ticket is closed',
        'This ticket is closed. Reopen it before claiming it.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'claimTicket', ticketCode: 'TICKET_NOT_OPEN' }
      );
    }

    if (ticketData.claimedBy) {
      ticketUserError(
        'Ticket already claimed',
        `This ticket is already claimed by <@${ticketData.claimedBy}>`,
        ErrorTypes.VALIDATION,
        { channelId: channel.id, claimedBy: ticketData.claimedBy, operation: 'claimTicket', ticketCode: 'TICKET_CLAIMED' }
      );
    }
    
    ticketData.claimedBy = claimer.id;
    ticketData.claimedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    
    const messages = await channel.messages.fetch();
    const ticketMessage = await findTicketMessage(channel, ticketData, messages);
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => f.name === 'Claimed By');
      
      if (claimedField) {
        claimedField.value = claimer.toString();
      }
      
      const row = buildTicketControlRow({ claimedBy: claimer.id });
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimEmbed = createEmbed({
      title: 'Ticket Claimed',
      description: `🎉 ${claimer} has claimed this ticket!`,
      color: '#2ecc71'
    });
    
    const unclaimRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ticket_unclaim')
        .setLabel('Unclaim')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('🔓')
    );

    const claimStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      (m.embeds[0].title === 'Ticket Claimed' || m.embeds[0].title === 'Ticket Unclaimed')
    );

    if (claimStatusMessage) {
      await claimStatusMessage.edit({ embeds: [claimEmbed], components: [unclaimRow] });
    } else {
      await channel.send({ embeds: [claimEmbed], components: [unclaimRow] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'claim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: claimer.id,
        metadata: {
          claimedAt: ticketData.claimedAt
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'claimTicket', 'Failed to claim ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, claimerId: claimer?.id });
  }
}

export async function reopenTicket(channel, reopener) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    if (ticketData.status !== 'closed') {
      ticketUserError(
        'Ticket not closed',
        'This ticket is not currently closed.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'reopenTicket', ticketCode: 'TICKET_NOT_CLOSED' }
      );
    }

    const config = await getGuildConfig(channel.client, channel.guild.id);
    const openCategoryId = config.ticketCategoryId || null;
    let movedToOpenCategory = false;
    let openCategoryMoveFailed = false;
    
    ticketData.status = 'open';
    ticketData.closedBy = null;
    ticketData.closedAt = null;
    ticketData.closeReason = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    if (openCategoryId && channel.parentId !== openCategoryId) {
      const openCategory = channel.guild.channels.cache.get(openCategoryId)
        || await channel.guild.channels.fetch(openCategoryId).catch(() => null);

      if (openCategory?.type === ChannelType.GuildCategory) {
        try {
          await channel.setParent(openCategoryId, { lockPermissions: false });
          movedToOpenCategory = true;
        } catch (moveError) {
          openCategoryMoveFailed = true;
          logger.warn(`Could not move reopened ticket ${channel.id} to open category ${openCategoryId}: ${moveError.message}`);
        }
      } else {
        openCategoryMoveFailed = true;
        logger.warn(`Configured open ticket category is invalid for guild ${channel.guild.id}: ${openCategoryId}`);
      }
    }
    
    try {
      const user = await channel.guild.members.fetch(ticketData.userId).catch(() => null);
      if (user) {
        await channel.permissionOverwrites.create(user, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true
        });
      }
    } catch (error) {
      logger.warn(`Could not restore access for user ${ticketData.userId}:`, error.message);
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = await findTicketMessage(channel, ticketData, messages);
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const statusField = embed.fields?.find(f => f.name === 'Status');
      
      if (statusField) {
        statusField.value = '🟢 Open';
      }
      
      const row = buildTicketControlRow({ claimedBy: ticketData.claimedBy });
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const reopenEmbed = createEmbed({
      title: 'Ticket Reopened',
      description: `🔓 ${reopener} has reopened this ticket!`,
      color: '#2ecc71'
    });

    const closeStatusMessage = messages.find(m =>
      m.embeds.length > 0 &&
      m.embeds[0].title === 'Ticket Closed' &&
      m.components.length > 0 &&
      m.components[0].components.some(c => c.customId === 'ticket_reopen')
    );

    if (closeStatusMessage) {
      await closeStatusMessage.edit({ embeds: [reopenEmbed], components: [] });
    } else {
      await channel.send({ embeds: [reopenEmbed] });
    }
    
    return { ticketData, movedToOpenCategory, openCategoryMoveFailed };
    
  } catch (error) {
    rethrowTicketError(error, 'reopenTicket', 'Failed to reopen ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, reopenerId: reopener?.id });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function generateTranscript(channel) {
  try {
    logger.debug('Generating transcript for channel', {
      channelId: channel.id,
      channelName: channel.name
    });

    const messages = [];
    let before = undefined;
    let batch;
    do {
      batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      messages.push(...batch.values());
      before = batch.last()?.id;
    } while (batch.size === 100);

    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const escape = (str) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const rows = messages.map((msg) => {
      const ts = new Date(msg.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const author = escape(msg.author?.tag ?? msg.author?.username ?? 'Unknown');
      const content = escape(msg.content || (msg.embeds.length ? '[embed]' : '[attachment]'));
      return `<tr><td class="ts">${ts}</td><td class="author">${author}</td><td class="msg">${content}</td></tr>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcript – #${escape(channel.name)}</title>
<style>
body{font-family:sans-serif;background:#36393f;color:#dcddde;margin:0;padding:16px}
h1{color:#fff;font-size:1.2rem;margin-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th{background:#2f3136;color:#8e9297;padding:6px 8px;text-align:left;border-bottom:2px solid #202225}
td{padding:4px 8px;border-bottom:1px solid #40444b;vertical-align:top}
.ts{color:#72767d;white-space:nowrap;width:160px}
.author{color:#7289da;white-space:nowrap;width:160px}
.msg{word-break:break-word}
</style>
</head>
<body>
<h1>📜 Transcript – #${escape(channel.name)}</h1>
<p style="color:#72767d">${messages.length} message(s) exported on ${new Date().toUTCString()}</p>
<table>
<thead><tr><th>Timestamp (UTC)</th><th>Author</th><th>Message</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;

    const buffer = Buffer.from(html, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `ticket-${channel.id}.html` });

    logger.info('✅ Successfully generated transcript', {
      channelId: channel.id,
      channelName: channel.name,
      messageCount: messages.length,
      size: buffer.length
    });

    return attachment;
  } catch (error) {
    logger.error('❌ Failed to generate transcript:', {
      channelId: channel.id,
      channelName: channel.name,
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack
    });
    return null;
  }
}

/** Channels with a deletion already scheduled in this bot process. */
const pendingDeletions = new Set();

export async function deleteTicket(channel, deleter, { delayMs = TICKET_DELETE_DELAY_MS } = {}) {
  try {
    if (isSQLiteTicketBackend(ticketDb) || channel?.client?.db?.db?.sqlite?.dialect==='sqlite') ticketUserError('SQLite ticket deletion unavailable','Ticket deletion is temporarily unavailable. No channel was deleted.',ErrorTypes.DATABASE);
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);

    if (pendingDeletions.has(channel.id)) {
      ticketUserError(
        'Ticket deletion already scheduled',
        'This ticket is already being deleted.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'deleteTicket', ticketCode: 'TICKET_DELETE_PENDING' }
      );
    }
    pendingDeletions.add(channel.id);

    try {
      const deleteEmbed = createEmbed({
        title: 'Ticket Deleted',
        description: `🗑️ This ticket will be permanently deleted in ${TICKET_DELETE_DELAY_SECONDS} seconds.`,
        color: '#e74c3c',
        footer: { text: `Ticket ID: ${ticketData.id}` }
      });

      await channel.send({ embeds: [deleteEmbed] });
    } catch (error) {
      pendingDeletions.delete(channel.id);
      throw error;
    }

    setTimeout(() => {
      performTicketDeletion(channel, ticketData, deleter)
        .catch((error) => {
          logger.error('❌ Unexpected error during ticket deletion:', {
            channelId: channel.id,
            channelName: channel?.name,
            ticketNumber: ticketData?.id,
            errorMessage: error.message,
            errorName: error.name,
            errorStack: error.stack
          });
        })
        .finally(() => pendingDeletions.delete(channel.id));
    }, delayMs);

    return ticketData;

  } catch (error) {
    rethrowTicketError(error, 'deleteTicket', 'Failed to delete ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, deleterId: deleter?.id });
  }
}

/** Sends the transcript to the configured channel. Returns whether it arrived. */
async function deliverTranscript(channel, ticketData, deleter, transcriptChannelId) {
  const attachment = await generateTranscript(channel);
  if (!attachment) return false;

  try {
    const transcriptChannel = await channel.client.channels.fetch(transcriptChannelId).catch(() => null);

    if (!transcriptChannel) {
      logger.error('Could not fetch transcript channel', { channelId: channel.id, transcriptChannelId });
      return false;
    }
    if (!transcriptChannel.isSendable()) {
      logger.error('Transcript channel exists but is not sendable', { channelId: channel.id, transcriptChannelId });
      return false;
    }

    const transcriptEmbed = buildStandardLogEmbed({
      color: 0x3498db,
      title: 'Ticket Transcript',
      description: [
        formatLogLine('Ticket', `#${ticketData.id}`),
        formatLogLine('Channel', `#${channel.name}`),
        formatLogLine('Generated', `<t:${Math.floor(Date.now() / 1000)}:F>`),
      ].join('\n'),
      footer: deleter?.username
        ? { text: `Deleted by ${deleter.username}`, iconURL: deleter.displayAvatarURL?.() }
        : undefined,
      timestamp: true,
    });

    await transcriptChannel.send({ embeds: [transcriptEmbed], files: [attachment] });

    logger.info('✅ Transcript sent successfully', {
      channelId: channel.id,
      ticketNumber: ticketData.id,
      transcriptChannelId: transcriptChannel.id
    });
    return true;
  } catch (sendError) {
    logger.error('Failed to send transcript to channel:', {
      channelId: channel.id,
      ticketNumber: ticketData.id,
      error: sendError.message
    });
    return false;
  }
}

async function announceDeletionCancelled(channel, text) {
  try {
    await channel.send({ embeds: [createEmbed({ title: 'Deletion Cancelled', description: text, color: '#f39c12' })] });
  } catch (error) {
    logger.warn(`Could not announce the cancelled deletion in ticket ${channel.id}: ${error.message}`);
  }
}

/**
 * Deletes the ticket channel. When a transcript channel is configured, the
 * channel is deleted only after the transcript has arrived there: deleting
 * the channel is the point of no return for the conversation.
 *
 * Returns { deleted, transcript } with transcript one of
 * 'sent', 'not_configured', 'failed'.
 */
export async function performTicketDeletion(channel, ticketData, deleter) {
  let transcriptChannelId;
  try {
    const guildConfig = await getGuildConfig(channel.client, channel.guild.id);
    transcriptChannelId = guildConfig.ticketTranscriptChannelId || null;
  } catch (error) {
    logger.error(`Ticket ${channel.id} not deleted: settings could not be read: ${error.message}`);
    await announceDeletionCancelled(channel, '⚠️ The ticket settings could not be read, so this ticket was **not** deleted. Please try again in a moment.');
    return { deleted: false, transcript: 'failed' };
  }

  let transcript = 'not_configured';
  if (transcriptChannelId) {
    if (!await deliverTranscript(channel, ticketData, deleter, transcriptChannelId)) {
      await announceDeletionCancelled(
        channel,
        `⚠️ The transcript could not be saved to <#${transcriptChannelId}>, so this ticket was **not** deleted.\n\nCheck the transcript channel in the ticket settings and the bot's permissions there, then press **Delete Ticket** again.`
      );
      return { deleted: false, transcript: 'failed' };
    }
    transcript = 'sent';
  }

  try {
    await channel.delete('Ticket deleted permanently');
  } catch (deleteError) {
    if (deleteError?.code !== 10003) {
      logger.error('❌ Failed to delete ticket channel:', {
        channelId: channel.id,
        channelName: channel.name,
        ticketNumber: ticketData.id,
        errorMessage: deleteError.message,
        errorCode: deleteError.code,
        errorName: deleteError.name
      });
      await announceDeletionCancelled(channel, '⚠️ The bot could not delete this channel. Check its **Manage Channels** permission, then press **Delete Ticket** again.');
      return { deleted: false, transcript };
    }
  }

  logger.info('✅ Channel deleted', {
    channelId: channel.id,
    channelName: channel.name,
    ticketNumber: ticketData.id
  });

  await logTicketEvent({
    client: channel.client,
    guildId: channel.guild.id,
    event: {
      type: 'delete',
      ticketId: channel.id,
      ticketNumber: ticketData.id,
      userId: ticketData.userId,
      executorId: deleter.id,
      metadata: {
        deletedAt: new Date().toISOString(),
        transcript
      }
    }
  });

  return { deleted: true, transcript };
}

export async function unclaimTicket(channel, unclaimer) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    if (!ticketData.claimedBy) {
      ticketUserError(
        'Ticket not claimed',
        'This ticket is not currently claimed.',
        ErrorTypes.VALIDATION,
        { channelId: channel.id, operation: 'unclaimTicket' }
      );
    }
    
    if (ticketData.claimedBy !== unclaimer.id && !unclaimer.permissions.has(PermissionFlagsBits.ManageChannels)) {
      ticketUserError(
        'Cannot unclaim ticket',
        'You can only unclaim your own tickets or need Manage Channels permission.',
        ErrorTypes.PERMISSION,
        { channelId: channel.id, operation: 'unclaimTicket' }
      );
    }
    
    const previousClaimer = ticketData.claimedBy;
    ticketData.claimedBy = null;
    ticketData.claimedAt = null;
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);
    
    const messages = await channel.messages.fetch();
    const ticketMessage = await findTicketMessage(channel, ticketData, messages);
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      const claimedField = embed.fields?.find(f => f.name === 'Claimed By');
      
      if (claimedField) {
        claimedField.value = 'Not claimed';
      }
      
      const row = buildTicketControlRow();
      
      await ticketMessage.edit({ 
        embeds: [embed],
        components: [row] 
      });
    }
    
    const claimMessage = messages.find(m => 
      m.embeds.length > 0 && 
      (m.embeds[0].title === 'Ticket Claimed' || m.embeds[0].title === 'Ticket Unclaimed')
    );
    
    if (claimMessage) {
      const unclaimEmbed = createEmbed({
        title: 'Ticket Unclaimed',
        description: `🔓 ${unclaimer} has unclaimed this ticket!`,
        color: '#f39c12'
      });
      
      await claimMessage.edit({ 
        embeds: [unclaimEmbed],
        components: []
      });
    } else {
      const unclaimEmbed = createEmbed({
        title: 'Ticket Unclaimed',
        description: `🔓 ${unclaimer} has unclaimed this ticket!`,
        color: '#f39c12'
      });
      
      await channel.send({ embeds: [unclaimEmbed] });
    }
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'unclaim',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: unclaimer.id,
        metadata: {
          previousClaimer: previousClaimer
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'unclaimTicket', 'Failed to unclaim ticket. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, unclaimerId: unclaimer?.id });
  }
}

async function getNextTicketNumber(guildId) {
  return await incrementTicketCounter(guildId);
}

export async function updateTicketPriority(channel, priority, updater) {
  try {
    const ticketData = requireTicket(await getTicketData(channel.guild.id, channel.id), channel);
    
    const priorityInfo = PRIORITY_MAP[priority];
    if (!priorityInfo) {
      ticketUserError(
      'Invalid priority level',
      'Invalid priority level.',
      ErrorTypes.VALIDATION,
      { channelId: channel.id, priority, operation: 'updateTicketPriority' }
    );
    }
    
    const previousPriority = ticketData.priority || 'none';
    ticketData.priority = priority;
    ticketData.priorityUpdatedBy = updater.id;
    ticketData.priorityUpdatedAt = new Date().toISOString();
    
    await saveTicketData(channel.guild.id, channel.id, ticketData);

    const currentName = channel.name;
    const priorityEmojis = [...new Set(Object.values(PRIORITY_MAP).map((item) => item.emoji).filter(Boolean))];
    const escapedPriorityEmojis = priorityEmojis.map((emoji) => emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const cleanName = escapedPriorityEmojis.length > 0
      ? currentName.replace(new RegExp(`(?:${escapedPriorityEmojis.join('|')})`, 'g'), '').trim()
      : currentName.trim();
    const newName = priority === 'none' ? cleanName : `${priorityInfo.emoji} ${cleanName}`;

    if (newName && newName !== currentName) {
      try {
        await channel.setName(newName);
      } catch (nameError) {
        logger.warn(`Could not update channel name for priority: ${nameError.message}`);
      }
    }
    
    const messages = await channel.messages.fetch();
    const ticketMessage = await findTicketMessage(channel, ticketData, messages);
    
    if (ticketMessage) {
      const embed = ticketMessage.embeds[0];
      
      const updatedEmbed = createEmbed({
        title: embed.title || 'Ticket',
        description: embed.description?.split('\n**Priority:**')[0] + `\n**Priority:** ${priorityInfo.emoji} ${priorityInfo.label}`,
        color: priorityInfo.color,
        fields: embed.fields || [],
        footer: embed.footer
      });
      
      await ticketMessage.edit({ embeds: [updatedEmbed] });
    }
    
    const updateEmbed = createEmbed({
      title: 'Priority Updated',
      description: `📊 Ticket priority updated to **${priorityInfo.emoji} ${priorityInfo.label}** by ${updater}`,
      color: priorityInfo.color
    });
    
    await channel.send({ embeds: [updateEmbed] });
    
    await logTicketEvent({
      client: channel.client,
      guildId: channel.guild.id,
      event: {
        type: 'priority',
        ticketId: channel.id,
        ticketNumber: ticketData.id,
        userId: ticketData.userId,
        executorId: updater.id,
        priority: priority,
        metadata: {
          previousPriority,
          updatedAt: ticketData.priorityUpdatedAt
        }
      }
    });
    
    return ticketData;
    
  } catch (error) {
    rethrowTicketError(error, 'updateTicketPriority', 'Failed to update ticket priority. Please try again in a moment.', { guildId: channel?.guild?.id, channelId: channel?.id, updaterId: updater?.id, priority });
  }
}