import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { ZentixBotError, ErrorTypes, handleInteractionError, replyUserError } from '../utils/errorHandler.js';
import { 
    getGuildGiveaways, 
    saveGiveaway, 
    isGiveawayEnded 
} from '../utils/giveaways.js';
import { Mutex } from '../utils/mutex.js';
import {InteractionHelper} from '../utils/interactionHelper.js';
import {isPostgresGiveawayBackend,joinPostgresGiveaway} from '../services/storage/postgresGiveawayTransactions.js';
import {isSQLiteGiveawayBackend,joinSQLiteGiveaway} from '../services/storage/sqliteGiveaways.js';
import {prepareGiveawayDelivery,completeGiveawayDelivery} from '../services/storage/giveawayDelivery.js';
import { 
    selectWinners,
    isUserRateLimited,
    recordUserInteraction,
    createGiveawayEmbed,
    createGiveawayButtons
} from '../services/giveawayService.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';

export const giveawayJoinHandler = {
    customId: 'giveaway_join',
    async execute(interaction, client) {
        try {
            
            if (isUserRateLimited(interaction.user.id, interaction.message.id)) {
                return replyUserError(interaction, { type: ErrorTypes.RATE_LIMIT, message: 'Please wait a moment before interacting with this giveaway again.' });
            }

            if(isPostgresGiveawayBackend(client)&&!await InteractionHelper.safeDefer(interaction,{flags:MessageFlags.Ephemeral}))return;
            await recordUserInteraction(interaction.user.id, interaction.message.id);

            if(isPostgresGiveawayBackend(client)){
                if(!interaction.inGuild())throw new ZentixBotError('Invalid guild',ErrorTypes.VALIDATION,'This button must be used in the server.');
                let joined;try{joined=await joinPostgresGiveaway(client,interaction.guildId,interaction.message.id,interaction.user.id)}catch(e){
                    if(e.code==='GIVEAWAY_ENDED')return replyUserError(interaction,{type:ErrorTypes.VALIDATION,message:'This giveaway has ended.'});
                    // Deleted, or being deleted: the entry was definitely not saved.
                    if(e.code==='GIVEAWAY_MISSING'||e.code==='GIVEAWAY_DELETING')return replyUserError(interaction,{type:ErrorTypes.VALIDATION,message:'This giveaway no longer exists. Your entry was not saved.'});
                    throw new ZentixBotError('Giveaway join failed',ErrorTypes.DATABASE,'Entry may or may not have been saved. Check before retrying.');
                }
                if(joined.status==='already')return replyUserError(interaction,{type:ErrorTypes.VALIDATION,message:'You have already entered this giveaway!'});
                // Do not refresh the public message: a delayed join edit could
                // overwrite an end announcement made by another process.
                return InteractionHelper.safeReply(interaction,{embeds:[successEmbed('Entry saved',`Your entry is recorded. There are ${joined.entries} stored entries; the public count may not update until the giveaway ends.`)],flags:MessageFlags.Ephemeral});
            }

            const lockKey = `giveaway:${interaction.message.id}`;
            await Mutex.runExclusive(lockKey, async () => {
                let giveaway,participants;
                if(isSQLiteGiveawayBackend(client)){
                    const joined=joinSQLiteGiveaway(client,interaction.guildId,interaction.message.id,interaction.user.id);
                    if(joined.status==='missing')throw new ZentixBotError('Giveaway not found',ErrorTypes.VALIDATION,'This giveaway is no longer active.');
                    if(joined.status==='ended')return replyUserError(interaction,{type:ErrorTypes.UNKNOWN,message:'This giveaway has already ended.'});
                    if(joined.status==='already')return replyUserError(interaction,{type:ErrorTypes.UNKNOWN,message:'You have already entered this giveaway! 🎉'});
                    giveaway=joined.giveaway;participants=giveaway.participants;
                }else{
                    const guildGiveaways=await getGuildGiveaways(client,interaction.guildId);giveaway=guildGiveaways.find(g=>g.messageId===interaction.message.id);
                    if(!giveaway)throw new ZentixBotError('Giveaway not found in database',ErrorTypes.VALIDATION,'This giveaway is no longer active.',{messageId:interaction.message.id,guildId:interaction.guildId});
                    if(isGiveawayEnded(giveaway)||giveaway.ended||giveaway.isEnded)return replyUserError(interaction,{type:ErrorTypes.UNKNOWN,message:'This giveaway has already ended.'});
                    participants=giveaway.participants||[];if(participants.includes(interaction.user.id))return replyUserError(interaction,{type:ErrorTypes.UNKNOWN,message:'You have already entered this giveaway! 🎉'});
                    participants.push(interaction.user.id);giveaway.participants=participants;await saveGiveaway(client,interaction.guildId,giveaway);
                }

                logger.debug(`User ${interaction.user.tag} joined giveaway ${interaction.message.id}`);

                const updatedEmbed = createGiveawayEmbed(giveaway, 'active');
                const updatedRow = createGiveawayButtons(false);

                try { await interaction.message.edit({embeds:[updatedEmbed],components:[updatedRow]}); }
                catch(error){if(!isSQLiteGiveawayBackend(client))throw error;logger.warn('Giveaway entry saved but Discord message could not be refreshed:',error.message);}

                await interaction.reply({
                    embeds: [
                        successEmbed(
                            'Success! You have entered the giveaway! 🎉',
                            `Good luck! There are now ${participants.length} entry/entries.`
                        )
                    ],
                    flags: MessageFlags.Ephemeral
                });
            });
        } catch (error) {
            logger.error('Error in giveaway join handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_join',
                handler: 'giveaway'
            });
        }
    }
};

