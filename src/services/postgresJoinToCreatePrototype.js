import {reserveJoinToCreatePrototype,recordJoinToCreateCreatedPrototype,completeJoinToCreatePrototype} from './storage/postgresJoinToCreateTransactions.js';

// Experimental orchestration, not wired into Discord or the dashboard.
// createChannel is an injected adapter; callers must preflight guild/channel,
// voice state, permissions and the parameters represented by the revision.
// No move, delete, retry, cancellation, reconciliation, or logging occurs here.
const failure=(code,message)=>Object.assign(new Error(message),{code});
export async function createJoinToCreatePrototype({client,guildId,ownerId,triggerId,revision,createChannel}){
 if(typeof createChannel!=='function')throw failure('JTC_INVALID','Create adapter required');
 let reservation;
 try{reservation=await reserveJoinToCreatePrototype(client,guildId,ownerId,triggerId,revision)}
 catch{throw failure('JTC_RESERVATION_FAILED','Reservation failed or its outcome is unknown; inspect storage before retrying.')}
 let channelId;
 try{
  const channel=await createChannel(Object.freeze({guildId,ownerId,triggerId}));
  channelId=channel?.id;const actualGuildId=channel?.guildId;
  if(typeof channelId!=='string'||!/^\d{17,20}$/.test(channelId)||actualGuildId!==guildId)throw new Error('Invalid adapter response');
  await recordJoinToCreateCreatedPrototype(client,guildId,ownerId,triggerId,reservation.token,channelId);
  await completeJoinToCreatePrototype(client,guildId,ownerId,triggerId,reservation.token,channelId);
 }catch{throw failure('JTC_CREATE_UNCERTAIN','Channel creation or registration may have succeeded; inspect Discord and storage before any retry.')}
 return {channelId};
}
