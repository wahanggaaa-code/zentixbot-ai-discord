import {createHash,randomInt,randomUUID} from 'node:crypto';
import {pgConfig} from '../../config/database/postgres.js';

// Participating writes serialize on a giveaway row. Old bot versions and SQL
// outside this protocol can still overwrite these writes; stop old instances.
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const tokenPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const revision=row=>createHash('sha256').update(`${row.id}:`+row.serialized).digest('hex');
export const isPostgresGiveawayBackend=client=>client?.db?.getStatus?.()?.connectionType==='postgresql';
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
 if(d.winnerPingMessageId!=null&&(!id(d.winnerPingMessageId)||!d.ended||d.winnerPingMessageId===messageId))throw fail('GIVEAWAY_INVALID','Winner message identity requires review');
 if(d.deliveryStatus!=null&&!['pending','delivered'].includes(d.deliveryStatus))throw fail('GIVEAWAY_INVALID','Giveaway delivery status requires review');
 if(!d.ended&&d.deliveryStatus!=null)throw fail('GIVEAWAY_INVALID','Active giveaway delivery status requires review');
 if(d.deliveryStatus==='pending'&&(!tokenPattern.test(d.deliveryToken||'')||!['manual_end','scheduled_end','reroll'].includes(d.deliveryAction)))throw fail('GIVEAWAY_INVALID','Pending delivery requires review');
 if(d.deliveryClaimedAt!==undefined&&(!Number.isSafeInteger(d.deliveryClaimedAt)||d.deliveryClaimedAt<0))throw fail('GIVEAWAY_INVALID','Delivery claim time requires review');
 if(d.deletion!==undefined&&(!plain(d.deletion)||!tokenPattern.test(d.deletion.token||'')||!id(d.deletion.by)||typeof d.deletion.at!=='string'))throw fail('GIVEAWAY_INVALID','Deletion marker requires review');
 return d;
}
async function assertNoLegacy(conn,guildId){
 const key=`guild:${guildId}:giveaways`;
 const result=await conn.query(`SELECT 1 FROM ${pgConfig.tables.temp_data} WHERE key=$1 UNION ALL SELECT 1 FROM ${pgConfig.tables.cache_data} WHERE key=$1 LIMIT 1`,[key]);
 if(result.rows.length)throw fail('GIVEAWAY_LEGACY','Legacy giveaway data requires review');
}
export async function assertPostgresGiveawayReady(client,guildId){
 const conn=await store(client,guildId,'10000000000000000').connect();try{await assertNoLegacy(conn,guildId)}finally{conn.release()}
}
async function transaction(client,guildId,messageId,fn){
 const conn=await store(client,guildId,messageId).connect();let begun=false;
 try{
  await conn.query('BEGIN');begun=true;await conn.query("SET LOCAL lock_timeout = '5s'");await conn.query("SET LOCAL statement_timeout = '10s'");
  await assertNoLegacy(conn,guildId);
  const result=await conn.query(`SELECT id,CASE WHEN octet_length(data::text)<=262144 THEN data ELSE NULL END AS data,CASE WHEN octet_length(data::text)<=262144 THEN data::text ELSE NULL END AS serialized,
   CASE WHEN ends_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000)::text END AS ends_ms,
   CASE WHEN ends_at IS NULL THEN false ELSE extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000) END AS ends_exact
   FROM ${pgConfig.tables.giveaways} WHERE guild_id=$1 AND message_id=$2 FOR UPDATE`,[guildId,messageId]);
  if(result.rows.length!==1)throw fail('GIVEAWAY_MISSING','Giveaway does not exist');
  const row=result.rows[0],data=validRecord(row,guildId,messageId);
  // Read time after acquiring the lock, not before potentially waiting for it.
  const time=await conn.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms');
  const now=Number(time.rows[0]?.now_ms);
  if(!Number.isSafeInteger(now))throw fail('GIVEAWAY_INVALID','Invalid database time');
  const {patch,value,remove,unset}=fn(data,now,row);
  if(remove){const gone=await conn.query(`DELETE FROM ${pgConfig.tables.giveaways} WHERE guild_id=$1 AND message_id=$2 RETURNING id`,[guildId,messageId]);if(gone.rowCount!==1||gone.rows[0].id!==row.id)throw fail('GIVEAWAY_STALE','Giveaway changed');}
  else if(unset){const saved=await conn.query(`UPDATE ${pgConfig.tables.giveaways} SET data=data - $3::text,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND message_id=$2 RETURNING id`,[guildId,messageId,unset]);if(saved.rowCount!==1||saved.rows[0].id!==row.id)throw fail('GIVEAWAY_STALE','Giveaway changed');}
  else if(patch){const saved=await conn.query(`UPDATE ${pgConfig.tables.giveaways} SET data=data || $3::jsonb,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND message_id=$2 RETURNING id`,[guildId,messageId,JSON.stringify(patch)]);if(saved.rowCount!==1||saved.rows[0].id!==row.id)throw fail('GIVEAWAY_STALE','Giveaway changed');}
  await conn.query('COMMIT');begun=false;return value;
 }catch(error){if(begun)await conn.query('ROLLBACK').catch(()=>{});throw error}finally{conn.release()}
}
function pending(data){if(data.deliveryStatus==='pending')throw fail('GIVEAWAY_DELIVERY_PENDING','Previous delivery must be inspected and reconciled');}
// A deletion in progress freezes the giveaway: no entries, draws or delivery updates.
function deleting(data){if(data.deletion!==undefined)throw fail('GIVEAWAY_DELETING','Giveaway is being deleted');}
function pick(participants,count){const list=[...participants],n=Math.min(count,list.length);for(let i=0;i<n;i++){const j=i+randomInt(list.length-i);[list[i],list[j]]=[list[j],list[i]];}return list.slice(0,n);}

