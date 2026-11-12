import express from 'express';
import {createHash} from 'node:crypto';
import {ChannelType, PermissionFlagsBits} from 'discord.js';
import {pgConfig} from '../config/database/postgres.js';
import {normalizeWelcomeConfig} from '../utils/database.js';
import {assertOnboardingShape, assertOnboardingCompatible} from '../services/config/onboardingConflict.js';

const tables=pgConfig.tables;
const record=x=>x!==null && typeof x==='object' && !Array.isArray(x);
const error=(status,message)=>Object.assign(new Error(message),{status});
const version=serialized=>createHash('sha256').update('goodbye-v1:'+serialized).digest('hex');
function pool(client){
 const db=client?.db, status=db?.getStatus?.();
 if(status?.connectionType!=='postgresql' || status.isDegraded || !db.isAvailable?.() || !db.db?.isAvailable?.() || !db.db.pool?.connect) throw error(503,'Database PostgreSQL tidak tersedia.');
 return db.db.pool;
}
function checked(raw){
 if(!record(raw)||(raw.ok!==undefined&&raw.value!==undefined)) throw error(409,'Format welcome/goodbye perlu diperiksa sebelum diedit.');
 for(const key of ['goodbyeEnabled','goodbyePing']) if(raw[key]!==undefined&&typeof raw[key]!=='boolean') throw error(409,'Pengaturan goodbye perlu diperiksa sebelum diedit.');
 if(raw.goodbyeChannelId!==undefined && raw.goodbyeChannelId!==null && (typeof raw.goodbyeChannelId!=='string'||!/^\d{17,20}$/.test(raw.goodbyeChannelId))) throw error(409,'Channel goodbye tersimpan tidak valid.');
 if(raw.leaveMessage!==undefined && (typeof raw.leaveMessage!=='string'||!raw.leaveMessage.trim()||raw.leaveMessage.length>1500)) throw error(409,'Pesan goodbye tersimpan perlu diperiksa.');
 const embed=raw.leaveEmbed;
 if(embed!==undefined){
  if(!record(embed))throw error(409,'Embed goodbye tersimpan perlu diperiksa.');
  if(embed.title!==undefined&&(typeof embed.title!=='string'||!embed.title.trim()||embed.title.length>256))throw error(409,'Judul goodbye tersimpan perlu diperiksa.');
  if(embed.footer!==undefined&&(typeof embed.footer!=='string'||embed.footer.length>1024))throw error(409,'Footer goodbye tersimpan perlu diperiksa.');
  if(embed.color!==undefined&&(!Number.isInteger(embed.color)||embed.color<0||embed.color>0xffffff))throw error(409,'Warna goodbye tersimpan perlu diperiksa.');
  if(embed.image!==undefined&&embed.image!==null&&typeof embed.image!=='string'&&(!record(embed.image)||typeof embed.image.url!=='string'))throw error(409,'Gambar goodbye tersimpan perlu diperiksa.');
 }
 return raw;
}
function view(raw){
 const cfg=normalizeWelcomeConfig(checked(raw)),embed=cfg.leaveEmbed;
 const image=typeof embed.image==='string'?embed.image:(embed.image?.url??null);
 return {enabled:cfg.goodbyeEnabled,channelId:cfg.goodbyeChannelId,message:cfg.leaveMessage,ping:cfg.goodbyePing,
  title:embed.title??'👋 Goodbye',footer:embed.footer??'Goodbye from {server}!',color:embed.color??0xed4245,image};
}
function validate(body,guild){
 const keys=['revision','enabled','channelId','message','ping','image','title','footer','color'];
 if(!record(body)||Object.keys(body).length!==keys.length||Object.keys(body).some(k=>!keys.includes(k)))throw error(400,'Pengaturan goodbye tidak valid.');
 if(typeof body.revision!=='string'||!(/^(missing|[a-f0-9]{64})$/.test(body.revision)))throw error(400,'Versi pengaturan tidak valid.');
 if(typeof body.enabled!=='boolean'||typeof body.ping!=='boolean')throw error(400,'Status dan ping harus boolean.');
 if(typeof body.message!=='string'||!body.message.trim()||body.message.length>1500)throw error(400,'Pesan harus berisi 1–1500 karakter.');
 if(typeof body.title!=='string'||!body.title.trim()||body.title.length>256||typeof body.footer!=='string'||body.footer.length>1024||!Number.isInteger(body.color)||body.color<0||body.color>0xffffff)throw error(400,'Judul, footer atau warna tidak valid.');
 if(body.channelId!==null&&(typeof body.channelId!=='string'||guild.channels.cache.get(body.channelId)?.type!==ChannelType.GuildText))throw error(400,'Pilih channel teks dari server ini.');
 if(body.enabled){
  const channel=guild.channels.cache.get(body.channelId),me=guild.members.me;
  if(!channel||!me)throw error(400,'Pilih channel untuk mengaktifkan goodbye.');
  if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw error(403,'Bot tidak memiliki izin melihat dan mengirim di channel itu.');
 }
 if(body.image!==null){
  if(typeof body.image!=='string'||body.image.length>1000)throw error(400,'URL gambar tidak valid.');
  let url;try{url=new URL(body.image)}catch{throw error(400,'URL gambar tidak valid.')}
  if(url.protocol!=='https:'||url.username||url.password)throw error(400,'URL gambar harus HTTPS tanpa kredensial.');
 }
 return body;
}
function fail(res,e){res.status(e.status||503).json({error:e.status?e.message:'Gagal mengakses database persisten.'});}
export function createGoodbyeApi(client,{auth,csrf}){
 const router=express.Router();router.use(express.json({limit:'16kb'}));
 router.get('/goodbye',auth,async(req,res)=>{try{
  const result=await pool(client).query(`SELECT config,config::text AS serialized FROM ${tables.welcome_configs} WHERE guild_id=$1`,[req.guild.id]);
  const row=result.rows[0],raw=row?row.config:{},goodbye=view(raw);
  const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(c=>({id:c.id,name:c.name}));
  res.json({goodbye,revision:row?version(row.serialized):'missing',channels});
 }catch(e){fail(res,e)}});
 router.patch('/goodbye',auth,csrf,async(req,res)=>{
  let body;try{body=validate(req.body,req.guild)}catch(e){return fail(res,e)}
  let conn;try{
   conn=await pool(client).connect();await conn.query('BEGIN');
   await conn.query(`INSERT INTO ${tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`,[req.guild.id]);
   const guild=await conn.query(`SELECT config FROM ${tables.guilds} WHERE id=$1 FOR UPDATE`,[req.guild.id]);
   const created=await conn.query(`INSERT INTO ${tables.welcome_configs}(guild_id,config) VALUES($1,'{}'::jsonb) ON CONFLICT(guild_id) DO NOTHING RETURNING guild_id`,[req.guild.id]);
   const result=await conn.query(`SELECT config,config::text AS serialized FROM ${tables.welcome_configs} WHERE guild_id=$1 FOR UPDATE`,[req.guild.id]);
   const row=result.rows[0],raw=checked(row?.config),currentVersion=created.rowCount?'missing':version(row.serialized);
   if(currentVersion!==body.revision)throw error(409,'Pengaturan berubah. Muat ulang sebelum menyimpan.');
   assertOnboardingShape(guild.rows[0]?.config,raw);
   const embed={...normalizeWelcomeConfig(raw).leaveEmbed,title:body.title,footer:body.footer,color:body.color};
   if(body.image===null)delete embed.image;else embed.image={url:body.image};
   const merged={...raw,goodbyeEnabled:body.enabled,goodbyeChannelId:body.channelId,leaveMessage:body.message,goodbyePing:body.ping,leaveEmbed:embed};
   assertOnboardingCompatible(guild.rows[0]?.config,merged);
   const saved=await conn.query(`UPDATE ${tables.welcome_configs} SET config=$2::jsonb,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 RETURNING config::text AS serialized`,[req.guild.id,JSON.stringify(merged)]);
   await conn.query('COMMIT');res.json({ok:true,revision:version(saved.rows[0].serialized),goodbye:view(merged)});
  }catch(e){if(conn)await conn.query('ROLLBACK').catch(()=>{});fail(res,e)}finally{conn?.release()}
 });
 return router;
}
