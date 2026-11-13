import {randomInt,randomUUID} from 'node:crypto';
import {pgConfig} from '../../config/database/postgres.js';

// Experimental transaction primitives. Not wired into bot or dashboard yet:
// every writer, scheduler and Discord delivery path must first be migrated.
// These guarantees require all writers to use the same row lock. SQL, older
// instances, and the legacy full-map adapter can still overwrite these writes.
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const tokenPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,message)=>Object.assign(new Error(message),{code});
function store(client,guildId,messageId){
 if(!id(guildId)||!id(messageId)||!id(client?.homeGuildId)||client.homeGuildId!==guildId)throw fail('GIVEAWAY_SCOPE','Invalid giveaway scope');
 const db=client?.db,status=db?.getStatus?.();
 if(status?.connectionType!=='postgresql'||status.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw fail('GIVEAWAY_UNAVAILABLE','Giveaway storage unavailable');
 return db.db.pool;
}
function validRecord(row,guildId,messageId){
 const d=row?.data;
 if(!plain(d)||(Object.hasOwn(d,'ok')&&Object.hasOwn(d,'value'))||d.guildId!==guildId||d.messageId!==messageId||!id(d.channelId)||!id(d.hostId)||typeof d.prize!=='string'||!d.prize.trim()||d.prize.length>256||!Number.isInteger(d.winnerCount)||d.winnerCount<1||d.winnerCount>100||!Array.isArray(d.participants)||d.participants.length>10000||!d.participants.every(id)||new Set(d.participants).size!==d.participants.length||typeof d.ended!=='boolean'||d.ended!==d.isEnded)throw fail('GIVEAWAY_INVALID','Giveaway data requires review');
 if(!Number.isSafeInteger(d.endsAt)||d.endsAt<0||Number.isNaN(new Date(d.endsAt).getTime())||(d.endTime!==undefined&&d.endTime!==d.endsAt)||row.ends_exact!==true||typeof row.ends_ms!=='string'||!/^\d+(?:\.0+)?$/.test(row.ends_ms)||BigInt(row.ends_ms.split('.')[0])!==BigInt(d.endsAt))throw fail('GIVEAWAY_INVALID','Giveaway timestamps require review');
 if(d.winnerIds!==undefined&&(!Array.isArray(d.winnerIds)||d.winnerIds.length>d.winnerCount||!d.winnerIds.every(x=>id(x)&&d.participants.includes(x))||new Set(d.winnerIds).size!==d.winnerIds.length))throw fail('GIVEAWAY_INVALID','Giveaway winners require review');
 if(d.deliveryStatus!=null&&!['pending','delivered'].includes(d.deliveryStatus))throw fail('GIVEAWAY_INVALID','Giveaway delivery status requires review');
 if(!d.ended&&d.deliveryStatus!=null)throw fail('GIVEAWAY_INVALID','Active giveaway delivery status requires review');
 if(d.deliveryStatus==='pending'&&(!tokenPattern.test(d.deliveryToken||'')||!['manual_end','scheduled_end','reroll'].includes(d.deliveryAction)))throw fail('GIVEAWAY_INVALID','Pending delivery requires review');
 return d;
}
async function transaction(client,guildId,messageId,fn){
 const conn=await store(client,guildId,messageId).connect();let begun=false;
 try{
  await conn.query('BEGIN');begun=true;await conn.query("SET LOCAL lock_timeout = '5s'");await conn.query("SET LOCAL statement_timeout = '10s'");
  const result=await conn.query(`SELECT id,CASE WHEN octet_length(data::text)<=262144 THEN data ELSE NULL END AS data,
   CASE WHEN ends_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000)::text END AS ends_ms,
   CASE WHEN ends_at IS NULL THEN false ELSE extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000) END AS ends_exact
   FROM ${pgConfig.tables.giveaways} WHERE guild_id=$1 AND message_id=$2 FOR UPDATE`,[guildId,messageId]);
  if(result.rows.length!==1)throw fail('GIVEAWAY_MISSING','Giveaway does not exist');
  const row=result.rows[0],data=validRecord(row,guildId,messageId);
  // Read time after acquiring the lock, not before potentially waiting for it.
  const time=await conn.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms');
  const now=Number(time.rows[0]?.now_ms);
  if(!Number.isSafeInteger(now))throw fail('GIVEAWAY_INVALID','Invalid database time');
  const {patch,value}=fn(data,now);
  if(patch){const saved=await conn.query(`UPDATE ${pgConfig.tables.giveaways} SET data=data || $3::jsonb,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND message_id=$2 RETURNING id`,[guildId,messageId,JSON.stringify(patch)]);if(saved.rowCount!==1||saved.rows[0].id!==row.id)throw fail('GIVEAWAY_STALE','Giveaway changed');}
  await conn.query('COMMIT');begun=false;return value;
 }catch(error){if(begun)await conn.query('ROLLBACK').catch(()=>{});throw error}finally{conn.release()}
}
function pending(data){if(data.deliveryStatus==='pending')throw fail('GIVEAWAY_DELIVERY_PENDING','Previous delivery must be inspected and reconciled');}
function pick(participants,count){const list=[...participants],n=Math.min(count,list.length);for(let i=0;i<n;i++){const j=i+randomInt(list.length-i);[list[i],list[j]]=[list[j],list[i]];}return list.slice(0,n);}

// No Discord side effect. Concurrent joins/claims serialize on the giveaway row.
export async function joinPostgresGiveaway(client,guildId,messageId,userId){
 if(!id(userId))throw fail('GIVEAWAY_INVALID','Invalid participant');
 return transaction(client,guildId,messageId,(d,now)=>{
  if(d.ended||now>=d.endsAt)throw fail('GIVEAWAY_ENDED','Giveaway has ended');
  if(d.participants.includes(userId))return {value:{status:'already',entries:d.participants.length}};
  if(d.participants.length>=10000)throw fail('GIVEAWAY_FULL','Giveaway has reached its entry limit');
  const participants=[...d.participants,userId];return {patch:{participants},value:{status:'joined',entries:participants.length}};
 });
}

// A claim persists a unique delivery token and winner set BEFORE any external
// Discord request. A successful return is required to perform delivery.
export async function claimPostgresGiveaway(client,guildId,messageId,action,actorId){
 if(!['manual_end','scheduled_end','reroll'].includes(action)||(action==='scheduled_end'?actorId!==null:!id(actorId)))throw fail('GIVEAWAY_INVALID','Invalid claim');
 return transaction(client,guildId,messageId,(d,now)=>{
  pending(d);
  if(action==='reroll'){if(!d.ended||!Array.isArray(d.winnerIds)||d.participants.length===0)throw fail('GIVEAWAY_STATE','Cannot reroll this giveaway');}
  else {if(d.ended)throw fail('GIVEAWAY_ENDED','Giveaway has ended');if(action==='scheduled_end'&&now<d.endsAt)throw fail('GIVEAWAY_NOT_DUE','Giveaway is not due');}
  const winners=pick(d.participants,d.winnerCount),token=randomUUID(),when=new Date(now).toISOString();
  const patch={ended:true,isEnded:true,winnerIds:winners,deliveryStatus:'pending',deliveryAction:action,deliveryToken:token,...(action==='reroll'?{rerolledAt:when,rerolledBy:actorId}:{endedAt:when,endedBy:actorId})};
  return {patch,value:{token,action,winners,entries:d.participants.length}};
 });
}

// Caller may mark delivered only after all intended Discord operations are known
// to have succeeded. It must NEVER automatically repeat uncertain delivery.
export async function completePostgresGiveawayDelivery(client,guildId,messageId,token,winnerPingMessageId=null){
 if(typeof token!=='string'||!tokenPattern.test(token)||(winnerPingMessageId!==null&&!id(winnerPingMessageId)))throw fail('GIVEAWAY_INVALID','Invalid delivery acknowledgement');
 return transaction(client,guildId,messageId,d=>{
  if(d.deliveryStatus!=='pending'||d.deliveryToken!==token)throw fail('GIVEAWAY_STALE','Delivery claim changed');
  const patch={deliveryStatus:'delivered',...(winnerPingMessageId===null?{}:{winnerPingMessageId})};return {patch,value:{status:'delivered'}};
 });
}