// No Discord side effect. Concurrent joins/claims serialize on the giveaway row.
export async function joinPostgresGiveaway(client,guildId,messageId,userId){
 if(!id(userId))throw fail('GIVEAWAY_INVALID','Invalid participant');
 return transaction(client,guildId,messageId,(d,now)=>{
  deleting(d);
  if(d.ended||now>=d.endsAt)throw fail('GIVEAWAY_ENDED','Giveaway has ended');
  if(d.participants.includes(userId))return {value:{status:'already',entries:d.participants.length}};
  if(d.participants.length>=10000)throw fail('GIVEAWAY_FULL','Giveaway has reached its entry limit');
  const participants=[...d.participants,userId];return {patch:{participants},value:{status:'joined',entries:participants.length}};
 });
}

// A claim persists a unique delivery token and winner set BEFORE any external
// Discord request. A successful return is required to perform delivery.
export async function claimPostgresGiveaway(client,guildId,messageId,action,actorId,expectedChannelId=null,expectedRevision=null){
 if(!['manual_end','scheduled_end','reroll'].includes(action)||(action==='scheduled_end'?actorId!==null:!id(actorId))||(expectedChannelId!==null&&!id(expectedChannelId))||(expectedRevision!==null&&!/^[0-9a-f]{64}$/.test(expectedRevision)))throw fail('GIVEAWAY_INVALID','Invalid claim');
 return transaction(client,guildId,messageId,(d,now,row)=>{
  deleting(d);pending(d);
  if(expectedRevision!==null&&revision(row)!==expectedRevision)throw fail('GIVEAWAY_STALE','Giveaway changed; inspect again');
  if(expectedChannelId!==null&&d.channelId!==expectedChannelId)throw fail('GIVEAWAY_STALE','Giveaway channel changed');
  if(action==='reroll'){if(!d.ended||d.deliveryStatus!=='delivered'||!Array.isArray(d.winnerIds)||d.participants.length===0)throw fail('GIVEAWAY_STATE','Cannot reroll this giveaway');}
  else {if(d.ended)throw fail('GIVEAWAY_ENDED','Giveaway has ended');if(action==='scheduled_end'&&now<d.endsAt)throw fail('GIVEAWAY_NOT_DUE','Giveaway is not due');}
  const winners=pick(d.participants,d.winnerCount),token=randomUUID(),when=new Date(now).toISOString();
  const patch={ended:true,isEnded:true,winnerIds:winners,deliveryStatus:'pending',deliveryAction:action,deliveryToken:token,deliveryClaimedAt:now,...(action==='reroll'?{rerolledAt:when,rerolledBy:actorId}:{endedAt:when,endedBy:actorId})};
  return {patch,value:{token,action,winners,entries:d.participants.length,prize:d.prize,channelId:d.channelId,hostId:d.hostId,winnerCount:d.winnerCount,winnerPingMessageId:id(d.winnerPingMessageId)?d.winnerPingMessageId:null}};
 });
}

// Caller may mark delivered only after all intended Discord operations are known
// to have succeeded. It must NEVER automatically repeat uncertain delivery.
export async function completePostgresGiveawayDelivery(client,guildId,messageId,token,winnerPingMessageId=null){
 if(typeof token!=='string'||!tokenPattern.test(token)||(winnerPingMessageId!==null&&(!id(winnerPingMessageId)||winnerPingMessageId===messageId)))throw fail('GIVEAWAY_INVALID','Invalid delivery acknowledgement');
 return transaction(client,guildId,messageId,d=>{
  deleting(d);
  if(d.deliveryStatus!=='pending'||d.deliveryToken!==token)throw fail('GIVEAWAY_STALE','Delivery claim changed');
  const patch={deliveryStatus:'delivered',...(winnerPingMessageId===null?{}:{winnerPingMessageId})};return {patch,value:{status:'delivered'}};
 });
}

