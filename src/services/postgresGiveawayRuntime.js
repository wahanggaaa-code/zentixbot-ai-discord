import {MessageFlags} from 'discord.js';
import {TitanBotError,ErrorTypes} from '../utils/errorHandler.js';
import {successEmbed} from '../utils/embeds.js';
import {InteractionHelper} from '../utils/interactionHelper.js';
import {createGiveawayEmbed,createGiveawayButtons} from './giveawayService.js';
import {inspectPostgresGiveaway,claimPostgresGiveaway,completePostgresGiveawayDelivery,duePostgresGiveaways} from './storage/postgresGiveawayTransactions.js';
import {logger} from '../utils/logger.js';

const error=(message)=>new TitanBotError('PostgreSQL giveaway operation failed',ErrorTypes.DATABASE,message);
// Preflight reads Discord without writing it. A locked snapshot revision is
// checked during the claim, so changing entries while preflight waits fails.
export async function deliverPostgresGiveaway(client,guildId,messageId,action,actorId,expectedChannelId=null,expectedRevision=null){
 let snapshot,channel,message,previousPing=null;
 try{
  snapshot=await inspectPostgresGiveaway(client,guildId,messageId);
  if(expectedChannelId!==null&&snapshot.channelId!==expectedChannelId)throw Error('channel mismatch');
  if(expectedRevision!==null&&snapshot.revision!==expectedRevision)throw Object.assign(Error('stale'),{code:'GIVEAWAY_STALE'});
  const guild=client.guilds.cache.get(guildId);if(!guild||guild.id!==guildId)throw Error('guild unavailable');
  channel=await guild.channels.fetch(snapshot.channelId);
  if(!channel||channel.id!==snapshot.channelId||channel.guildId!==guildId||!channel.isTextBased?.()||!channel.messages?.fetch)throw Error('channel unavailable');
  message=await channel.messages.fetch(messageId);
  if(!message||message.id!==messageId||message.author?.id!==client.user?.id)throw Error('message unavailable');
  if(action==='reroll'&&snapshot.winnerPingMessageId){
   previousPing=await channel.messages.fetch(snapshot.winnerPingMessageId);
   if(!previousPing||previousPing.id!==snapshot.winnerPingMessageId||previousPing.author?.id!==client.user?.id||typeof previousPing.edit!=='function')throw Error('winner message unavailable');
  }
 }catch(e){if(e.code==='GIVEAWAY_STALE')throw error('Giveaway state changed. Reload and inspect before retrying.');throw error('Could not verify this giveaway and its Discord message. No delivery was started; check data and Discord.')}
 let claim;
 try{claim=await claimPostgresGiveaway(client,guildId,messageId,action,actorId,snapshot.channelId,snapshot.revision)}
 catch(e){if(e.code==='GIVEAWAY_DELIVERY_PENDING')throw error('A previous delivery is pending or unknown. Inspect Discord and reconcile it before retrying.');if(['GIVEAWAY_STALE','GIVEAWAY_ENDED','GIVEAWAY_NOT_DUE','GIVEAWAY_STATE'].includes(e.code))throw error('Giveaway state changed or does not allow this action. Reload and inspect before retrying.');throw error('The claim outcome may be unknown. Inspect the database and Discord before retrying.')}
 try{
  const status=action==='reroll'?'reroll':'ended';
  const giveaway={...claim,participants:{length:claim.entries}};
  const embed=createGiveawayEmbed(giveaway,status,claim.winners);
  await message.edit({content:action==='reroll'?'🔄 **GIVEAWAY REROLLED** 🔄':'🎉 **GIVEAWAY ENDED** 🎉',embeds:[embed],components:[createGiveawayButtons(true)],allowedMentions:{parse:[]}});
  const mention=claim.winners.length?claim.winners.map(x=>`<@${x}>`).join(', '):'No valid entries';
  const payload={content:action==='reroll'?`🔄 New winner(s): ${mention}. Prize: **${claim.prize}**.`:`🎉 Giveaway ended! Winner(s): ${mention}. Prize: **${claim.prize}**.`,allowedMentions:{parse:[],users:claim.winners}};
  const announcement=previousPing?await previousPing.edit(payload):await channel.send(payload);
  const announcementId=previousPing?.id??announcement?.id;
  if(!/^\d{17,20}$/.test(announcementId||''))throw Error('Discord announcement identity unavailable');
  await completePostgresGiveawayDelivery(client,guildId,messageId,claim.token,announcementId);
 }catch(e){throw error('The result was saved, but Discord delivery or its final status is pending or unknown. Inspect Discord and the database; do not repeat automatically.')}
 return {winners:claim.winners.length,entries:claim.entries};
}
export async function runPostgresGiveawayInteraction(interaction,client,action,messageId,expectedChannelId=null){
 if(!await InteractionHelper.safeDefer(interaction,{flags:MessageFlags.Ephemeral}))throw error('Could not acknowledge the Discord interaction. No action was started.');
 const result=await deliverPostgresGiveaway(client,interaction.guildId,messageId,action,interaction.user.id,expectedChannelId);
 return InteractionHelper.safeReply(interaction,{embeds:[successEmbed('Giveaway updated',`Result delivered: ${result.winners} winner(s) from ${result.entries} stored entries.`)],flags:MessageFlags.Ephemeral});
}
export async function checkPostgresGiveaways(client){
 const guildId=client.homeGuildId;const ids=await duePostgresGiveaways(client,guildId);
 for(const messageId of ids){try{await deliverPostgresGiveaway(client,guildId,messageId,'scheduled_end',null)}catch(e){logger.warn(`Could not process giveaway ${messageId}; inspect state before retrying: ${e.userMessage||e.message}`)}}
}
