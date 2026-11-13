import express from 'express';
import {ChannelType, PermissionFlagsBits} from 'discord.js';
import {pgConfig} from '../config/database/postgres.js';
import {validBirthday} from '../services/storage/sqliteBirthdays.js';
import {assertNoPostgresBirthdayLegacy,updatePostgresBirthdayFromDashboard} from '../services/storage/postgresBirthdays.js';
import {assertOnboardingCompatible,assertOnboardingShape} from '../services/config/onboardingConflict.js';

const tables=pgConfig.tables;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const err=(status,message)=>Object.assign(new Error(message),{status});
function pool(client){const db=client?.db,s=db?.getStatus?.();if(s?.connectionType!=='postgresql'||s.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw err(503,'Database PostgreSQL tidak tersedia.');return db.db.pool;}
function channelValue(config){
 if(!object(config)||(config.ok!==undefined&&config.value!==undefined))throw err(409,'Konfigurasi server perlu diperiksa sebelum diedit.');
 const value=config.birthdayChannelId??null;
 if(value!==null&&!id(value))throw err(409,'Channel ulang tahun tersimpan perlu diperiksa.');
 return value;
}
function respond(res,e){const conflict=['BIRTHDAY_STALE','BIRTHDAY_BACKUP_CONFLICT','BIRTHDAY_LEGACY_CONFLICT','BIRTHDAY_INVALID'].includes(e.code);res.status(e.status||(conflict?409:503)).json({error:e.status?e.message:conflict?'Data berubah atau memerlukan pemeriksaan. Muat ulang dan periksa cadangan.':'Gagal mengakses database persisten; hasil penyimpanan mungkin tidak diketahui. Muat ulang sebelum mencoba lagi.'});}
function parseCursor(raw){
 if(raw===undefined)return null;
 if(typeof raw!=='string')throw err(400,'Halaman tidak valid.');
 const m=/^(\d{2})-(\d{2})-(\d{17,20})$/.exec(raw);if(!m||!validBirthday(Number(m[1]),Number(m[2])))throw err(400,'Halaman tidak valid.');
 return {month:Number(m[1]),day:Number(m[2]),userId:m[3]};
}
function cursor(row){return `${String(row.month).padStart(2,'0')}-${String(row.day).padStart(2,'0')}-${row.user_id}`;}
export function createBirthdayApi(client,{auth,csrf}){
 const router=express.Router();router.use(express.json({limit:'4kb'}));router.use((req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/birthday/settings',auth,async(req,res)=>{try{
  const result=await pool(client).query(`SELECT config FROM ${tables.guilds} WHERE id=$1`,[req.guild.id]);
  const channelId=channelValue(result.rows.length?result.rows[0].config:{});
  const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(c=>({id:c.id,name:c.name}));
  res.json({channelId,channels});
 }catch(e){respond(res,e)}});
 router.patch('/birthday/settings',auth,csrf,async(req,res)=>{
  let conn;try{
   const b=req.body;
   if(!object(b)||Object.keys(b).sort().join(',')!=='channelId,expectedChannelId'||(b.channelId!==null&&!id(b.channelId))||(b.expectedChannelId!==null&&!id(b.expectedChannelId)))throw err(400,'Pengaturan channel tidak valid.');
   if(b.channelId!==null){
    const channel=req.guild.channels.cache.get(b.channelId),me=req.guild.members.me;
    if(!channel||channel.type!==ChannelType.GuildText)throw err(400,'Pilih channel teks dari server ini.');
    if(!me||!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]))throw err(403,'Bot memerlukan izin View Channel, Send Messages, dan Embed Links.');
   }
   conn=await pool(client).connect();await conn.query('BEGIN');
   await conn.query(`INSERT INTO ${tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`,[req.guild.id]);
   const rows=await conn.query(`SELECT config FROM ${tables.guilds} WHERE id=$1 FOR UPDATE`,[req.guild.id]);
   const raw=rows.rows[0]?.config,old=channelValue(raw);
   if(old!==b.expectedChannelId)throw err(409,'Channel ulang tahun berubah. Muat ulang sebelum menyimpan.');
   const welcome=await conn.query(`SELECT config FROM ${tables.welcome_configs} WHERE guild_id=$1 FOR UPDATE`,[req.guild.id]);
   const other=welcome.rows.length?welcome.rows[0].config:{};assertOnboardingShape(raw,other);
   const next={...raw,birthdayChannelId:b.channelId};assertOnboardingCompatible(next,other);
   await conn.query(`UPDATE ${tables.guilds} SET config=jsonb_set(config,'{birthdayChannelId}',$2::jsonb,true),updated_at=CURRENT_TIMESTAMP WHERE id=$1`,[req.guild.id,JSON.stringify(b.channelId)]);
   await conn.query('COMMIT');res.json({ok:true,channelId:b.channelId});
  }catch(e){if(conn)await conn.query('ROLLBACK').catch(()=>{});respond(res,e)}finally{conn?.release()}
 });
 router.get('/birthday/list',auth,async(req,res)=>{let conn;try{
  if(Object.keys(req.query).some(k=>k!=='after'))throw err(400,'Parameter daftar tidak valid.');
  const after=parseCursor(req.query.after),args=after?[req.guild.id,after.month,after.day,after.userId]:[req.guild.id];
  const filter=after?' AND (month,day,user_id)>($2,$3,$4)':'';
  conn=await pool(client).connect();await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await assertNoPostgresBirthdayLegacy(conn,req.guild.id);
  const result=await conn.query(`SELECT user_id,month,day FROM ${tables.birthdays} WHERE guild_id=$1${filter} ORDER BY month,day,user_id LIMIT 51`,args);
  for(const row of result.rows)if(!id(row.user_id)||!validBirthday(row.month,row.day))throw err(409,'Data ulang tahun pada halaman ini perlu diperiksa.');
  const rows=result.rows.slice(0,50);await conn.query('COMMIT');
  res.json({birthdays:rows.map(r=>({userId:r.user_id,month:r.month,day:r.day})),next:result.rows.length>50?cursor(rows[rows.length-1]):null});
 }catch(e){if(conn)await conn.query('ROLLBACK').catch(()=>{});respond(res,e)}finally{conn?.release()}});
 router.patch('/birthday/member/:userId',auth,csrf,async(req,res)=>{try{
  const b=req.body,validDate=x=>object(x)&&Object.keys(x).sort().join(',')==='day,month'&&validBirthday(x.month,x.day);
  if(!id(req.params.userId)||!object(b)||Object.keys(b).sort().join(',')!=='expected,next'||!validDate(b.expected)||(b.next!==null&&!validDate(b.next)))throw err(400,'Tanggal ulang tahun tidak valid.');
  if(b.next!==null){
   let member;try{member=await req.guild.members.fetch({user:req.params.userId,force:true})}catch{throw err(409,'Keanggotaan tidak dapat diverifikasi. Coba lagi atau tinjau data anggota.')}
   if(!member||member.id!==req.params.userId)throw err(409,'Keanggotaan tidak dapat diverifikasi. Coba lagi atau tinjau data anggota.');
  }
  await updatePostgresBirthdayFromDashboard(client,req.guild.id,req.params.userId,b.expected,b.next);res.json({ok:true});
 }catch(e){respond(res,e)}});
 return router;
}