// New-record insert only; never replace an existing row. The Discord message is
// created first to obtain its ID, so any failure/unknown commit requires review.
export async function createPostgresGiveaway(client,guildId,input){
 if(!plain(input))throw fail('GIVEAWAY_INVALID','Invalid giveaway');
 const serialized=JSON.stringify(input);if(!serialized||Buffer.byteLength(serialized)>262144)throw fail('GIVEAWAY_INVALID','Invalid giveaway');
 const data=JSON.parse(serialized),messageId=data.messageId,pool=store(client,guildId,messageId);
 validRecord({data,ends_ms:String(data.endsAt),ends_exact:true},guildId,messageId);
 if(data.ended||data.deliveryStatus!=null||data.participants.length||data.winnerIds!==undefined)throw fail('GIVEAWAY_INVALID','New giveaway data invalid');
 const conn=await pool.connect();let begun=false;try{
  await conn.query('BEGIN');begun=true;await conn.query("SET LOCAL lock_timeout = '5s'");await conn.query("SET LOCAL statement_timeout = '10s'");
  await assertNoLegacy(conn,guildId);
  await conn.query(`INSERT INTO ${pgConfig.tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`,[guildId]);
  const saved=await conn.query(`INSERT INTO ${pgConfig.tables.giveaways}(guild_id,message_id,data,ends_at) VALUES($1,$2,$3::jsonb,to_timestamp($4::double precision/1000) AT TIME ZONE 'UTC') ON CONFLICT(guild_id,message_id) DO NOTHING RETURNING id`,[guildId,messageId,serialized,data.endsAt]);
  if(saved.rowCount!==1)throw fail('GIVEAWAY_EXISTS','Giveaway already exists');await conn.query('COMMIT');begun=false;return true;
 }catch(e){if(begun)await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release()}
}

// A bounded read of a single validated record, for Discord preflight only.
export async function inspectPostgresGiveaway(client,guildId,messageId){
 return transaction(client,guildId,messageId,(d,now,row)=>({value:{channelId:d.channelId,deliveryStatus:d.deliveryStatus??null,ended:d.ended,entries:d.participants.length,prize:d.prize,hasWinners:Array.isArray(d.winnerIds),winnerPingMessageId:d.winnerPingMessageId??null,revision:revision(row),deleting:d.deletion!==undefined,pendingSettled:d.deliveryStatus==='pending'&&settled(d,now)}}));
}
export async function duePostgresGiveaways(client,guildId){
 const pool=store(client,guildId,'10000000000000000');
 const result=await pool.query(`SELECT message_id FROM ${pgConfig.tables.giveaways} WHERE guild_id=$1 AND ends_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND data->>'ended'='false' AND data->>'isEnded'='false' AND NOT (data ? 'deletion') ORDER BY ends_at,message_id LIMIT 1000`,[guildId]);
 return result.rows.map(r=>r.message_id).filter(id);
}

// ---------------------------------------------------------------------------
// Deletion and recovery of an unfinished delivery.
//
// Deletion is two database steps around one Discord step:
//   begin  -> the record is marked; joins, draws and the scheduler now refuse it
//   (the caller deletes the Discord message)
//   finish -> the row is removed, only with the token that marked it
// If the process stops in between, the mark stays and the deletion can be
// continued later with the same result.
// ---------------------------------------------------------------------------

/**
 * A delivery that was claimed this recently may still be running in this or
 * another process. Recovery and deletion wait until it can no longer be.
 */
export const GIVEAWAY_PENDING_SETTLE_MS = 120_000;

function pendingSince(data) {
    if (Number.isSafeInteger(data.deliveryClaimedAt)) return data.deliveryClaimedAt;
    // Records claimed before deliveryClaimedAt existed carry only these.
    const text = data.deliveryAction === 'reroll' ? data.rerolledAt : data.endedAt;
    const parsed = typeof text === 'string' ? Date.parse(text) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
}

function settled(data, now) {
    const since = pendingSince(data);
    return since === null || now - since >= GIVEAWAY_PENDING_SETTLE_MS;
}

function requireSettledPending(data, now) {
    if (data.deliveryStatus !== 'pending') throw fail('GIVEAWAY_STATE', 'No delivery is pending');
    if (!settled(data, now)) throw fail('GIVEAWAY_IN_PROGRESS', 'Delivery may still be in progress');
}

const validActor = (actorId) => id(actorId);
const validRevision = (value) => value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value));

