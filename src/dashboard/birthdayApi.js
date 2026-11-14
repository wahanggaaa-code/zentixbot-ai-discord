import express from 'express';
import {ChannelType, PermissionFlagsBits} from 'discord.js';
import {pgConfig} from '../config/database/postgres.js';
import {validBirthday,listSQLiteBirthdays,hasSQLiteBirthday,updateSQLiteBirthdayFromDashboard,addSQLiteBirthdayFromDashboard} from '../services/storage/sqliteBirthdays.js';
import {sqliteFor} from '../services/storage/sqliteRows.js';
import {assertNoPostgresBirthdayLegacy,updatePostgresBirthdayFromDashboard,addPostgresBirthdayFromDashboard,hasPostgresBirthday} from '../services/storage/postgresBirthdays.js';
import {LEAP_DAY_FALLBACK} from '../utils/birthdayDates.js';
import {logEvent,EVENT_TYPES} from '../services/loggingService.js';
import {assertOnboardingCompatible,assertOnboardingShape} from '../services/config/onboardingConflict.js';

const tables=pgConfig.tables;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const err=(status,message)=>Object.assign(new Error(message),{status});
function pool(client){const db=client?.db,s=db?.getStatus?.();if(s?.connectionType!=='postgresql'||s.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw err(503,'Database PostgreSQL tidak tersedia.');return db.db.pool;}
// SQLite: the guild config and the welcome config are one row each.
const unavailable=()=>err(503,'Database tidak tersedia.');
const sqliteOf=client=>sqliteFor(client,unavailable);
const configKey=guild=>`guild:${guild}:config`,welcomeKey=guild=>`guild:${guild}:welcome`;
function channelValue(config){
 if(!object(config)||(config.ok!==undefined&&config.value!==undefined))throw err(409,'Konfigurasi server perlu diperiksa sebelum diedit.');
 const value=config.birthdayChannelId??null;
 if(value!==null&&!id(value))throw err(409,'Channel ulang tahun tersimpan perlu diperiksa.');
 return value;
}
const MEMBER_UNVERIFIED='Keanggotaan tidak dapat diverifikasi. Coba lagi atau tinjau data anggota.';
/** Current member of the guild, checked with Discord (not the cache). */
async function fetchMember(guild,userId){
 let member;
 try{member=await guild.members.fetch({user:userId,force:true})}catch{throw err(409,MEMBER_UNVERIFIED)}
 if(!member||member.id!==userId)throw err(409,MEMBER_UNVERIFIED);
 return member;
}
const memberName=member=>String(member.displayName??member.user?.globalName??member.user?.username??'').slice(0,100)||null;
/**
 * Best-effort entry in the bot's audit log channel: who changed whose record.
 * The date itself is personal data and is not written to the channel.
 */
async function defaultAudit(client,guildId,actorId,action,targetId){
 await logEvent({client,guildId,eventType:EVENT_TYPES.MODERATION_CONFIG,data:{
  title:'Birthday Record Changed',
  lines:[
   `**Action:** ${action} (dashboard)`,
   `**Member:** <@${targetId}> (${targetId})`,
   `**By:** ${actorId?`<@${actorId}> (${actorId})`:'unknown'}`,
  ],
 }});
}
function respond(res,e){if(e.code==='BIRTHDAY_EXISTS')return res.status(409).json({error:'Anggota ini sudah memiliki tanggal. Muat ulang daftar dan gunakan KELOLA.'});const conflict=['BIRTHDAY_STALE','BIRTHDAY_BACKUP_CONFLICT','BIRTHDAY_LEGACY_CONFLICT','BIRTHDAY_INVALID'].includes(e.code);res.status(e.status||(conflict?409:503)).json({error:e.status?e.message:conflict?'Data berubah atau memerlukan pemeriksaan. Muat ulang dan periksa cadangan.':'Gagal mengakses database persisten; hasil penyimpanan mungkin tidak diketahui. Muat ulang sebelum mencoba lagi.'});}
function parseCursor(raw){
 if(raw===undefined)return null;
 if(typeof raw!=='string')throw err(400,'Halaman tidak valid.');
 const m=/^(\d{2})-(\d{2})-(\d{17,20})$/.exec(raw);if(!m||!validBirthday(Number(m[1]),Number(m[2])))throw err(400,'Halaman tidak valid.');
 return {month:Number(m[1]),day:Number(m[2]),userId:m[3]};
}
function cursor(row){return `${String(row.month).padStart(2,'0')}-${String(row.day).padStart(2,'0')}-${row.user_id}`;}
export function createBirthdayApi(client,{auth,csrf,audit=defaultAudit}){
 const router=express.Router();
 // Never delays or fails the response; the change is already stored.
 const record=(req,action,targetId)=>{Promise.resolve().then(()=>audit(client,req.guild.id,req.session?.user?.id??null,action,targetId)).catch(()=>{})};router.use(express.json({limit:'4kb'}));router.use((req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/birthday/settings',auth,async(req,res)=>{try{
  const sqlite=sqliteOf(client);
  const stored=sqlite?sqlite.botGet(configKey(req.guild.id))??{}:await pool(client).query(`SELECT config FROM ${tables.guilds} WHERE id=$1`,[req.guild.id]).then(result=>result.rows.length?result.rows[0].config:{});
  const channelId=channelValue(stored);
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
   const sqlite=sqliteOf(client);
   if(sqlite){
    sqlite.transaction(tx=>{
     const raw=tx.botGet(configKey(req.guild.id))??{},old=channelValue(raw);
     if(old!==b.expectedChannelId)throw err(409,'Channel ulang tahun berubah. Muat ulang sebelum menyimpan.');
     const other=tx.botGet(welcomeKey(req.guild.id))??{};assertOnboardingShape(raw,other);
     const next={...raw,birthdayChannelId:b.channelId};assertOnboardingCompatible(next,other);
     tx.botSet(configKey(req.guild.id),next);
    });
    return res.json({ok:true,channelId:b.channelId});
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
  const sqlite=sqliteOf(client);
  if(sqlite){
   const all=listSQLiteBirthdays(client,req.guild.id),start=after?all.findIndex(r=>r.month>after.month||(r.month===after.month&&(r.day>after.day||(r.day===after.day&&(r.user_id.length>after.userId.length||(r.user_id.length===after.userId.length&&r.user_id>after.userId)))))):0;
   const page=start<0?[]:all.slice(start,start+51),rows=page.slice(0,50);
   return res.json({birthdays:rows.map(r=>({userId:r.user_id,month:r.month,day:r.day})),next:page.length>50?cursor(rows[rows.length-1]):null,leapDayFallback:{...LEAP_DAY_FALLBACK}});
  }
  conn=await pool(client).connect();await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await assertNoPostgresBirthdayLegacy(conn,req.guild.id);
  const result=await conn.query(`SELECT user_id,month,day FROM ${tables.birthdays} WHERE guild_id=$1${filter} ORDER BY month,day,user_id LIMIT 51`,args);
  for(const row of result.rows)if(!id(row.user_id)||!validBirthday(row.month,row.day))throw err(409,'Data ulang tahun pada halaman ini perlu diperiksa.');
  const rows=result.rows.slice(0,50);await conn.query('COMMIT');
  res.json({birthdays:rows.map(r=>({userId:r.user_id,month:r.month,day:r.day})),next:result.rows.length>50?cursor(rows[rows.length-1]):null,leapDayFallback:{...LEAP_DAY_FALLBACK}});
 }catch(e){if(conn)await conn.query('ROLLBACK').catch(()=>{});respond(res,e)}finally{conn?.release()}});
 router.patch('/birthday/member/:userId',auth,csrf,async(req,res)=>{try{
  const b=req.body,validDate=x=>object(x)&&Object.keys(x).sort().join(',')==='day,month'&&validBirthday(x.month,x.day);
  if(!id(req.params.userId)||!object(b)||Object.keys(b).sort().join(',')!=='expected,next'||!validDate(b.expected)||(b.next!==null&&!validDate(b.next)))throw err(400,'Tanggal ulang tahun tidak valid.');
  if(b.next!==null)await fetchMember(req.guild,req.params.userId);
  if(sqliteOf(client))updateSQLiteBirthdayFromDashboard(client,req.guild.id,req.params.userId,b.expected,b.next);
  else await updatePostgresBirthdayFromDashboard(client,req.guild.id,req.params.userId,b.expected,b.next);
  record(req,b.next===null?'Removed':'Updated',req.params.userId);res.json({ok:true});
 }catch(e){respond(res,e)}});

 // Identity check before adding: shows who the ID belongs to, not their date.
 router.get('/birthday/member/:userId',auth,async(req,res)=>{try{
  if(!id(req.params.userId)||Object.keys(req.query).length)throw err(400,'ID anggota tidak valid.');
  const member=await fetchMember(req.guild,req.params.userId);
  res.json({
   userId:member.id,
   name:memberName(member),
   bot:member.user?.bot===true,
   hasBirthday:sqliteOf(client)?hasSQLiteBirthday(client,req.guild.id,member.id):await hasPostgresBirthday(client,req.guild.id,member.id),
   leapDayFallback:{...LEAP_DAY_FALLBACK},
  });
 }catch(e){respond(res,e)}});

 // New record for a current, non-bot member who has none yet.
 router.post('/birthday/member',auth,csrf,async(req,res)=>{try{
  const b=req.body;
  if(!object(b)||Object.keys(b).sort().join(',')!=='confirmed,day,month,userId'||b.confirmed!==true||!id(b.userId)||!validBirthday(b.month,b.day))throw err(400,'Tanggal ulang tahun tidak valid.');
  const member=await fetchMember(req.guild,b.userId);
  if(member.user?.bot===true)throw err(400,'Akun bot tidak dapat diberi tanggal ulang tahun.');
  if(sqliteOf(client))addSQLiteBirthdayFromDashboard(client,req.guild.id,member.id,{month:b.month,day:b.day});
  else await addPostgresBirthdayFromDashboard(client,req.guild.id,member.id,{month:b.month,day:b.day});
  record(req,'Added',member.id);res.json({ok:true});
 }catch(e){respond(res,e)}});
 return router;
}
