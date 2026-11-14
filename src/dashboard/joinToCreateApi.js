import express from 'express';
import {ChannelType} from 'discord.js';
import {pgConfig} from '../config/database/postgres.js';
import {getJoinToCreateConfigKey,getJoinToCreateChannelsKey} from '../utils/database/keys.js';
import {parseJoinToCreatePending} from '../utils/joinToCreatePending.js';
import {sqliteFor} from '../services/storage/sqliteRows.js';

const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(status,message)=>Object.assign(new Error(message),{status});
function pool(client){const db=client?.db,s=db?.getStatus?.();if(s?.connectionType!=='postgresql'||s.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw fail(503,'Database PostgreSQL tidak tersedia.');return db.db.pool;}
const defaults={enabled:false,triggerChannels:[],categoryId:null,channelNameTemplate:"{username}'s Room",userLimit:0,bitrate:64000,temporaryChannels:{},channelOptions:{}};
function validate(raw){
 if(!obj(raw)||(raw.ok!==undefined&&raw.value!==undefined))throw fail(409,'Data Join to Create perlu diperiksa.');
 const cfg={...defaults,...raw};
 if(typeof cfg.enabled!=='boolean'||!Array.isArray(cfg.triggerChannels)||cfg.triggerChannels.length>100||!cfg.triggerChannels.every(id)||new Set(cfg.triggerChannels).size!==cfg.triggerChannels.length||(cfg.categoryId!==null&&!id(cfg.categoryId))||typeof cfg.channelNameTemplate!=='string'||cfg.channelNameTemplate.length>1000||!Number.isInteger(cfg.userLimit)||cfg.userLimit<0||cfg.userLimit>99||!Number.isInteger(cfg.bitrate)||cfg.bitrate<8000||cfg.bitrate>384000||!obj(cfg.channelOptions)||!obj(cfg.temporaryChannels))throw fail(409,'Data Join to Create perlu diperiksa.');
 const channels=Object.entries(cfg.temporaryChannels);if(channels.length>5000)throw fail(409,'Daftar channel sementara terlalu besar untuk ditampilkan.');
 for(const [channelId,v] of channels)if(!id(channelId)||!obj(v)||!id(v.ownerId)||!id(v.triggerChannelId)||(v.createdAt!==undefined&&(!Number.isSafeInteger(v.createdAt)||v.createdAt<0||Number.isNaN(new Date(v.createdAt).getTime()))))throw fail(409,'Data channel sementara perlu diperiksa.');
 let pending;try{pending=parseJoinToCreatePending(raw.pendingCreates)}catch{throw fail(409,'Data operasi tertunda Join to Create perlu diperiksa.')};
 const pendingCreate=pending.length?{stage:pending[0][1].stage,channelId:pending[0][1].channelId??null}:null;
 const triggers=cfg.triggerChannels.map(channelId=>{
  const v=cfg.channelOptions[channelId]??{};if(!obj(v)||(v.nameTemplate!==undefined&&(typeof v.nameTemplate!=='string'||v.nameTemplate.length>1000))||(v.userLimit!==undefined&&(!Number.isInteger(v.userLimit)||v.userLimit<0||v.userLimit>99))||(v.bitrate!==undefined&&(!Number.isInteger(v.bitrate)||v.bitrate<8000||v.bitrate>384000))||(v.categoryId!=null&&!id(v.categoryId)))throw fail(409,'Opsi channel Join to Create perlu diperiksa.');
  return {channelId,nameTemplate:v.nameTemplate??null,userLimit:v.userLimit??null,bitrate:v.bitrate??null,categoryId:v.categoryId??null};
 });
 return {enabled:cfg.enabled,categoryId:cfg.categoryId,channelNameTemplate:cfg.channelNameTemplate,userLimit:cfg.userLimit,bitrate:cfg.bitrate,triggers,channels,pendingCreate};
}
// One SQL statement gives a consistent view of known keys at each read.
async function readSnapshot(client,guildId){
 const key=getJoinToCreateConfigKey(guildId),channelsKey=getJoinToCreateChannelsKey(guildId);
 const sqlite=sqliteFor(client,()=>fail(503,'Database tidak tersedia.'));
 if(sqlite){
  // One SQLite transaction is one consistent view as well.
  const {stored,otherData}=sqlite.transaction(tx=>({stored:tx.botGetRaw(key),otherData:tx.hasRawAIKey(key)||tx.hasRawKey(channelsKey)}));
  if(!stored)return {row:undefined,otherData};
  const serialized=JSON.stringify(stored.value),fits=Buffer.byteLength(serialized,'utf8')<=524288;
  return {row:{has_expiry:stored.expiresAt!==null,expired:stored.expiresAt!==null&&stored.expiresAt<=Date.now(),value:fits?stored.value:null,serialized:fits?serialized:null},otherData};
 }
 const result=await pool(client).query(`SELECT 'temp' AS source,key,expires_at IS NOT NULL AS has_expiry,(expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS expired,CASE WHEN key=$1 AND octet_length(value::text)<=524288 THEN value ELSE NULL END AS value,CASE WHEN key=$1 AND octet_length(value::text)<=524288 THEN value::text ELSE NULL END AS serialized FROM ${pgConfig.tables.temp_data} WHERE key=ANY($2::text[]) UNION ALL SELECT 'cache' AS source,key,expires_at IS NOT NULL AS has_expiry,(expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS expired,NULL::jsonb AS value,NULL::text AS serialized FROM ${pgConfig.tables.cache_data} WHERE key=ANY($2::text[])`,[key,[key,channelsKey]]);
 return {row:result.rows.find(r=>r.source==='temp'&&r.key===key),otherData:result.rows.some(r=>r.source==='cache'||r.key===channelsKey)};
}
async function discordFetchWithTimeout(task){
 let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),8000)})]);}finally{clearTimeout(timer)}
}
export function createJoinToCreateApi(client,{auth}){
 const router=express.Router();
 // Process-local limits; a stuck Discord request remains in-flight until it settles.
 const checks=new Set(),lastCheck=new Map();
 router.use('/join-to-create',(req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/join-to-create',auth,async(req,res)=>{try{
  if(Object.keys(req.query).some(k=>k!=='after')||(req.query.after!==undefined&&!id(req.query.after)))throw fail(400,'Parameter halaman tidak valid.');
  const {row,otherData}=await readSnapshot(client,req.guild.id);
  if(!row)return res.json({state:'missing',otherData});
  if(row.expired)return res.json({state:'expired',otherData});
  const config=validate(row.value),after=req.query.after||'',ordered=config.channels.sort(([a],[b])=>a<b?-1:a>b?1:0),filtered=ordered.filter(([channelId])=>channelId>after),page=filtered.slice(0,50);
  res.json({state:'stored',otherData,hasExpiry:row.has_expiry,enabled:config.enabled,categoryId:config.categoryId,channelNameTemplate:config.channelNameTemplate,userLimit:config.userLimit,bitrate:config.bitrate,triggers:config.triggers,totalTemporaryChannels:ordered.length,pendingCreate:config.pendingCreate,temporaryChannels:page.map(([channelId,v])=>({channelId,triggerChannelId:v.triggerChannelId,createdAt:v.createdAt??null})),next:filtered.length>50?page.at(-1)[0]:null});
 }catch(e){res.status(e.status||503).json({error:e.status?e.message:'Gagal membaca Join to Create dari database.'})}});
 // The query ID is only a comparison with the current stored ID; it is never
 // used to choose an arbitrary Discord channel. This endpoint does not mutate.
 router.get('/join-to-create/pending-check',auth,async(req,res)=>{try{
  if(Object.keys(req.query).join(',')!=='channelId'||!id(req.query.channelId))throw fail(400,'Parameter pemeriksaan tidak valid.');
  const first=await readSnapshot(client,req.guild.id),row=first.row;
  if(!row||row.expired||row.has_expiry||first.otherData)throw fail(409,'Data berubah atau perlu diperiksa; muat ulang inventaris.');
  const pending=validate(row.value).pendingCreate;
  if(pending?.stage!=='created'||pending.channelId!==req.query.channelId)throw fail(409,'Operasi tertunda berubah; muat ulang inventaris.');
  if(!client.isReady?.()||typeof req.guild.channels?.fetch!=='function')throw fail(503,'Bot belum siap memeriksa Discord.');
  const guildId=req.guild.id,now=Date.now();
  if(checks.has(guildId)||now-(lastCheck.get(guildId)||0)<2000)throw fail(429,'Pemeriksaan sedang berlangsung atau terlalu sering.');
  checks.add(guildId);lastCheck.set(guildId,now);
  // Retain the in-flight guard after timeout until the underlying Discord
  // promise settles; Promise.race does not cancel that request.
  const task=Promise.resolve().then(()=>req.guild.channels.fetch(pending.channelId,{force:true,cache:false}));
  task.then(()=>checks.delete(guildId),()=>checks.delete(guildId));
  let found;try{found=await discordFetchWithTimeout(task)}catch{throw fail(503,'Discord tidak dapat diperiksa. Ini bukan bukti channel tidak ada.')}
  const second=await readSnapshot(client,guildId);
  if(!second.row||second.row.expired||second.row.has_expiry||second.otherData||second.row.serialized!==row.serialized)throw fail(409,'Data berubah selama pemeriksaan; muat ulang inventaris.');
  const status=found&&found.id===pending.channelId&&found.guildId===guildId&&found.type===ChannelType.GuildVoice?'voice_found':'mismatch';
  res.json({channelId:pending.channelId,status});
 }catch(e){res.status(e.status||503).json({error:e.status?e.message:'Pemeriksaan tidak tersedia; periksa Discord dan database secara manual.'})}});
 return router;
}
