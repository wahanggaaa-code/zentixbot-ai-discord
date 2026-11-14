import express from 'express';
import {pgConfig} from '../config/database/postgres.js';
import {inspectPostgresGiveaway,markPostgresGiveawayDelivered,GIVEAWAY_PENDING_SETTLE_MS,listSQLiteGiveawayRows} from '../services/storage/postgresGiveawayTransactions.js';
import {deliverPostgresGiveaway} from '../services/postgresGiveawayRuntime.js';
import {canPostGiveaway,createPostgresGiveawayFromDashboard,deletePostgresGiveaway,redeliverPostgresGiveaway} from '../services/postgresGiveawayManagement.js';
import {parseDuration,validatePrize,validateWinnerCount} from '../services/giveawayService.js';
import {logEvent,EVENT_TYPES} from '../services/loggingService.js';
import {botConfig} from '../config/bot.js';

const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const failure=(status,message)=>Object.assign(new Error(message),{status});
function pool(client){
 const db=client?.db,status=db?.getStatus?.();
 if(status?.connectionType!=='postgresql'||status.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw failure(503,'Database PostgreSQL tidak tersedia.');
 return db.db.pool;
}
function timestamp(value){
 if(value===undefined||value===null)return null;
 const n=typeof value==='number'?value:typeof value==='string'&&/^\d{1,16}$/.test(value)?Number(value):NaN;
 return Number.isSafeInteger(n)&&n>=0&&!Number.isNaN(new Date(n).getTime())?n:null;
}
// This is an inventory, not a verdict that a giveaway is operational. Never
// return participant IDs or arbitrary stored JSON to the browser.
function summarize(row,guildId){
 const d=row.data;const warnings=[];
 if(!object(d)||(Object.hasOwn(d,'ok')&&Object.hasOwn(d,'value')))return {messageId:row.message_id,review:true,warnings:['Data terlalu besar atau tidak valid; perlu diperiksa.']};
 if(d.messageId!==row.message_id||(d.guildId!=null&&d.guildId!==guildId))warnings.push('Identitas tersimpan tidak cocok.');
 const channelId=id(d.channelId)?d.channelId:null,hostId=id(d.hostId)?d.hostId:null;
 if(!channelId||!hostId)warnings.push('ID channel atau host tidak valid.');
 const prize=typeof d.prize==='string'&&d.prize.trim()&&d.prize.length<=256?d.prize:null;
 if(!prize)warnings.push('Hadiah tidak valid.');
 const flags=[d.ended,d.isEnded];
 const validFlags=flags.every(x=>x===undefined||typeof x==='boolean')&&flags.some(x=>typeof x==='boolean');
 const disagree=flags.every(x=>typeof x==='boolean')&&flags[0]!==flags[1];
 if(!validFlags||disagree)warnings.push('Status selesai tidak konsisten atau tidak tersedia.');
 const status=!validFlags||disagree?'review':flags.some(x=>x===true)?'ended':'active';
 const a=timestamp(d.endsAt),b=timestamp(d.endTime),endAt=a??b;
 if((d.endsAt!=null&&a===null)||(d.endTime!=null&&b===null)||(a!==null&&b!==null&&a!==b)||endAt===null)warnings.push('Waktu selesai tidak konsisten atau tidak tersedia.');
 const entries=Array.isArray(d.participants)?d.participants.length:null;
 if(entries===null)warnings.push('Daftar entri tidak tersedia atau tidak valid.');
 const winnerCount=Number.isInteger(d.winnerCount)&&d.winnerCount>=1&&d.winnerCount<=100?d.winnerCount:null;
 if(winnerCount===null)warnings.push('Jumlah pemenang tidak valid.');
 const deleting=d.deletion!==undefined;
 if(deleting)warnings.push('Penghapusan belum selesai; lanjutkan atau hapus catatannya.');
 const delivery=d.deliveryStatus==null?'not_recorded':d.deliveryStatus==='delivered'?'delivered':d.deliveryStatus==='pending'?'pending':'review';
 if(delivery==='pending')warnings.push('Pengiriman tertunda atau hasilnya tidak diketahui; periksa Discord.');
 if(delivery==='review')warnings.push('Status pengiriman tidak dikenal; periksa data.');
 // "review" means the stored data is unreliable. Unfinished deliveries and
 // deletions are reported separately: the data is fine, the work is not done.
 const dataWarnings=warnings.length-(deleting?1:0)-(delivery==='pending'?1:0);
 return {messageId:row.message_id,channelId,hostId,prize,status,endAt,entries,winnerCount,delivery,deleting,review:warnings.length>0,dataReview:dataWarnings>0,warnings};
}
const MAX_LISTED_CHANNELS=500;
const LIMITS=Object.freeze({
 minWinners:botConfig.giveaways?.minimumWinners??1,
 maxWinners:botConfig.giveaways?.maximumWinners??10,
 minDurationMs:botConfig.giveaways?.minimumDuration??10_000,
 maxDurationMs:botConfig.giveaways?.maximumDuration??30*24*60*60*1000,
 prizeMaxLength:256,
 pendingSettleMs:GIVEAWAY_PENDING_SETTLE_MS,
});
/** What each outcome means for the administrator, and whether anything changed. */
const OUTCOMES={
 GIVEAWAY_STALE:[409,'Data Giveaway berubah sejak dimuat. Muat ulang dan periksa. Tidak ada yang diubah.'],
 GIVEAWAY_MISSING:[409,'Giveaway tidak ditemukan; mungkin sudah dihapus. Muat ulang daftar.'],
 GIVEAWAY_INVALID:[409,'Data Giveaway perlu diperiksa. Tidak ada yang diubah.'],
 GIVEAWAY_LEGACY:[409,'Ada data Giveaway lama yang ambigu. Tidak ada yang diubah.'],
 GIVEAWAY_STATE:[409,'Status Giveaway tidak mengizinkan aksi ini. Muat ulang dan periksa.'],
 GIVEAWAY_DELETING:[409,'Giveaway ini sedang dalam penghapusan yang belum selesai. Lanjutkan penghapusannya.'],
 GIVEAWAY_IN_PROGRESS:[409,'Pengiriman mungkin masih berjalan. Tunggu sekitar dua menit, muat ulang, lalu periksa Discord. Tidak ada yang diubah.'],
 GIVEAWAY_BUSY:[409,'Giveaway lain sedang dibuat. Tunggu sampai selesai, lalu periksa daftar.'],
 GIVEAWAY_CHANNEL:[409,'Channel tidak tersedia atau bot tidak punya izin melihat, mengirim pesan dan menyematkan tautan di sana. Tidak ada yang dikirim.'],
 GIVEAWAY_DISCORD_UNVERIFIED:[409,'Pesan Giveaway di Discord tidak dapat diperiksa atau dihapus oleh bot. Tidak ada yang diubah.'],
 GIVEAWAY_CREATE_FAILED:[502,'Giveaway tidak dibuat. Tidak ada pesan atau catatan yang tertinggal.'],
 GIVEAWAY_SEND_UNKNOWN:[502,'Pesan Giveaway mungkin terkirim atau tidak, dan catatannya tidak disimpan. Periksa channel; hapus pesannya jika ada.'],
 GIVEAWAY_CREATE_ORPHAN:[502,'Pesan Giveaway terkirim, tetapi catatannya tidak dapat dipastikan tersimpan. Periksa daftar; jika tidak ada, hapus pesannya di Discord.'],
 GIVEAWAY_DELETE_UNFINISHED:[502,'Penghapusan belum selesai: catatan ditandai dan masih ada. Muat ulang, periksa Discord, lalu lanjutkan penghapusan.'],
 GIVEAWAY_DELIVERY_UNKNOWN:[502,'Pengiriman ulang dimulai tetapi hasilnya tidak dapat dipastikan. Periksa Discord sebelum mencoba lagi.'],
 GIVEAWAY_UNAVAILABLE:[503,'Database tidak tersedia. Tidak ada yang diubah.'],
 GIVEAWAY_SCOPE:[403,'Giveaway di luar server ini.'],
};
function reject(res,e){
 if(e.status)return res.status(e.status).json({error:e.message});
 const known=OUTCOMES[e.code];
 if(known)return res.status(known[0]).json({error:known[1],code:e.code,...(id(e.messageId)?{messageId:e.messageId}:{}),...(id(e.channelId)?{channelId:e.channelId}:{})});
 res.status(503).json({error:'Hasil tidak dapat dipastikan. Periksa Discord dan database sebelum mengulang.'});
}
function listChannels(guild){
 const channels=[];
 for(const channel of guild.channels?.cache?.values?.()??[]){if(canPostGiveaway(guild,channel))channels.push(channel)}
 channels.sort((a,b)=>(a.rawPosition??0)-(b.rawPosition??0)||(a.id<b.id?-1:1));
 return {truncated:channels.length>MAX_LISTED_CHANNELS,channels:channels.slice(0,MAX_LISTED_CHANNELS).map(c=>({id:c.id,name:String(c.name??'').slice(0,100)}))};
}
/** Best-effort entry in the audit log channel. The outcome never depends on it. */
async function defaultAudit(client,guildId,actorId,action,details){
 const eventType=action==='create'?EVENT_TYPES.GIVEAWAY_CREATE:action.startsWith('delete')?EVENT_TYPES.GIVEAWAY_DELETE:EVENT_TYPES.GIVEAWAY_WINNER;
 const titles={create:'Giveaway Created',delete:'Giveaway Deleted',delete_record:'Giveaway Record Removed',mark_delivered:'Giveaway Delivery Marked Complete',redeliver:'Giveaway Result Sent Again'};
 await logEvent({client,guildId,eventType,data:{title:titles[action]??'Giveaway Changed',lines:[
  `**Source:** dashboard`,
  `**By:** <@${actorId}> (${actorId})`,
  `**Message:** ${details.messageId}`,
  ...(details.channelId?[`**Channel:** <#${details.channelId}>`]:[]),
  ...(details.prize?[`**Prize:** ${String(details.prize).slice(0,256)}`]:[]),
  ...(details.note?[`**Note:** ${details.note}`]:[]),
 ]}});
}
export function createGiveawayApi(client,{auth,csrf,audit=defaultAudit}){
 const router=express.Router();
 const record=(req,action,details)=>{Promise.resolve().then(()=>audit(client,req.guild.id,req.session.user.id,action,details)).catch(()=>{})};
 router.use('/giveaway',express.json({limit:'4kb'}));
 router.use('/giveaway',(req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/giveaway/list',auth,async(req,res)=>{res.set('Cache-Control','no-store');let conn;try{
  if(Object.keys(req.query).some(k=>k!=='after')||(req.query.after!==undefined&&!id(req.query.after)))throw failure(400,'Parameter halaman tidak valid.');
  const after=req.query.after;
  const stored=listSQLiteGiveawayRows(client,req.guild.id);
  if(stored){const rows=stored.filter(r=>!after||r.message_id>after).slice(0,51),page=rows.slice(0,50);return res.json({giveaways:page.map(r=>summarize(r,req.guild.id)),next:rows.length>50?page.at(-1).message_id:null,legacyDetected:false});}
  conn=await pool(client).connect();
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await conn.query("SET LOCAL statement_timeout = '10s'");
  // A legacy structured key in KV could represent data not visible in the
  // structured table. Do not present the list as complete in this situation.
  const key=`guild:${req.guild.id}:giveaways`;
  const legacy=await conn.query(`SELECT 1 FROM ${pgConfig.tables.temp_data} WHERE key=$1 UNION ALL SELECT 1 FROM ${pgConfig.tables.cache_data} WHERE key=$1 LIMIT 1`,[key]);
  const filter=after?' AND message_id COLLATE "C" > $2 COLLATE "C"':'';
  const rows=(await conn.query(`SELECT message_id,CASE WHEN octet_length(data::text)<=262144 THEN data ELSE NULL END AS data FROM ${pgConfig.tables.giveaways} WHERE guild_id=$1${filter} ORDER BY message_id COLLATE "C" LIMIT 51`,after?[req.guild.id,after]:[req.guild.id])).rows;
  if(rows.some(r=>!id(r.message_id)))throw failure(409,'ID giveaway tidak valid; periksa data sebelum melihat daftar.');
  await conn.query('COMMIT');const page=rows.slice(0,50);
  res.json({giveaways:page.map(r=>summarize(r,req.guild.id)),next:rows.length>50?page.at(-1).message_id:null,legacyDetected:legacy.rows.length>0});
 }catch(e){if(conn)await conn.query('ROLLBACK').catch(()=>{});res.status(e.status||503).json({error:e.status?e.message:'Gagal membaca data Giveaway dari database.'})}finally{conn?.release()}});
 router.get('/giveaway/prepare',auth,async(req,res)=>{try{
  if(Object.keys(req.query).join(',')!=='messageId'||!id(req.query.messageId))throw failure(400,'ID pesan tidak valid.');
  const view=await inspectPostgresGiveaway(client,req.guild.id,req.query.messageId);
  const pending=view.deliveryStatus==='pending';
  res.json({
   messageId:req.query.messageId,channelId:view.channelId,prize:view.prize,entries:view.entries,ended:view.ended,deliveryStatus:view.deliveryStatus,
   canReroll:!view.deleting&&view.ended&&view.deliveryStatus==='delivered'&&view.entries>0&&view.hasWinners,
   deleting:view.deleting,
   // An unfinished delivery can be repaired or deleted only once it can no longer be running.
   canResolve:!view.deleting&&pending&&view.pendingSettled,
   canDelete:view.deleting||!pending||view.pendingSettled,
   revision:view.revision,
  });
 }catch(e){const conflict=['GIVEAWAY_INVALID','GIVEAWAY_LEGACY','GIVEAWAY_MISSING'].includes(e.code);res.status(e.status||(conflict?409:503)).json({error:e.status?e.message:conflict?'Data Giveaway perlu diperiksa atau tidak tersedia.':'Database tidak tersedia.'})}});

 // Channels the bot can post in, and the limits the form must respect.
 router.get('/giveaway/options',auth,(req,res)=>{try{
  if(Object.keys(req.query).length)throw failure(400,'Parameter tidak valid.');
  const listed=listChannels(req.guild);
  res.json({channels:listed.channels,channelsTruncated:listed.truncated,limits:LIMITS});
 }catch(e){reject(res,e)}});

 // Posts a public message in Discord and stores the giveaway.
 router.post('/giveaway/create',auth,csrf,async(req,res)=>{try{
  const b=req.body;
  if(!object(b)||Object.keys(b).sort().join(',')!=='channelId,confirmed,duration,prize,winnerCount'||b.confirmed!==true||!id(b.channelId)||!id(req.session?.user?.id))throw failure(400,'Permintaan Giveaway tidak valid.');
  // Web durations are whole minutes, hours or days; the bot's own limits apply.
  if(typeof b.duration!=='string'||!/^[1-9]\d{0,2}[mhd]$/.test(b.duration))throw failure(400,'Durasi tidak valid. Gunakan angka 1–999 dengan satuan menit, jam atau hari.');
  let durationMs,prize;
  try{durationMs=parseDuration(b.duration);validateWinnerCount(b.winnerCount);prize=validatePrize(b.prize)}
  catch{throw failure(400,`Isian tidak valid. Pemenang ${LIMITS.minWinners}–${LIMITS.maxWinners}, hadiah 1–${LIMITS.prizeMaxLength} karakter, durasi dalam batas yang ditampilkan.`)}
  const created=await createPostgresGiveawayFromDashboard(client,req.guild,{channelId:b.channelId,prize,winnerCount:b.winnerCount,durationMs,hostId:req.session.user.id});
  record(req,'create',{messageId:created.messageId,channelId:created.channelId,prize});
  res.json({ok:true,messageId:created.messageId,channelId:created.channelId,endAt:created.endsAt});
 }catch(e){reject(res,e)}});
 const ACTIONS=['end','reroll','delete','delete_record','mark_delivered','redeliver'];
 router.post('/giveaway/action',auth,csrf,async(req,res)=>{try{
  const b=req.body;
  if(!object(b)||Object.keys(b).sort().join(',')!=='action,confirmed,messageId,revision'||!id(b.messageId)||!ACTIONS.includes(b.action)||b.confirmed!==true||typeof b.revision!=='string'||!/^[0-9a-f]{64}$/.test(b.revision)||!id(req.session?.user?.id))throw failure(400,'Permintaan Giveaway tidak valid.');
  const guildId=req.guild.id,actor=req.session.user.id;
  if(b.action==='end'||b.action==='reroll'){
   let result;
   try{result=await deliverPostgresGiveaway(client,guildId,b.messageId,b.action==='end'?'manual_end':'reroll',actor,null,b.revision)}
   catch(e){return res.status(e.status||503).json({error:e.status?e.message:e.userMessage||'Hasil mungkin tidak diketahui. Periksa Discord dan database sebelum mengulang.'})}
   return res.json({ok:true,winners:result.winners,entries:result.entries});
  }
  if(b.action==='delete'||b.action==='delete_record'){
   const result=await deletePostgresGiveaway(client,guildId,b.messageId,actor,b.revision,{recordOnly:b.action==='delete_record'});
   record(req,b.action,{messageId:b.messageId,channelId:result.channelId,prize:result.prize,note:`${result.entries} entries, Discord message: ${result.discord}`});
   return res.json({ok:true,discord:result.discord,entries:result.entries});
  }
  if(b.action==='mark_delivered'){
   const result=await markPostgresGiveawayDelivered(client,guildId,b.messageId,actor,b.revision);
   record(req,b.action,{messageId:b.messageId,note:'Marked by an administrator; Discord was not contacted'});
   return res.json({ok:true,winners:result.winners,entries:result.entries});
  }
  const result=await redeliverPostgresGiveaway(client,guildId,b.messageId,actor,b.revision);
  record(req,b.action,{messageId:b.messageId,note:'Saved winners announced again; no new draw'});
  res.json({ok:true,winners:result.winners,entries:result.entries});
 }catch(e){reject(res,e)}});
 return router;
}