export const giveawayEndHandler = {
    customId: 'giveaway_end',
    async execute(interaction, client) {
        try {
            
            if (!interaction.inGuild()) {
                throw new ZentixBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the \'Manage Server\' permission to end a giveaway.' });
            }

            if(isPostgresGiveawayBackend(client)){const {runPostgresGiveawayInteraction}=await import('../services/postgresGiveawayRuntime.js');return await runPostgresGiveawayInteraction(interaction,client,'manual_end',interaction.message.id,interaction.channelId);}

            const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
            const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

            if (!giveaway) {
                throw new ZentixBotError(
                    'Giveaway not found in database',
                    ErrorTypes.VALIDATION,
                    'This giveaway is no longer active.',
                    { messageId: interaction.message.id, guildId: interaction.guildId }
                );
            }

            if (giveaway.ended || giveaway.isEnded || isGiveawayEnded(giveaway)) {
                throw new ZentixBotError(
                    'Giveaway already ended',
                    ErrorTypes.VALIDATION,
                    'This giveaway has already ended.',
                    { messageId: interaction.message.id }
                );
            }

            const participants = giveaway.participants || [];
            const winners = selectWinners(participants, giveaway.winnerCount);

            giveaway.ended = true;
            giveaway.isEnded = true;
            giveaway.winnerIds = winners;
            giveaway.endedAt = new Date().toISOString();
            giveaway.endedBy = interaction.user.id;
            prepareGiveawayDelivery(client,giveaway,'button_end');

            await saveGiveaway(client, interaction.guildId, giveaway);

            logger.info(`Giveaway ended via button by ${interaction.user.tag}: ${interaction.message.id}`);

            const updatedEmbed = createGiveawayEmbed(giveaway, 'ended', winners);
            const updatedRow = createGiveawayButtons(true);

            await interaction.message.edit({
                content: '🎉 **GIVEAWAY ENDED** 🎉',
                embeds: [updatedEmbed],
                components: [updatedRow]
            });
            await completeGiveawayDelivery(client,interaction.guildId,giveaway);

            try {
                await logEvent({
                    client,
                    guildId: interaction.guildId,
                    eventType: EVENT_TYPES.GIVEAWAY_WINNER,
                    data: {
                        description: `Giveaway ended with ${winners.length} winner(s)`,
                        channelId: interaction.channelId,
                        userId: interaction.user.id,
                        fields: [
                            {
                                name: '🎁 Prize',
                                value: giveaway.prize || 'Mystery Prize!',
                                inline: true
                            },
                            {
                                name: '🏆 Winners',
                                value: winners.length > 0 
                                    ? winners.map(id => `<@${id}>`).join(', ')
                                    : 'No valid entries',
                                inline: false
                            },
                            {
                                name: '👥 Total Entries',
                                value: participants.length.toString(),
                                inline: true
                            }
                        ]
                    }
                });
            } catch (logError) {
                logger.debug('Error logging giveaway end event:', logError);
            }

            await interaction.reply({
                embeds: [
                    successEmbed(
                        `Giveaway Ended ✅`,
                        `The giveaway has been ended and ${winners.length} winner(s) have been selected!`
                    )
                ],
                flags: MessageFlags.Ephemeral
            });

        } catch (error) {
            logger.error('Error in giveaway end handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_end',
                handler: 'giveaway'
            });
        }
    }
};

