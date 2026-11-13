import {createHash} from 'node:crypto';
import {pgConfig} from '../../config/database/postgres.js';
import {getJoinToCreateConfigKey,getJoinToCreateChannelsKey} from '../../utils/database/keys.js';

// PROTOTYPE ONLY: no bot/dashboard writer uses this yet. All participating
// writers MUST use the same advisory lock. Older instances and SQL bypass it.
// Never repeat a failed COMMIT automatically: its outcome can be unknown.
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const invalid=()=>fail('JTC_INVALID','Join to Create data requires review');
const rev=s=>createHash('sha256').update(s).digest('hex');
const limit=512*1024;
const defaults=()=>({enabled:false,triggerChannels:[],categoryId:null,channelNameTemplate:"{username}'s Room",userLimit:0,bitrate:64000,temporaryChannels:{},channelOptions:{}});
function pool(client,guildId){
 if(!id(guildId)||!id(client?.homeGuildId)||client.homeGuildId!==guildId)throw fail('JTC_SCOPE','Invalid guild scope');
 const db=client?.db,s=db?.getStatus?.();
 if(s?.connectionType!=='postgresql'||s.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw fail('JTC_UNAVAILABLE','PostgreSQL unavailable');
 return db.db.pool;
}
function validate(data){
 if(!plain(data)||(Object.hasOwn(data,'ok')&&Object.hasOwn(data,'value')))throw invalid();
 const d={...defaults(),...data};
 if(typeof d.enabled!=='boolean'||!Array.isArray(d.triggerChannels)||d.triggerChannels.length>100||!d.triggerChannels.every(id)||new Set(d.triggerChannels).size!==d.triggerChannels.length||(d.categoryId!==null&&!id(d.categoryId))||typeof d.channelNameTemplate!=='string'||d.channelNameTemplate.length>1000||!Number.isInteger(d.userLimit)||d.userLimit<0||d.userLimit>99||!Number.isInteger(d.bitrate)||d.bitrate<8000||d.bitrate>384000||!plain(d.channelOptions)||!plain(d.temporaryChannels))throw invalid();
 const opts=Object.entries(d.channelOptions),temps=Object.entries(d.temporaryChannels);
 if(opts.length>100||temps.length>5000)throw invalid();
 for(const [key,v] of opts){if(!id(key)||!plain(v)||(v.nameTemplate!==undefined&&(typeof v.nameTemplate!=='string'||v.nameTemplate.length>1000))||(v.userLimit!==undefined&&(!Number.isInteger(v.userLimit)||v.userLimit<0||v.userLimit>99))||(v.bitrate!==undefined&&(!Number.isInteger(v.bitrate)||v.bitrate<8000||v.bitrate>384000))||(v.categoryId!=null&&!id(v.categoryId)))throw invalid();}
 for(const [key,v] of temps){if(!id(key)||!plain(v)||!id(v.ownerId)||!id(v.triggerChannelId)||(v.createdAt!==undefined&&(!Number.isSafeInteger(v.createdAt)||v.createdAt<0||Number.isNaN(new Date(v.createdAt).getTime()))))throw invalid();}
 return d;
}
function requireId(...ids){if(!ids.every(id))throw invalid();}
function requireRevision(value){if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw invalid();}
function validatePatch(patch){
 if(!plain(patch)||!Object.keys(patch).length||Object.keys(patch).some(k=>!['nameTemplate','userLimit','bitrate'].includes(k)))throw invalid();
 if(Object.hasOwn(patch,'nameTemplate')&&(typeof patch.nameTemplate!=='string'||!patch.nameTemplate.trim()||patch.nameTemplate.length>100||/[\x00-\x1f\x7f]/.test(patch.nameTemplate)))throw invalid();
 if(Object.hasOwn(patch,'userLimit')&&(!Number.isInteger(patch.userLimit)||patch.userLimit<0||patch.userLimit>99))throw invalid();
 if(Object.hasOwn(patch,'bitrate')&&(!Number.isInteger(patch.bitrate)||patch.bitrate<8000||patch.bitrate>384000))throw invalid();
}
async function transaction(client,guildId,fn){
 const key=getJoinToCreateConfigKey(guildId),other=getJoinToCreateChannelsKey(guildId),conn=await pool(client,guildId).connect();let begun=false;
 try{
  await conn.query('BEGIN');begun=true;await conn.query("SET LOCAL lock_timeout = '5s'");await conn.query("SET LOCAL statement_timeout = '10s'");
  // Stable namespace per canonical key, including when the record is absent.
  await conn.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',['zentix:jtc:'+key]);
  const otherData=await conn.query(`SELECT 1 FROM ${pgConfig.tables.cache_data} WHERE key=ANY($1::text[]) UNION ALL SELECT 1 FROM ${pgConfig.tables.temp_data} WHERE key=$2 LIMIT 1`,[[key,other],other]);
  if(otherData.rows.length)throw fail('JTC_LEGACY','Conflicting Join to Create data requires review');
  const result=await conn.query(`SELECT CASE WHEN octet_length(value::text)<=$2 THEN value ELSE NULL END AS value,CASE WHEN octet_length(value::text)<=$2 THEN value::text ELSE NULL END AS serialized,expires_at IS NOT NULL AS has_expiry FROM ${pgConfig.tables.temp_data} WHERE key=$1 FOR UPDATE`,[key,limit]);
  const row=result.rows[0];if(row?.has_expiry)throw fail('JTC_EXPIRY','Expiring Join to Create record requires review');
  const data=row?validate(row.value):defaults(),revision=rev(row?'stored:'+row.serialized:'missing');
  const resultValue=fn(data,{exists:!!row,revision});
  if(resultValue.write){
   const text=JSON.stringify(data);if(Buffer.byteLength(text,'utf8')>limit)throw invalid();validate(data);
   // PostgreSQL's canonical jsonb text can be larger than JSON.stringify.
   const size=await conn.query('SELECT octet_length($1::jsonb::text) AS bytes',[text]);if(size.rows[0].bytes>limit)throw invalid();
   if(row){const updated=await conn.query(`UPDATE ${pgConfig.tables.temp_data} SET value=$2::jsonb WHERE key=$1 AND expires_at IS NULL RETURNING key`,[key,text]);if(updated.rowCount!==1)throw fail('JTC_STALE','Record changed');}
   else await conn.query(`INSERT INTO ${pgConfig.tables.temp_data} (key,value,expires_at) VALUES ($1,$2::jsonb,NULL)`,[key,text]);
  }
  await conn.query('COMMIT');begun=false;return resultValue.value;
 }catch(error){if(begun)await conn.query('ROLLBACK').catch(()=>{});throw error}finally{conn.release()}
}
// Inspection exposes no owners or arbitrary JSON. Revision is content-based,
// not a monotonic version; A→B→A is not detected.
export async function inspectJoinToCreatePrototype(client,guildId){return transaction(client,guildId,(d,{exists,revision})=>({value:{exists,revision,enabled:d.enabled,triggerChannels:[...d.triggerChannels],temporaryCount:Object.keys(d.temporaryChannels).length}}));}
export async function setupJoinToCreatePrototype(client,guildId,triggerId,options){
 requireId(triggerId);validatePatch(options);options={...options};
 return transaction(client,guildId,d=>{
  if(d.triggerChannels.length||d.enabled||Object.hasOwn(d.channelOptions,triggerId))throw fail('JTC_CONFLICT','Trigger or retained options already configured');
  d.triggerChannels.push(triggerId);d.enabled=true;d.channelOptions[triggerId]={...options};
  return {write:true,value:true};
 });
}
export async function updateJoinToCreatePrototype(client,guildId,triggerId,patch,revision){
 requireId(triggerId);validatePatch(patch);requireRevision(revision);patch={...patch};
 return transaction(client,guildId,(d,state)=>{
  if(state.revision!==revision)throw fail('JTC_STALE','Configuration changed');
  if(!d.triggerChannels.includes(triggerId))throw fail('JTC_MISSING','Trigger missing');
  d.channelOptions[triggerId]={...(d.channelOptions[triggerId]||{}),...patch};return {write:true,value:true};
 });
}
export async function removeJoinToCreateTriggerPrototype(client,guildId,triggerId,revision){
 requireId(triggerId);requireRevision(revision);
 return transaction(client,guildId,(d,state)=>{
  if(state.revision!==revision)throw fail('JTC_STALE','Configuration changed');
  if(!d.triggerChannels.includes(triggerId))throw fail('JTC_MISSING','Trigger missing');
  d.triggerChannels=d.triggerChannels.filter(x=>x!==triggerId);d.enabled=d.triggerChannels.length>0;delete d.channelOptions[triggerId];
  // Do not discard temporary-channel records: Discord channels may still exist.
  return {write:true,value:true};
 });
}
export async function registerJoinToCreateChannelPrototype(client,guildId,channelId,ownerId,triggerId,createdAt){
 requireId(channelId,ownerId,triggerId);if(!Number.isSafeInteger(createdAt)||createdAt<0||Number.isNaN(new Date(createdAt).getTime()))throw invalid();
 return transaction(client,guildId,d=>{
  if(!d.enabled||!d.triggerChannels.includes(triggerId))throw fail('JTC_STALE','Trigger no longer active');
  if(Object.hasOwn(d.temporaryChannels,channelId)||Object.values(d.temporaryChannels).some(v=>v.ownerId===ownerId))throw fail('JTC_CONFLICT','Channel or owner already registered');
  d.temporaryChannels[channelId]={ownerId,triggerChannelId:triggerId,createdAt};return {write:true,value:true};
 });
}
export async function transferJoinToCreateOwnerPrototype(client,guildId,channelId,expectedOwner,newOwner){
 requireId(channelId,expectedOwner,newOwner);
 return transaction(client,guildId,d=>{
  const info=d.temporaryChannels[channelId];if(!info||info.ownerId!==expectedOwner)throw fail('JTC_STALE','Channel owner changed');
  if(Object.entries(d.temporaryChannels).some(([k,v])=>k!==channelId&&v.ownerId===newOwner))throw fail('JTC_CONFLICT','Owner already registered');
  info.ownerId=newOwner;return {write:true,value:true};
 });
}
export async function unregisterJoinToCreateChannelPrototype(client,guildId,channelId,expectedOwner,expectedTrigger){
 requireId(channelId,expectedOwner,expectedTrigger);
 return transaction(client,guildId,d=>{
  const info=d.temporaryChannels[channelId];if(!info||info.ownerId!==expectedOwner||info.triggerChannelId!==expectedTrigger)throw fail('JTC_STALE','Channel record changed');
  delete d.temporaryChannels[channelId];return {write:true,value:true};
 });
}
