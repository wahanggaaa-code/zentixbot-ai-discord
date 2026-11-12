import express from 'express';
import {ChannelType, PermissionFlagsBits} from 'discord.js';
import { pgConfig } from '../config/database/postgres.js';
import { sqliteBackend } from '../services/storage/sqlite.js';
import { readSQLiteBotValue } from '../services/storage/sqliteBotDatabase.js';
import {mutateLevelInTransaction} from '../services/leveling/sqliteLevels.js';
import { getGuildMusicData } from '../services/music/playerStore.js';
import {getPlayer,applyPause,applyResume,destroyPlayerSession,playQuery} from '../services/music/musicActions.js';
import {ModerationService} from '../services/moderation/moderationService.js';
import {WarningService} from '../services/moderation/warningService.js';
import {logModerationAction} from '../utils/moderation.js';
import {closeTicket,reopenTicket,claimTicket} from '../services/ticket.js';
import {getMaxBankCapacity} from '../utils/economy.js';
import {calculateTotalXp} from '../services/leveling/leveling.js';
import { Mutex } from '../utils/mutex.js';

const tables=pgConfig.tables;
const idRe=/^\d{17,20}$/;
function safeMusicQuery(value){
 if(typeof value!=='string'||!value.trim()||value.length>300)throw bad('Masukkan judul lagu atau tautan.');
 const query=value.trim();
 if (/^[a-z][a-z0-9+.-]*:/i.test(query)) {
  let url;try{url=new URL(query)}catch{throw bad('Tautan tidak valid.')}
  const host=url.hostname.toLowerCase();const allowed=['soundcloud.com','spotify.com','deezer.com','bandcamp.com','music.apple.com'];
  if(url.protocol!=='https:'||url.username||url.password||url.port||!allowed.some(domain=>host===domain||host.endsWith('.'+domain)))throw bad('Tautan hanya didukung dari layanan musik HTTPS yang diizinkan.');
 }
 return query;
}