export const giveawayRerollHandler = {
    customId: 'giveaway_reroll',
    async execute(interaction, client) {
        try {
            
            if (!interaction.inGuild()) {
                throw new ZentixBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                return replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the \'Manage Server\' permission to reroll a giveaway.' });
            }

            if(isPostgresGiveawayBackend(client)){const {runPostgresGiveawayInteraction}=await import('../services/postgresGiveawayRuntime.js');return await runPostgresGiveawayInteraction(interaction,client,'reroll',interaction.message.id,interaction.channelId);}

            const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
            const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

            if (!giveaway) {
                throw new ZentixBotError(
                    'Giveaway not found in database',
                    ErrorTypes.VALIDATION,
                    'This giveaway is no longer active.',
                    { messageId: interaction.message.id, guildId: interaction.guildId }
                );
            }

            if (!giveaway.ended && !giveaway.isEnded) {
                throw new ZentixBotError(
                    'Giveaway still active',
                    ErrorTypes.VALIDATION,
                    'This giveaway has not ended yet. Please end it first.',
                    { messageId: interaction.message.id }
                );
            }

            const participants = giveaway.participants || [];
            
            if (participants.length === 0) {
                throw new ZentixBotError(
                    'No participants to reroll',
                    ErrorTypes.VALIDATION,
                    'There are no entries to reroll from.',
                    { messageId: interaction.message.id }
                );
            }

            const newWinners = selectWinners(participants, giveaway.winnerCount);

            giveaway.winnerIds = newWinners;
            giveaway.rerolledAt = new Date().toISOString();
            giveaway.rerolledBy = interaction.user.id;
            prepareGiveawayDelivery(client,giveaway,'button_reroll');

            await saveGiveaway(client, interaction.guildId, giveaway);

            logger.info(`Giveaway rerolled via button by ${interaction.user.tag}: ${interaction.message.id}`);

            const updatedEmbed = createGiveawayEmbed(giveaway, 'reroll', newWinners);
            const updatedRow = createGiveawayButtons(true);

            await interaction.message.edit({
                content: '🔄 **GIVEAWAY REROLLED** 🔄',
                embeds: [updatedEmbed],
                components: [updatedRow]
            });
            await completeGiveawayDelivery(client,interaction.guildId,giveaway);

            try {
                await logEvent({
                    client,
                    guildId: interaction.guildId,
                    eventType: EVENT_TYPES.GIVEAWAY_REROLL,
                    data: {
                        description: `Giveaway rerolled`,
                        channelId: interaction.channelId,
                        userId: interaction.user.id,
                        fields: [
                            {
                                name: '🎁 Prize',
                                value: giveaway.prize || 'Mystery Prize!',
                                inline: true
                            },
                            {
                                name: '🏆 New Winners',
                                value: newWinners.map(id => `<@${id}>`).join(', '),
                                inline: false
                            },
                            {
                                name: '👥 Total Entries',
                                value: participants.length.toString(),
                                inline: true
                            }
                        ]
                    }
                });
            } catch (logError) {
                logger.debug('Error logging giveaway reroll event:', logError);
            }

            await interaction.reply({
                embeds: [
                    successEmbed(
                        'Giveaway Rerolled ✅',
                        `New winner(s) have been selected!`
                    )
                ],
                flags: MessageFlags.Ephemeral
            });

        } catch (error) {
            logger.error('Error in giveaway reroll handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_reroll',
                handler: 'giveaway'
            });
        }
    }
};

export const giveawayViewHandler = {
    customId: 'giveaway_view',
    async execute(interaction, client) {
        try {
            if (!interaction.inGuild()) {
                throw new ZentixBotError(
                    'Button used outside guild',
                    ErrorTypes.VALIDATION,
                    'This button can only be used in a server.',
                    { userId: interaction.user.id }
                );
            }

            const guildGiveaways = await getGuildGiveaways(client, interaction.guildId);
            const giveaway = guildGiveaways.find(g => g.messageId === interaction.message.id);

            if (!giveaway) {
                throw new ZentixBotError(
                    'Giveaway not found in database',
                    ErrorTypes.VALIDATION,
                    'This giveaway could not be found.',
                    { messageId: interaction.message.id, guildId: interaction.guildId }
                );
            }

            if(isPostgresGiveawayBackend(client)&&(!giveaway.ended&&!giveaway.isEnded||giveaway.deliveryStatus==='pending'))return replyUserError(interaction,{type:ErrorTypes.VALIDATION,message:giveaway.deliveryStatus==='pending'?'The result delivery is pending or unknown. Please ask an administrator to inspect it.':'The giveaway has not been recorded as ended yet.'});

            if (!giveaway.ended && !giveaway.isEnded && !isGiveawayEnded(giveaway)) {
                return replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This giveaway has not ended yet, so winners are not available.' });
            }

            const winnerIds = Array.isArray(giveaway.winnerIds) ? giveaway.winnerIds : [];
            const winnerMentions = winnerIds.length > 0
                ? winnerIds.map(id => `<@${id}>`).join(', ')
                : 'No valid winners were selected for this giveaway.';

            await interaction.reply({
                embeds: [
                    successEmbed(
                        `Winners for ${giveaway.prize || 'this giveaway'} 🎉`,
                        winnerMentions
                    )
                ],
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            logger.error('Error in giveaway view handler:', error);
            await handleInteractionError(interaction, error, {
                type: 'button',
                customId: 'giveaway_view',
                handler: 'giveaway'
            });
        }
    }
};