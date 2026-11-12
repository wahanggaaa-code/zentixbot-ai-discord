import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { pgConfig } from '../../config/database/postgres.js';
import { sqliteBackend } from '../storage/sqlite.js';
import { createSqliteActivityStore } from './sqliteActivities.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
export const DEFAULT_ACTIVITY=Object.freeze({enabled:false,channelId:null,duration:60,language:'id',kind:'trivia',scheduleEnabled:false,scheduleTime:'18:00',scheduleDays:'everyday',timeZone:'WIB',rewardPoints:0});
export function validateActivity(v,guild){
 const keys=Object.keys(DEFAULT_ACTIVITY);if(!v||typeof v!=='object'||Array.isArray(v)||keys.length!==Object.keys(v).length||keys.some(k=>!Object.hasOwn(v,k)))throw error('Pengaturan activity tidak valid.');
 if(typeof v.enabled!=='boolean'||typeof v.scheduleEnabled!=='boolean'||!Number.isInteger(v.rewardPoints)||v.rewardPoints<0||v.rewardPoints>1000||!Number.isInteger(v.duration)||v.duration<30||v.duration>300||!['id','en'].includes(v.language)||!['trivia','emoji'].includes(v.kind)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.scheduleTime)||!['everyday','weekdays','weekend'].includes(v.scheduleDays)||!['WIB','WITA','WIT'].includes(v.timeZone))throw error('Pengaturan activity tidak valid.');
 if(v.channelId!==null&&(typeof v.channelId!=='string'||!/^\d{17,20}$/.test(v.channelId)))throw error('Channel tidak valid.');
 if(guild&&v.channelId!==null&&guild.channels.cache.get(v.channelId)?.type!==ChannelType.GuildText)throw error('Channel tidak tersedia di server ini.');
 if(v.enabled&&!v.channelId)throw error('Pilih channel activity.');
 if(guild&&v.enabled){const c=guild.channels.cache.get(v.channelId),me=guild.members.me;if(!me||!c?.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks]))throw error('Bot membutuhkan View Channel, Send Messages dan Embed Links.');}
 return {...v};
}
function dbPool(client){const db=client.db;if(!db||db.getStatus?.().isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool)throw error('Database persisten tidak tersedia.',503);return db.db.pool;}
export function createActivityStore(client){
 const sqlite=sqliteBackend(client);if(sqlite)return createSqliteActivityStore(sqlite,{defaults:DEFAULT_ACTIVITY,validateActivity,validateQuiz,error});
 const table=pgConfig.tables.cache_data,key=id=>`ai:activity:settings:${id}`,roundKey=id=>`ai:activity:round:${id}`;
 async function locked(guildId,fn){const conn=await dbPool(client).connect();try{await conn.query('BEGIN');await conn.query(`INSERT INTO ${table} (key,value) VALUES ($1,'{}'::jsonb) ON CONFLICT (key) DO NOTHING`,[roundKey(guildId)]);const r=await conn.query(`SELECT value FROM ${table} WHERE key=$1 FOR UPDATE`,[roundKey(guildId)]);const value=r.rows[0].value;const result=await fn(value,conn);if(result.write)await conn.query(`UPDATE ${table} SET value=$2::jsonb WHERE key=$1`,[roundKey(guildId),JSON.stringify(result.write)]);await conn.query('COMMIT');return result.result;}catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release();}}
 return {
  async read(id){const r=await dbPool(client).query(`SELECT value FROM ${table} WHERE key=$1`,[key(id)]);return r.rows[0]?.value?validateActivity({...DEFAULT_ACTIVITY,...r.rows[0].value}):{...DEFAULT_ACTIVITY};},
  async save(id,cfg){const v=validateActivity(cfg);await dbPool(client).query(`INSERT INTO ${table} (key,value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,[key(id),JSON.stringify(v)]);return v;},
  async claimSchedule(id,day){const conn=await dbPool(client).connect();const k=`ai:activity:schedule:${id}`;try{await conn.query('BEGIN');await conn.query(`INSERT INTO ${table} (key,value) VALUES ($1,'{}'::jsonb) ON CONFLICT (key) DO NOTHING`,[k]);const r=await conn.query(`SELECT value FROM ${table} WHERE key=$1 FOR UPDATE`,[k]);if(r.rows[0].value.day===day){await conn.query('COMMIT');return false;}await conn.query(`UPDATE ${table} SET value=$2::jsonb WHERE key=$1`,[k,JSON.stringify({day})]);await conn.query('COMMIT');return true;}catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release()}},
  async status(id,now=Date.now()){const r=await dbPool(client).query(`SELECT value FROM ${table} WHERE key=$1`,[roundKey(id)]);const v=r.rows[0]?.value;if(!v||!['pending','open','expired','solved','closed'].includes(v.state))return {state:'none'};const state=v.state==='open'&&v.expiresAt<=now?'expired':v.state;const quiz=validateQuiz(v.question);return {state,expiresAt:Number.isFinite(v.expiresAt)?v.expiresAt:null,...(quiz?{question:quiz.question,options:quiz.options,...(state!=='open'&&state!=='pending'?{answer:quiz.answer}:{})}:{})};},
  async points(id,userId){if(!/^\d{17,20}$/.test(userId||''))throw error('Anggota tidak valid.');const r=await dbPool(client).query(`SELECT value FROM ${table} WHERE key=$1`,[`ai:activity:points:${id}:${userId}`]);const n=r.rows[0]?.value?.points??0;if(!Number.isSafeInteger(n)||n<0)throw error('Saldo poin tidak valid.',503);return n;},
  reserve(id,roundId,now){return locked(id,v=>{if(['pending','open'].includes(v.state)&&v.expiresAt>now)throw error('Masih ada ronde yang berjalan.',409);return {write:{state:'pending',id:roundId,expiresAt:now+150000},result:true};});},
  open(id,roundId,question,duration,now,rewardPoints=0){return locked(id,v=>{if(v.state!=='pending'||v.id!==roundId||v.expiresAt<=now)throw error('Reservasi ronde kedaluwarsa.',409);return {write:{state:'open',id:roundId,expiresAt:now+duration*1000,question,answered:[],messageId:null,rewardPoints},result:true}});},
  attach(id,roundId,messageId){return locked(id,v=>{if(v.state!=='open'||v.id!==roundId)throw error('Ronde sudah berubah.',409);return {write:{...v,messageId},result:true}});},
  cancel(id,roundId){return locked(id,v=>v.id===roundId?{write:{state:'closed'},result:true}:{result:false});},
  answer(id,roundId,messageId,userId,choice,now){return locked(id,async(v,conn)=>{
   if(v.id!==roundId||v.messageId!==messageId||v.state!=='open')return {result:{status:'closed'}};
   if(v.expiresAt<=now)return {write:{...v,state:'expired'},result:{status:'expired',question:v.question}};
   if(!Array.isArray(v.answered)||v.answered.length>=1000)return {result:{status:'full'}};
   if(v.answered.includes(userId))return {result:{status:'answered'}};
   const answered=[...v.answered,userId];if(choice===v.question.answer){
    const reward=v.rewardPoints??0;if(!Number.isInteger(reward)||reward<0||reward>1000||!/^\d{17,20}$/.test(userId||''))throw error('Data hadiah tidak valid.',503);let points=null;
    if(reward){const k=`ai:activity:points:${id}:${userId}`;await conn.query(`INSERT INTO ${table} (key,value) VALUES ($1,'{}'::jsonb) ON CONFLICT (key) DO NOTHING`,[k]);const row=await conn.query(`SELECT value FROM ${table} WHERE key=$1 FOR UPDATE`,[k]);const before=row.rows[0].value.points??0;points=before+reward;if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(points))throw error('Saldo poin tidak valid.',503);await conn.query(`UPDATE ${table} SET value=$2::jsonb WHERE key=$1`,[k,JSON.stringify({points})]);}
    return {write:{...v,state:'solved',answered},result:{status:'correct',question:v.question,reward,points}};}

   return {write:{...v,answered},result:{status:'wrong'}};
  });},
  expire(id,roundId,now){return locked(id,v=>v.id===roundId&&v.state==='open'&&v.expiresAt<=now?{write:{...v,state:'expired'},result:v.question}:{result:null});}
 };
}
const FALLBACK={question:'Planet mana yang dikenal sebagai planet merah?',options:['Venus','Mars','Jupiter','Merkurius'],answer:1};
export function validateQuiz(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join(',')!=='answer,options,question')return null;
 const valid=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max&&!/https?:\/\/|www\.|discord\.gg|<@|@(everyone|here)/i.test(s);
 if(!valid(raw.question,300)||!Array.isArray(raw.options)||raw.options.length!==4||raw.options.some(x=>!valid(x,80))||new Set(raw.options.map(x=>x.trim().toLowerCase())).size!==4||!Number.isInteger(raw.answer)||raw.answer<0||raw.answer>3)return null;
 return {question:raw.question.trim(),options:raw.options.map(x=>x.trim()),answer:raw.answer};
}
export function quizPayload(quiz,roundId,{ended=null}={}){
 const choices=quiz.options.map((o,i)=>`**${String.fromCharCode(65+i)}.** ${o}`).join('\n');
 return {embeds:[{title:'✳ AI Activities',description:`${quiz.question}\n\n${choices}${ended?`\n\n${ended} Jawaban: **${String.fromCharCode(65+quiz.answer)}. ${quiz.options[quiz.answer]}**`:''}`,color:0xb0e52c}],components:[...(!ended?[new ActionRowBuilder().addComponents(quiz.options.map((_,i)=>new ButtonBuilder().setCustomId(`ai_quiz:${roundId}:${i}`).setLabel(String.fromCharCode(65+i)).setStyle(ButtonStyle.Secondary)))]:[]),new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ai_quiz_points:view').setLabel('Poin saya').setStyle(ButtonStyle.Secondary))],allowedMentions:{parse:[]}};
}
export async function startActivity({client,guild,actorId,store=createActivityStore(client),foundation=client.aiFoundation}){
 if(guild.id!==client.homeGuildId)throw error('Server tidak valid.',403);const cfg=validateActivity(await store.read(guild.id),guild);if(!cfg.enabled)throw error('AI Activities belum diaktifkan.',403);
 const roundId=crypto.randomBytes(10).toString('hex');await store.reserve(guild.id,roundId,Date.now());let sendAttempted=false;
 try{
  let question=null,source='ai';try{const prompt=`Generate one easy ${cfg.kind==='emoji'?'emoji guessing puzzle, where the question contains emoji representing a familiar object or phrase':'factual general-knowledge multiple choice question'} in ${cfg.language==='id'?'Indonesian':'English'}. Respond with only JSON object with keys question (string), options (array of exactly 4 short strings), answer (correct index 0 to 3). No URLs or mentions.`;const r=await foundation.generate({guildId:guild.id,userId:actorId,consent:true,prompt});question=validateQuiz(JSON.parse(r.text));}catch{}
  if(!question){question=cfg.kind==='emoji'?(cfg.language==='en'?{question:'Guess the word: ☀️🌻',options:['Sunflower','Moon','Ocean','Cloud'],answer:0}:{question:'Tebak kata: ☀️🌻',options:['Bunga matahari','Bulan','Laut','Awan'],answer:0}):cfg.language==='en'?{question:'Which planet is known as the Red Planet?',options:['Venus','Mars','Jupiter','Mercury'],answer:1}:FALLBACK;source='fallback';}
  await store.open(guild.id,roundId,question,cfg.duration,Date.now(),cfg.rewardPoints);const channel=guild.channels.cache.get(cfg.channelId);sendAttempted=true;let message;
  try{message=await channel.send(quizPayload(question,roundId));}catch{throw error('Hasil pengiriman ronde tidak pasti; periksa channel sebelum mencoba lagi.',409)}
  try{await store.attach(guild.id,roundId,message.id);}catch{throw error('Ronde terkirim tetapi status gagal disimpan; periksa channel sebelum mencoba lagi.',409)}
  const timer=setTimeout(async()=>{try{const expired=await store.expire(guild.id,roundId,Date.now());if(expired)await message.edit(quizPayload(expired,roundId,{ended:'Waktu habis.'}));}catch{}},cfg.duration*1000+100);timer.unref?.();
  return {messageId:message.id,source};
 }catch(e){if(!sendAttempted)await store.cancel(guild.id,roundId).catch(()=>{});throw e;}
}

const ZONES={WIB:'Asia/Jakarta',WITA:'Asia/Makassar',WIT:'Asia/Jayapura'};
export function scheduleMatches(cfg,now=new Date()){
 if(!cfg.enabled||!cfg.scheduleEnabled)return null;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:ZONES[cfg.timeZone],year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 const weekend=['Sat','Sun'].includes(parts.weekday);if(cfg.scheduleDays==='weekdays'&&weekend||cfg.scheduleDays==='weekend'&&!weekend||`${parts.hour}:${parts.minute}`!==cfg.scheduleTime)return null;
 return `${parts.year}-${parts.month}-${parts.day}`;
}
export async function runScheduledActivity(client,{store=createActivityStore(client),now=new Date(),start=startActivity}={}){
 const guild=client.guilds?.cache.get(client.homeGuildId);if(!guild)return false;const cfg=await store.read(guild.id);const day=scheduleMatches(cfg,now);if(!day)return false;
 if(!await store.claimSchedule(guild.id,day))return false;
 await start({client,guild,actorId:client.user.id,store,foundation:client.aiFoundation});return true;
}