const bad=(message,status=400)=>Object.assign(new Error(message),{status});
function pool(client){const d=client.db;if(!d||d.getStatus?.().isDegraded||!d.isAvailable?.()||!d.db?.isAvailable?.()||!d.db.pool)throw bad('Database persisten tidak tersedia.',503);return d.db.pool;}
function requireStorage(client){const sqlite=sqliteBackend(client);if(sqlite)return sqlite;return pool(client)}
function fail(res,e){if(!e.status)console.error('[dashboard operations]',e.message);res.status(e.status||503).json({error:e.status?e.message:'Operasi gagal; periksa izin bot dan log server. Bila tindakan Discord sudah terjadi, periksa sebelum mencoba lagi.'});}
function sqliteLeaderboard(sqlite,guildId){return sqlite.botLevels(guildId).map(({userId,data})=>{
 if(!data||typeof data!=='object'||Array.isArray(data))throw bad('Data leveling tidak valid.',503);
 const level=Number(data.level??0),totalXp=Number(data.totalXp??0);if(!Number.isSafeInteger(level)||level<0||!Number.isSafeInteger(totalXp)||totalXp<0)throw bad('Data leveling tidak valid.',503);return {userId,level,totalXp};
}).filter(x=>x.totalXp>0).sort((a,b)=>b.totalXp-a.totalXp||a.userId.localeCompare(b.userId)).slice(0,50)}
const track=t=>t?{title:String(t.info?.title||'Unknown').slice(0,300),author:String(t.info?.author||'Unknown').slice(0,200),uri:t.info?.uri||null,length:t.info?.length||null}:null;
export function createOperationsApi(client,{auth,csrf}) {
 const router=express.Router();router.use(express.json({limit:'16kb'}));
 router.get('/cases',auth,async(req,res)=>{try{const sqlite=sqliteBackend(client);let cases;if(sqlite)cases=sqlite.botGet(`moderation_cases_list_${req.guild.id}`)||[];else{const row=await pool(client).query(`SELECT value FROM ${tables.temp_data} WHERE key=$1 AND (expires_at IS NULL OR expires_at>NOW())`,[`moderation_cases_list_${req.guild.id}`]);cases=row.rows[0]?.value||[]}res.json({cases:Array.isArray(cases)?cases.slice(-100).reverse():[]});}catch(e){fail(res,e)}});
 router.post('/moderation',auth,csrf,async(req,res)=>{try{
  const b=req.body;if(!b||Object.keys(b).some(k=>!['action','userId','reason','minutes','confirmed'].includes(k))||b.confirmed!==true||!['warn','timeout','kick','ban'].includes(b.action)||!idRe.test(b.userId||'')||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>400)throw bad('Tindakan, anggota, alasan, atau konfirmasi tidak valid.');
  if(b.userId===req.member.id || b.userId===client.user.id || b.userId===req.guild.ownerId)throw bad('Tidak dapat menindak diri sendiri, bot, atau owner server.');
  if(b.action==='timeout' && (!Number.isInteger(b.minutes)||b.minutes<1||b.minutes>40320))throw bad('Timeout harus 1–40320 menit.');
  requireStorage(client);const target=await req.guild.members.fetch({user:b.userId,force:true}).catch(()=>null);if(!target)throw bad('Anggota tidak ditemukan di server.');
  const required={warn:PermissionFlagsBits.ModerateMembers,timeout:PermissionFlagsBits.ModerateMembers,kick:PermissionFlagsBits.KickMembers,ban:PermissionFlagsBits.BanMembers};
  if(!req.guild.members.me?.permissions.has(required[b.action]))throw bad('Bot tidak memiliki izin untuk tindakan ini.',403);
  ModerationService.assertModerationHierarchy(req.member,target,b.action);
  let result;
  if(b.action==='warn'){
   result=await WarningService.addWarning({guildId:req.guild.id,userId:target.id,moderatorId:req.member.id,reason:b.reason});
   await logModerationAction({client,guild:req.guild,event:{action:'User Warned',target:`${target.user.tag} (${target.id})`,executor:`${req.member.user.tag} (${req.member.id})`,reason:b.reason,metadata:{userId:target.id,moderatorId:req.member.id,warningId:result.id}}});
  }else if(b.action==='timeout')result=await ModerationService.timeoutUser({guild:req.guild,member:target,moderator:req.member,reason:b.reason,durationMs:b.minutes*60000});
  else if(b.action==='kick')result=await ModerationService.kickUser({guild:req.guild,member:target,moderator:req.member,reason:b.reason});
  else result=await ModerationService.banUser({guild:req.guild,user:target.user,moderator:req.member,reason:b.reason});
  res.json({ok:true,caseId:result?.caseId||null});
 }catch(e){fail(res,e)}});
 router.get('/tickets',auth,async(req,res)=>{try{const sqlite=sqliteBackend(client);let rows;if(sqlite){const prefix=`guild:${req.guild.id}:ticket:`;rows=sqlite.botTickets(req.guild.id,100).map(x=>({channel_id:x.key.slice(prefix.length),data:x.value}));}else rows=(await pool(client).query(`SELECT channel_id,data FROM ${tables.tickets} WHERE guild_id=$1 ORDER BY updated_at DESC LIMIT 100`,[req.guild.id])).rows;res.json({tickets:rows.map(x=>({channelId:x.channel_id,userId:x.data?.userId,status:x.data?.status,createdAt:x.data?.createdAt,claimedBy:x.data?.claimedBy}))});}catch(e){fail(res,e)}});
 async function ticket(client,guild,id){if(!idRe.test(id))throw bad('ID tiket tidak valid.');const sqlite=sqliteBackend(client);if(sqlite){const data=sqlite.botGet(`guild:${guild.id}:ticket:${id}`);if(data===null)throw bad('Tiket tidak ditemukan.',404);return data;}const r=await pool(client).query(`SELECT data FROM ${tables.tickets} WHERE guild_id=$1 AND channel_id=$2`,[guild.id,id]);if(!r.rows[0])throw bad('Tiket tidak ditemukan.',404);return r.rows[0].data;}
 router.get('/tickets/:id',auth,async(req,res)=>{try{const data=await ticket(client,req.guild,req.params.id);res.json({ticket:data});}catch(e){fail(res,e)}});
 router.get('/tickets/:id/transcript',auth,async(req,res)=>{try{
  await ticket(client,req.guild,req.params.id);const c=req.guild.channels.cache.get(req.params.id);if(!c?.messages)throw bad('Channel tiket tidak tersedia; transcript tersimpan tidak tersedia.',404);
  if(!c.permissionsFor(req.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw bad('Bot tidak memiliki izin membaca channel tiket.',403);
  const m=await c.messages.fetch({limit:100});res.json({messages:[...m.values()].reverse().map(x=>({id:x.id,author:x.author?.tag||'Unknown',at:x.createdAt,content:String(x.content||'').slice(0,4000),attachments:[...x.attachments.values()].map(a=>({name:a.name})).slice(0,10)})),limit:100});
 }catch(e){fail(res,e)}});
 router.post('/tickets/:id/action',auth,csrf,async(req,res)=>{try{
  const b=req.body;if(!b||b.confirmed!==true||!['close','reopen','claim'].includes(b.action)||Object.keys(b).some(k=>!['action','confirmed'].includes(k)))throw bad('Tindakan atau konfirmasi tidak valid.');
  const data=await ticket(client,req.guild,req.params.id),channel=req.guild.channels.cache.get(req.params.id);if(!channel)throw bad('Channel tiket tidak tersedia.',404);
  if(b.action==='close' && data.status!=='open')throw bad('Tiket tidak terbuka.');if(b.action==='reopen' && data.status!=='closed')throw bad('Tiket tidak tertutup.');if(b.action==='claim'&&data.status!=='open')throw bad('Tiket tidak terbuka.');
  if(b.action==='close')await closeTicket(channel,req.member.user,'Ditutup melalui dashboard');else if(b.action==='reopen')await reopenTicket(channel,req.member.user);else await claimTicket(channel,req.member.user);res.json({ok:true});
 }catch(e){fail(res,e)}});
 router.get('/public/leaderboard',async(req,res)=>{try{
  if(!client.isReady?.()||!client.guilds.cache.has(client.homeGuildId))throw bad('Server tidak tersedia.',503);
  const sqlite=sqliteBackend(client);let leaderboard;
  if(sqlite){if(sqlite.botGet(`guild:${client.homeGuildId}:config`)?.publicLeaderboard!==true)throw bad('Leaderboard publik tidak diaktifkan.',404);leaderboard=sqliteLeaderboard(sqlite,client.homeGuildId);}
  else{const db=pool(client),config=await db.query(`SELECT config FROM ${tables.guilds} WHERE id=$1`,[client.homeGuildId]);if(config.rows[0]?.config?.publicLeaderboard!==true)throw bad('Leaderboard publik tidak diaktifkan.',404);const rows=await db.query(`SELECT user_id,level,total_xp FROM ${tables.user_levels} WHERE guild_id=$1 AND total_xp>0 ORDER BY total_xp DESC LIMIT 50`,[client.homeGuildId]);leaderboard=rows.rows.map(x=>({userId:x.user_id,level:x.level,totalXp:Number(x.total_xp)}));}
  res.json({guild:client.guilds.cache.get(client.homeGuildId).name,leaderboard});
 }catch(e){fail(res,e)}});
 router.get('/leaderboard',auth,async(req,res)=>{try{const sqlite=sqliteBackend(client);if(sqlite)return res.json({leaderboard:sqliteLeaderboard(sqlite,req.guild.id)});const r=await pool(client).query(`SELECT user_id,level,total_xp FROM ${tables.user_levels} WHERE guild_id=$1 AND total_xp>0 ORDER BY total_xp DESC LIMIT 50`,[req.guild.id]);res.json({leaderboard:r.rows.map(x=>({userId:x.user_id,level:x.level,totalXp:Number(x.total_xp)}))});}catch(e){fail(res,e)}});
 router.get('/members/:id',auth,async(req,res)=>{try{
  if(!idRe.test(req.params.id))throw bad('ID anggota tidak valid.');const member=await req.guild.members.fetch({user:req.params.id,force:true}).catch(()=>null);if(!member)throw bad('Anggota tidak ditemukan.',404);
  const sqlite=sqliteBackend(client);if(sqlite){const view={botGet:sqlite.botGet,get:sqlite.get,getAccount:sqlite.getAccount},eco=readSQLiteBotValue(view,`guild:${req.guild.id}:economy:${member.id}`),lvl=readSQLiteBotValue(view,`guild:${req.guild.id}:leveling:users:${member.id}`);return res.json({member:{id:member.id,name:member.user.tag},economy:eco?{wallet:Number(eco.wallet??eco.balance??0),bank:Number(eco.bank??0),bankCapacity:getMaxBankCapacity(eco)}:null,level:lvl?{level:lvl.level??0,xp:Number(lvl.xp??0),totalXp:Number(lvl.totalXp??0)}:null});}
  const db=pool(client);const [eco,lvl]=await Promise.all([db.query(`SELECT balance,bank,data FROM ${tables.economy} WHERE guild_id=$1 AND user_id=$2`,[req.guild.id,member.id]),db.query(`SELECT xp,level,total_xp FROM ${tables.user_levels} WHERE guild_id=$1 AND user_id=$2`,[req.guild.id,member.id])]);
  const row=eco.rows[0];res.json({member:{id:member.id,name:member.user.tag},economy:row?{wallet:Number(row.data?.wallet??row.balance),bank:Number(row.data?.bank??row.bank),bankCapacity:getMaxBankCapacity(row.data||{})}:null,level:lvl.rows[0]?{level:lvl.rows[0].level,xp:Number(lvl.rows[0].xp),totalXp:Number(lvl.rows[0].total_xp)}:null});
 }catch(e){fail(res,e)}});
 router.post('/members/:id',auth,csrf,async(req,res)=>{try{
  const b=req.body;if(!idRe.test(req.params.id)||!b||b.confirmed!==true||!['wallet','bank','level'].includes(b.type)||!Number.isSafeInteger(b.value)||b.value<0||!Number.isSafeInteger(b.expected)||b.expected<0||Object.keys(b).some(k=>!['type','value','expected','confirmed'].includes(k)))throw bad('Data atau konfirmasi tidak valid.');
  if((b.type==='level'&&b.value>1000)||(['wallet','bank'].includes(b.type)&&b.value>1000000000000))throw bad('Nilai di luar batas.');
  const member=await req.guild.members.fetch({user:req.params.id,force:true}).catch(()=>null);if(!member)throw bad('Anggota tidak ditemukan.',404);
  const sqlite=sqliteBackend(client);if(sqlite){if(client.homeGuildId&&client.homeGuildId!==req.guild.id)throw bad('Server tidak valid.',403);sqlite.transaction(tx=>{
   if(b.type==='wallet'||b.type==='bank'){const data=readSQLiteBotValue(tx,`guild:${req.guild.id}:economy:${member.id}`);if(!data)throw bad('Data ekonomi belum tersedia.',404);if(!Number.isSafeInteger(data.wallet)||data.wallet<0||!Number.isSafeInteger(data.bank)||data.bank<0)throw bad('Saldo ekonomi tidak valid.',503);if(data[b.type]!==b.expected)throw bad('Saldo berubah; muat ulang sebelum menyimpan.',409);if(b.type==='bank'&&b.value>getMaxBankCapacity(data))throw bad('Saldo melebihi kapasitas bank anggota.');data[b.type]=b.value;tx.setAccount(req.guild.id,member.id,data);}
   else{mutateLevelInTransaction(tx,req.guild.id,member.id,(data,exists)=>{if(!exists)throw bad('Data leveling belum tersedia.',404);if(data.level!==b.expected)throw bad('Level berubah; muat ulang sebelum menyimpan.',409);data.level=b.value;data.xp=0;data.totalXp=calculateTotalXp(b.value,0);return {result:true}});}
  });console.info(`[dashboard] member update guild=${req.guild.id} moderator=${req.member.id} member=${member.id} type=${b.type}`);return res.json({ok:true});}
  const db=pool(client);await Mutex.runExclusive(`dashboard-member:${req.guild.id}:${member.id}`,async()=>{
   const c=await db.connect();try{await c.query('BEGIN');
    if(b.type==='wallet'||b.type==='bank'){
     const r=await c.query(`SELECT balance,bank,data FROM ${tables.economy} WHERE guild_id=$1 AND user_id=$2 FOR UPDATE`,[req.guild.id,member.id]);if(!r.rows[0])throw bad('Data ekonomi belum tersedia.',404);
     const row=r.rows[0], data={...(row.data||{})};let wallet=Number(data.wallet??row.balance),bank=Number(data.bank??row.bank);const old=b.type==='wallet'?wallet:bank;if(old!==b.expected)throw bad('Saldo berubah; muat ulang sebelum menyimpan.',409);
     if(b.type==='bank'&&b.value>getMaxBankCapacity(data))throw bad('Saldo melebihi kapasitas bank anggota.');
     if(b.type==='wallet')wallet=b.value;else bank=b.value;data.wallet=wallet;data.bank=bank;await c.query(`UPDATE ${tables.economy} SET balance=$3,bank=$4,data=$5::jsonb,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND user_id=$2`,[req.guild.id,member.id,wallet,bank,JSON.stringify(data)]);
    } else {
     const r=await c.query(`SELECT level FROM ${tables.user_levels} WHERE guild_id=$1 AND user_id=$2 FOR UPDATE`,[req.guild.id,member.id]);if(!r.rows[0])throw bad('Data leveling belum tersedia.',404);if(Number(r.rows[0].level)!==b.expected)throw bad('Level berubah; muat ulang sebelum menyimpan.',409);
     await c.query(`UPDATE ${tables.user_levels} SET level=$3,xp=0,total_xp=$4,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND user_id=$2`,[req.guild.id,member.id,b.value,calculateTotalXp(b.value,0)]);
    }
    await c.query('COMMIT');console.info(`[dashboard] member update guild=${req.guild.id} moderator=${req.member.id} member=${member.id} type=${b.type}`);
   }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
  });res.json({ok:true});
 }catch(e){fail(res,e)}});
 router.get('/logs',auth,async(req,res)=>{try{
  const sqlite=sqliteBackend(client);const config=sqlite?sqlite.botGet(`guild:${req.guild.id}:config`):(await pool(client).query(`SELECT config FROM ${tables.guilds} WHERE id=$1`,[req.guild.id])).rows[0]?.config;const id=config?.logging?.channels?.audit;
  if(!id)throw bad('Channel audit logging belum dikonfigurasi.',404);const channel=req.guild.channels.cache.get(id);if(!channel?.messages||!channel.permissionsFor(req.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw bad('Bot tidak dapat membaca channel audit.',403);
  const m=await channel.messages.fetch({limit:100});res.json({logs:[...m.values()].filter(x=>x.author?.id===client.user.id).slice(0,50).map(x=>({id:x.id,at:x.createdAt,title:x.embeds?.[0]?.title||'Log',description:x.embeds?.[0]?.description||x.content||''}))});
 }catch(e){fail(res,e)}});
 router.get('/music',auth,(req,res)=>{const player=getPlayer(client,req.guild.id);const channels=[...req.guild.channels.cache.values()];res.json({voiceChannels:channels.filter(c=>c.type===ChannelType.GuildVoice).map(c=>({id:c.id,name:c.name})),textChannels:channels.filter(c=>c.type===ChannelType.GuildText).map(c=>({id:c.id,name:c.name})),available:!!client.riffy?.nodeMap && [...client.riffy.nodeMap.values()].some(n=>n.connected),active:!!player,paused:!!player?.paused,voiceChannel:player?.voiceChannel||null,current:track(player?.current),queue:player?.queue?[...player.queue].slice(0,50).map(track):[],volume:player?getGuildMusicData(req.guild.id).volume:null,loop:getGuildMusicData(req.guild.id).loop,twentyFourSeven:getGuildMusicData(req.guild.id).twentyFourSeven});});
 router.post('/music/search',auth,csrf,async(req,res)=>{try{
  const b=req.body;if(!b||Object.keys(b).length!==1)throw bad('Pencarian tidak valid.');const query=safeMusicQuery(b.query);
  if(!client.riffy?.nodeMap||![...client.riffy.nodeMap.values()].some(x=>x.connected))throw bad('Lavalink tidak tersedia.',503);
  const data=await client.riffy.resolve({query,requester:req.member.user});res.json({tracks:(data.tracks||[]).slice(0,10).map(track)});
 }catch(e){fail(res,e)}});
 router.post('/music',auth,csrf,async(req,res)=>{try{
  const b=req.body;if(!b||!['pause','resume','skip','stop','volume','play','loop','always'].includes(b.action)||b.confirmed!==true||Object.keys(b).some(k=>!['action','confirmed','volume','query','voiceChannelId','textChannelId','mode','enabled'].includes(k)))throw bad('Tindakan atau konfirmasi tidak valid.');
  const p=getPlayer(client,req.guild.id),g=req.guild.id;if(!p && b.action!=='play')throw bad('Belum ada player aktif.',409);
  if(b.action==='pause'){if(!await applyPause(client,g))throw bad('Tidak ada lagu yang dapat dijeda.');}
  if(b.action==='resume'){if(!await applyResume(client,g))throw bad('Tidak ada lagu yang dapat dilanjutkan.');}
  if(b.action==='skip'){if(!p.current)throw bad('Tidak ada lagu aktif.');if(p.loop==='track')p.setLoop('none');p.stop();}
  if(b.action==='stop')await destroyPlayerSession(client,g,p,getGuildMusicData(g));
  if(b.action==='volume'){if(!Number.isInteger(b.volume)||b.volume<0||b.volume>100)throw bad('Volume harus 0–100.');p.setVolume(b.volume);getGuildMusicData(g).volume=b.volume;}
  if(b.action==='loop'){if(!['none','track','queue'].includes(b.mode))throw bad('Mode loop tidak valid.');p.setLoop(b.mode);getGuildMusicData(g).loop=b.mode;}
  if(b.action==='always'){if(typeof b.enabled!=='boolean')throw bad('Nilai 24/7 tidak valid.');getGuildMusicData(g).twentyFourSeven=b.enabled;}
  if(b.action==='play'){
   const query=safeMusicQuery(b.query);
   const voice=req.guild.channels.cache.get(p?.voiceChannel||b.voiceChannelId),text=req.guild.channels.cache.get(p?.textChannel||b.textChannelId);
   if(!voice || voice.type!==ChannelType.GuildVoice || !text || text.type!==ChannelType.GuildText)throw bad('Pilih channel voice dan teks server yang valid.');
   if(!voice.permissionsFor(req.guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw bad('Bot tidak memiliki izin voice yang diperlukan.',403);
   await playQuery(client,{guild:req.guild,member:{voice:{channel:voice}},channel:{id:text.id},user:req.member.user},query);
  }
  res.json({ok:true});
 }catch(e){fail(res,e)}});
 return router;
}
