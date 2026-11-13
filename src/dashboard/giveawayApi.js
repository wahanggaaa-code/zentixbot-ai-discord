import express from 'express';
import {pgConfig} from '../config/database/postgres.js';
import {inspectPostgresGiveaway} from '../services/storage/postgresGiveawayTransactions.js';
import {deliverPostgresGiveaway} from '../services/postgresGiveawayRuntime.js';

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
 const delivery=d.deliveryStatus==null?'not_recorded':d.deliveryStatus==='delivered'?'delivered':d.deliveryStatus==='pending'?'pending':'review';
 if(delivery==='pending')warnings.push('Pengiriman tertunda atau hasilnya tidak diketahui; periksa Discord.');
 if(delivery==='review')warnings.push('Status pengiriman tidak dikenal; periksa data.');
 return {messageId:row.message_id,channelId,hostId,prize,status,endAt,entries,winnerCount,delivery,review:warnings.length>0,warnings};
}
export function createGiveawayApi(client,{auth,csrf}){
 const router=express.Router();
 router.use('/giveaway',express.json({limit:'4kb'}));
 router.use('/giveaway',(req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/giveaway/list',auth,async(req,res)=>{res.set('Cache-Control','no-store');let conn;try{
  if(Object.keys(req.query).some(k=>k!=='after')||(req.query.after!==undefined&&!id(req.query.after)))throw failure(400,'Parameter halaman tidak valid.');
  const after=req.query.after;conn=await pool(client).connect();
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
 }catch(e){if(conn)await conn.query('ROLLBACK').catch(()=>{});res.status(e.status||503).json({error:e.status?e.message:'Gagal membaca data Giveaway dari PostgreSQL.'})}finally{conn?.release()}});
 router.get('/giveaway/prepare',auth,async(req,res)=>{try{
  if(Object.keys(req.query).join(',')!=='messageId'||!id(req.query.messageId))throw failure(400,'ID pesan tidak valid.');
  const view=await inspectPostgresGiveaway(client,req.guild.id,req.query.messageId);
  res.json({messageId:req.query.messageId,channelId:view.channelId,prize:view.prize,entries:view.entries,ended:view.ended,deliveryStatus:view.deliveryStatus,canReroll:view.ended&&view.deliveryStatus==='delivered'&&view.entries>0&&view.hasWinners,revision:view.revision});
 }catch(e){const conflict=['GIVEAWAY_INVALID','GIVEAWAY_LEGACY','GIVEAWAY_MISSING'].includes(e.code);res.status(e.status||(conflict?409:503)).json({error:e.status?e.message:conflict?'Data Giveaway perlu diperiksa atau tidak tersedia.':'Database tidak tersedia.'})}});
 router.post('/giveaway/action',auth,csrf,async(req,res)=>{try{
  const b=req.body;
  if(!object(b)||Object.keys(b).sort().join(',')!=='action,confirmed,messageId,revision'||!id(b.messageId)||!['end','reroll'].includes(b.action)||b.confirmed!==true||typeof b.revision!=='string'||!/^[0-9a-f]{64}$/.test(b.revision)||!id(req.session?.user?.id))throw failure(400,'Permintaan Giveaway tidak valid.');
  const result=await deliverPostgresGiveaway(client,req.guild.id,b.messageId,b.action==='end'?'manual_end':'reroll',req.session.user.id,null,b.revision);
  res.json({ok:true,winners:result.winners,entries:result.entries});
 }catch(e){res.status(e.status||503).json({error:e.status?e.message:e.userMessage||'Hasil mungkin tidak diketahui. Periksa Discord dan database sebelum mengulang.'})}});
 return router;
}