function requireRevision(row, expectedRevision) {
    if (expectedRevision !== null && revision(row) !== expectedRevision) {
        throw fail('GIVEAWAY_STALE', 'Giveaway changed; inspect again');
    }
}

/**
 * Mark a giveaway for deletion. Calling it again on a marked record returns
 * the existing token, so an interrupted deletion can be continued.
 */
export async function beginPostgresGiveawayDeletion(client, guildId, messageId, actorId, expectedRevision = null) {
    if (!validActor(actorId) || !validRevision(expectedRevision)) throw fail('GIVEAWAY_INVALID', 'Invalid deletion');
    return transaction(client, guildId, messageId, (d, now, row) => {
        requireRevision(row, expectedRevision);
        const value = {
            channelId: d.channelId,
            prize: d.prize,
            entries: d.participants.length,
            ended: d.ended,
            winners: Array.isArray(d.winnerIds) ? d.winnerIds.length : 0,
        };
        if (d.deletion !== undefined) return { value: { ...value, token: d.deletion.token, resumed: true } };
        if (d.deliveryStatus === 'pending' && !settled(d, now)) {
            throw fail('GIVEAWAY_IN_PROGRESS', 'Delivery may still be in progress');
        }
        const token = randomUUID();
        const deletion = { token, by: actorId, at: new Date(now).toISOString() };
        return { patch: { deletion }, value: { ...value, token, resumed: false } };
    });
}

/** Remove a marked record. The token proves this caller holds the mark. */
export async function finishPostgresGiveawayDeletion(client, guildId, messageId, token) {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw fail('GIVEAWAY_INVALID', 'Invalid deletion token');
    return transaction(client, guildId, messageId, (d) => {
        if (d.deletion === undefined || d.deletion.token !== token) throw fail('GIVEAWAY_STALE', 'Deletion mark changed');
        return { remove: true, value: { status: 'deleted' } };
    });
}

/** Take the mark off again; the giveaway returns to the state it was in. */
export async function cancelPostgresGiveawayDeletion(client, guildId, messageId, token) {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw fail('GIVEAWAY_INVALID', 'Invalid deletion token');
    return transaction(client, guildId, messageId, (d) => {
        if (d.deletion === undefined || d.deletion.token !== token) throw fail('GIVEAWAY_STALE', 'Deletion mark changed');
        return { unset: 'deletion', value: { status: 'restored' } };
    });
}

/**
 * An administrator has looked at Discord and states that the saved result was
 * announced. No Discord request is made. The winners are not changed.
 */
export async function markPostgresGiveawayDelivered(client, guildId, messageId, actorId, expectedRevision = null) {
    if (!validActor(actorId) || !validRevision(expectedRevision)) throw fail('GIVEAWAY_INVALID', 'Invalid resolution');
    return transaction(client, guildId, messageId, (d, now, row) => {
        deleting(d);
        requireRevision(row, expectedRevision);
        requireSettledPending(d, now);
        const patch = {
            deliveryStatus: 'delivered',
            deliveryResolvedBy: actorId,
            deliveryResolvedAt: new Date(now).toISOString(),
        };
        return { patch, value: { status: 'delivered', winners: (d.winnerIds ?? []).length, entries: d.participants.length } };
    });
}

/**
 * Start a second delivery of the SAME saved winners. No new draw. The old
 * token stops working, so a delivery still running elsewhere cannot also be
 * recorded as complete.
 */
export async function retryPostgresGiveawayDelivery(client, guildId, messageId, actorId, expectedChannelId = null, expectedRevision = null) {
    if (!validActor(actorId) || !validRevision(expectedRevision) || (expectedChannelId !== null && !id(expectedChannelId))) {
        throw fail('GIVEAWAY_INVALID', 'Invalid retry');
    }
    return transaction(client, guildId, messageId, (d, now, row) => {
        deleting(d);
        requireRevision(row, expectedRevision);
        if (expectedChannelId !== null && d.channelId !== expectedChannelId) throw fail('GIVEAWAY_STALE', 'Giveaway channel changed');
        requireSettledPending(d, now);
        if (!Array.isArray(d.winnerIds)) throw fail('GIVEAWAY_INVALID', 'Saved winners require review');
        const token = randomUUID();
        const patch = {
            deliveryToken: token,
            deliveryClaimedAt: now,
            deliveryRetriedBy: actorId,
            deliveryRetriedAt: new Date(now).toISOString(),
        };
        return {
            patch,
            value: {
                token,
                action: d.deliveryAction,
                winners: [...d.winnerIds],
                entries: d.participants.length,
                prize: d.prize,
                channelId: d.channelId,
                hostId: d.hostId,
                winnerCount: d.winnerCount,
                winnerPingMessageId: id(d.winnerPingMessageId) ? d.winnerPingMessageId : null,
            },
        };
    });
}
