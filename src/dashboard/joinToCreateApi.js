import express from 'express';
import {pgConfig} from '../config/database/postgres.js';
import {getJoinToCreateConfigKey,getJoinToCreateChannelsKey} from '../utils/database/keys.js';

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
 const triggers=cfg.triggerChannels.map(channelId=>{
  const v=cfg.channelOptions[channelId]??{};if(!obj(v)||(v.nameTemplate!==undefined&&(typeof v.nameTemplate!=='string'||v.nameTemplate.length>1000))||(v.userLimit!==undefined&&(!Number.isInteger(v.userLimit)||v.userLimit<0||v.userLimit>99))||(v.bitrate!==undefined&&(!Number.isInteger(v.bitrate)||v.bitrate<8000||v.bitrate>384000))||(v.categoryId!=null&&!id(v.categoryId)))throw fail(409,'Opsi channel Join to Create perlu diperiksa.');
  return {channelId,nameTemplate:v.nameTemplate??null,userLimit:v.userLimit??null,bitrate:v.bitrate??null,categoryId:v.categoryId??null};
 });
 return {enabled:cfg.enabled,categoryId:cfg.categoryId,channelNameTemplate:cfg.channelNameTemplate,userLimit:cfg.userLimit,bitrate:cfg.bitrate,triggers,channels};
}
export function createJoinToCreateApi(client,{auth}){
 const router=express.Router();
 router.use('/join-to-create',(req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/join-to-create',auth,async(req,res)=>{try{
  if(Object.keys(req.query).some(k=>k!=='after')||(req.query.after!==undefined&&!id(req.query.after)))throw fail(400,'Parameter halaman tidak valid.');
  const key=getJoinToCreateConfigKey(req.guild.id),channelsKey=getJoinToCreateChannelsKey(req.guild.id);
  const result=await pool(client).query(`SELECT 'temp' AS source,key,expires_at IS NOT NULL AS has_expiry,(expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS expired,CASE WHEN key=$1 AND octet_length(value::text)<=524288 THEN value ELSE NULL END AS value FROM ${pgConfig.tables.temp_data} WHERE key=ANY($2::text[]) UNION ALL SELECT 'cache' AS source,key,expires_at IS NOT NULL AS has_expiry,(expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP) AS expired,NULL::jsonb AS value FROM ${pgConfig.tables.cache_data} WHERE key=ANY($2::text[])`,[key,[key,channelsKey]]);
  const row=result.rows.find(r=>r.source==='temp'&&r.key===key),otherData=result.rows.some(r=>r.source==='cache'||r.key===channelsKey);
  if(!row)return res.json({state:'missing',otherData});
  if(row.expired)return res.json({state:'expired',otherData});
  const config=validate(row.value),after=req.query.after||'',ordered=config.channels.sort(([a],[b])=>a<b?-1:a>b?1:0),filtered=ordered.filter(([channelId])=>channelId>after),page=filtered.slice(0,50);
  res.json({state:'stored',otherData,hasExpiry:row.has_expiry,enabled:config.enabled,categoryId:config.categoryId,channelNameTemplate:config.channelNameTemplate,userLimit:config.userLimit,bitrate:config.bitrate,triggers:config.triggers,totalTemporaryChannels:ordered.length,temporaryChannels:page.map(([channelId,v])=>({channelId,triggerChannelId:v.triggerChannelId,createdAt:v.createdAt??null})),next:filtered.length>50?page.at(-1)[0]:null});
 }catch(e){res.status(e.status||503).json({error:e.status?e.message:'Gagal membaca Join to Create dari database.'})}});
 return router;
}
