import express from 'express';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { pgConfig } from '../config/database/postgres.js';
import { sqliteBackend } from '../services/storage/sqlite.js';
import { unwrapReplitData } from '../utils/database/guildConfigStorage.js';
import { normalizeGuildConfig } from '../utils/schemas.js';
import { GUILD_CONFIG_DEFAULTS } from '../config/guild/guildConfigDefaults.js';
import { EVENT_TYPES } from '../services/loggingService.js';
import { messageHasPanelMarker } from '../utils/panelStatus.js';
import { Mutex } from '../utils/mutex.js';

const tables=pgConfig.tables;
const events=[...new Set(Object.values(EVENT_TYPES))];
const groups=[...new Set(events.map(x=>x.split('.')[0]))];
const LEVEL_DEFAULTS={enabled:true,xpPerMessage:{min:15,max:25},xpCooldown:20,levelUpMessage:'{user} has leveled up to level {level}!',levelUpChannel:null,ignoredChannels:[],ignoredRoles:[],blacklistedUsers:[],roleRewards:{},announceLevelUp:true,xpMultiplier:1};
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
function pool(client){const db=client.db;if(!db || db.getStatus?.().isDegraded || !db.isAvailable?.() || !db.db?.isAvailable?.() || !db.db.pool) throw bad('Database persisten tidak tersedia.',503);return db.db.pool;}
async function read(client,id){const sqlite=sqliteBackend(client);if(sqlite)return normalizeGuildConfig(unwrapReplitData(sqlite.botGet(`guild:${id}:config`)||{}),GUILD_CONFIG_DEFAULTS);const rows=await pool(client).query(`SELECT config FROM ${tables.guilds} WHERE id=$1`,[id]);return normalizeGuildConfig(unwrapReplitData(rows.rows[0]?.config || {}),GUILD_CONFIG_DEFAULTS);}
async function transaction(client,id,fn,includeWelcome=false) {
 const sqlite=sqliteBackend(client);if(sqlite)return sqlite.transaction(tx=>{
  const key=`guild:${id}:config`,raw=tx.botGet(key)||{};if(raw.ok!==undefined&&raw.value!==undefined)throw bad('Format konfigurasi lama perlu dimigrasi.',409);
  const config=normalizeGuildConfig(raw,GUILD_CONFIG_DEFAULTS),welcome=includeWelcome?unwrapReplitData(tx.botGet(`guild:${id}:welcome`)||{}):null;
  const result=fn(config,welcome);if(result&&typeof result.then==='function')throw bad('Mutasi konfigurasi harus sinkron.',503);tx.botSet(key,config);return result;
 });
 const conn=await pool(client).connect();try{
  await conn.query('BEGIN');await conn.query(`INSERT INTO ${tables.guilds} (id,created_at) VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,[id]);
  const rows=await conn.query(`SELECT config FROM ${tables.guilds} WHERE id=$1 FOR UPDATE`,[id]);const raw=rows.rows[0]?.config||{};
  if(raw.ok!==undefined && raw.value!==undefined)throw bad('Format konfigurasi lama perlu dimigrasi.',409);
  const config=normalizeGuildConfig(raw,GUILD_CONFIG_DEFAULTS);const welcome=includeWelcome?unwrapReplitData((await conn.query(`SELECT config FROM ${tables.welcome_configs} WHERE guild_id=$1 FOR UPDATE`,[id])).rows[0]?.config||{}):null;
  const result=fn(config,welcome);if(result&&typeof result.then==='function')throw bad('Mutasi konfigurasi harus sinkron.',503);
  await conn.query(`UPDATE ${tables.guilds} SET config=$2::jsonb, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,[id,JSON.stringify(config)]);await conn.query('COMMIT');return result;
 }catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e;}finally{conn.release();}
}
function listChannels(guild,type=ChannelType.GuildText){return [...guild.channels.cache.values()].filter(c=>c.type===type).map(({id,name})=>({id,name}));}
function listStaffRoles(guild){return [...guild.roles.cache.values()].filter(r=>r.id!==guild.id && !r.managed).map(({id,name})=>({id,name}));}
function listRoles(guild){const me=guild.members.me;return [...guild.roles.cache.values()].filter(r=>r.id!==guild.id && !r.managed && me?.permissions.has(PermissionFlagsBits.ManageRoles) && me.roles.highest.comparePositionTo(r)>0).map(({id,name})=>({id,name}));}
function channelId(guild,id,type=ChannelType.GuildText){if(id===null)return null;if(typeof id!=='string'||guild.channels.cache.get(id)?.type!==type)throw bad('Channel tidak valid untuk server ini.');return id;}
function roleId(guild,id){if(id===null)return null;if(!listRoles(guild).some(r=>r.id===id))throw bad('Role tidak dapat dikelola bot atau tidak tersedia.');return id;}
function exact(b,keys){if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length!==keys.length||Object.keys(b).some(x=>!keys.includes(x)))throw bad('Data tidak valid.');}
function str(v,min,max){if(typeof v!=='string'||v.length>max||v.trim().length<min)throw bad('Teks tidak valid atau terlalu panjang.');return v;}
function bool(v){if(typeof v!=='boolean')throw bad('Nilai boolean tidak valid.');return v;}
function number(v,min,max){if(!Number.isInteger(v)||v<min||v>max)throw bad('Angka di luar rentang.');return v;}
function answer(res,error){if(!error.status)console.error('[dashboard modules]',error.message);res.status(error.status||503).json({error:error.status?error.message:'Gagal mengakses database atau Discord.'});}
const channelsRoles=guild=>({channels:listChannels(guild),categories:listChannels(guild,ChannelType.GuildCategory),roles:listRoles(guild)});

export function createModulesApi(client,{auth,csrf}) {
 const router=express.Router();router.use(express.json({limit:'32kb'}));
 router.get('/settings/:kind',auth,async(req,res)=>{try{
  if(!['verification','logging','leveling','ticket','economy'].includes(req.params.kind))throw bad('Modul tidak tersedia.',404);
  const cfg=await read(client,req.guild.id);const kind=req.params.kind;
  let data;
  if(kind==='verification')data=cfg.verification||{enabled:false};
  if(kind==='logging')data=cfg.logging;
  if(kind==='leveling')data={...LEVEL_DEFAULTS,...(cfg.leveling||{}),publicLeaderboard:cfg.publicLeaderboard===true};
  if(kind==='economy')data={premiumRoleId:cfg.premiumRoleId||null};
  if(kind==='ticket')data={channelId:cfg.ticketPanelChannelId||null,messageId:cfg.ticketPanelMessageId||null,staffRoleId:cfg.ticketStaffRoleId||null,categoryId:cfg.ticketCategoryId||null,closedCategoryId:cfg.ticketClosedCategoryId||null,message:cfg.ticketPanelMessage||'Click the button below to create a support ticket.',buttonText:cfg.ticketButtonLabel||'Create Ticket',logsChannelId:cfg.ticketLogsChannelId||null,transcriptChannelId:cfg.ticketTranscriptChannelId||null,maxTicketsPerUser:cfg.maxTicketsPerUser||3,dmOnClose:cfg.dmOnClose!==false};
  res.json({settings:data,...channelsRoles(req.guild),...(['ticket','economy'].includes(kind)?{roles:listStaffRoles(req.guild)}:{}),events,groups});
 }catch(e){answer(res,e)}});
 router.patch('/settings/:kind',auth,csrf,async(req,res)=>{try{
  const b=req.body,g=req.guild,kind=req.params.kind;let updated;
  if(kind==='verification'){
   exact(b,['enabled','channelId','roleId','message','buttonText']);bool(b.enabled);channelId(g,b.channelId);roleId(g,b.roleId);str(b.message,1,2000);str(b.buttonText,1,80);
   if(b.enabled && (!b.channelId||!b.roleId))throw bad('Channel dan role wajib dipilih.');
   updated=await transaction(client,g.id,(cfg,w)=>{
    const previous=cfg.verification||{};
    if(previous.messageId && previous.channelId!==b.channelId)throw bad('Panel lama masih tercatat. Hapus atau pindahkan melalui Discord terlebih dahulu.',409);
    if(b.enabled&&(cfg.autoRole || w.roleIds?.length || previous.autoVerify?.enabled))throw bad('Nonaktifkan autorole dan auto-verify sebelum verification.',409);
    cfg.verification={...previous,...b};return cfg.verification;
   },b.enabled);
  } else if(kind==='logging'){
   exact(b,['enabled','channels','enabledEvents']);bool(b.enabled);exact(b.channels,['audit','applications','reports']);Object.values(b.channels).forEach(x=>channelId(g,x));
   if(!b.enabledEvents||typeof b.enabledEvents!=='object'||Array.isArray(b.enabledEvents)||Object.entries(b.enabledEvents).some(([k,v])=>!([...events,...groups.map(x=>x+'.*')].includes(k))||typeof v!=='boolean'))throw bad('Event logging tidak valid.');
   updated=await transaction(client,g.id,cfg=>{cfg.logging={...(cfg.logging||{}),enabled:b.enabled,channels:{...cfg.logging?.channels,...b.channels},enabledEvents:{...cfg.logging?.enabledEvents,...b.enabledEvents}};return cfg.logging});
  } else if(kind==='leveling'){
   const required=['enabled','min','max','cooldown','channelId','announce','publicLeaderboard'];
   const optional=['levelUpMessage','ignoredChannels','ignoredRoles','roleRewards'];
   if (!b || typeof b!=='object' || Array.isArray(b) || required.some(k=>!(k in b)) || Object.keys(b).some(k=>!required.includes(k)&&!optional.includes(k))) throw bad('Data tidak valid.');
   if ('levelUpMessage' in b) str(b.levelUpMessage,1,2000);
   if ('ignoredChannels' in b) { if(!Array.isArray(b.ignoredChannels)||b.ignoredChannels.length>100||new Set(b.ignoredChannels).size!==b.ignoredChannels.length)throw bad('Daftar channel tidak valid.'); b.ignoredChannels.forEach(id=>{if(id===null)throw bad('Channel tidak valid.');channelId(g,id)}); }
   if ('ignoredRoles' in b) { if(!Array.isArray(b.ignoredRoles)||b.ignoredRoles.length>100||new Set(b.ignoredRoles).size!==b.ignoredRoles.length||b.ignoredRoles.some(id=>typeof id!=='string'||!g.roles.cache.has(id)||id===g.id))throw bad('Daftar role tidak valid.'); }
   if ('roleRewards' in b) { if(!b.roleRewards||typeof b.roleRewards!=='object'||Array.isArray(b.roleRewards)||Object.keys(b.roleRewards).length>100)throw bad('Role reward tidak valid.'); for(const [level,id] of Object.entries(b.roleRewards)){if(!/^[1-9]\d{0,2}$/.test(level)||Number(level)>500||id===null)throw bad('Level reward harus 1–500.');roleId(g,id);} }
   bool(b.enabled);bool(b.announce);bool(b.publicLeaderboard);number(b.min,1,10000);number(b.max,1,10000);number(b.cooldown,1,3600);channelId(g,b.channelId);if(b.min>b.max)throw bad('XP minimum melebihi maksimum.');
   updated=await transaction(client,g.id,cfg=>{cfg.publicLeaderboard=b.publicLeaderboard;cfg.leveling={...LEVEL_DEFAULTS,...(cfg.leveling||{}),...Object.fromEntries(optional.filter(k=>k in b).map(k=>[k,b[k]])),enabled:b.enabled,xpPerMessage:{min:b.min,max:b.max},xpRange:{min:b.min,max:b.max},xpCooldown:b.cooldown,levelUpChannel:b.channelId,announceLevelUp:b.announce};return cfg.leveling});
  } else if(kind==='economy'){
   exact(b,['premiumRoleId']);if(b.premiumRoleId!==null && !listStaffRoles(g).some(r=>r.id===b.premiumRoleId))throw bad('Role premium tidak tersedia.');
   updated=await transaction(client,g.id,cfg=>{cfg.premiumRoleId=b.premiumRoleId;return {premiumRoleId:cfg.premiumRoleId}});
  } else if(kind==='ticket'){
   exact(b,['channelId','staffRoleId','categoryId','closedCategoryId','message','buttonText','logsChannelId','transcriptChannelId','maxTicketsPerUser','dmOnClose']);channelId(g,b.channelId);if(b.staffRoleId!==null && !listStaffRoles(g).some(r=>r.id===b.staffRoleId))throw bad('Role staf tidak tersedia.');channelId(g,b.categoryId,ChannelType.GuildCategory);channelId(g,b.closedCategoryId,ChannelType.GuildCategory);str(b.message,1,2000);str(b.buttonText,1,80);channelId(g,b.logsChannelId);channelId(g,b.transcriptChannelId);number(b.maxTicketsPerUser,1,50);bool(b.dmOnClose);
   updated=await transaction(client,g.id,cfg=>{if(cfg.ticketPanelMessageId && cfg.ticketPanelChannelId!==b.channelId)throw bad('Panel lama masih tercatat di channel lain.',409);Object.assign(cfg,{ticketPanelChannelId:b.channelId,ticketStaffRoleId:b.staffRoleId,ticketCategoryId:b.categoryId,ticketClosedCategoryId:b.closedCategoryId,ticketPanelMessage:b.message,ticketButtonLabel:b.buttonText,ticketLogsChannelId:b.logsChannelId,ticketTranscriptChannelId:b.transcriptChannelId,maxTicketsPerUser:b.maxTicketsPerUser,dmOnClose:b.dmOnClose});return {ok:true}});
  } else throw bad('Modul tidak tersedia.',404);
  res.json({ok:true,settings:updated});
 }catch(e){answer(res,e)}});
 router.post('/panel/:kind',auth,csrf,async(req,res)=>{try{
  exact(req.body,['confirmed']);if(req.body.confirmed!==true)throw bad('Konfirmasi diperlukan.');
  const kind=req.params.kind;if(!['verification','ticket'].includes(kind))throw bad('Panel tidak tersedia.',404);
  const result=await Mutex.runExclusive(`web-panel:${kind}:${req.guild.id}`,async()=>{
   const cfg=await read(client,req.guild.id); const v=kind==='verification'?cfg.verification:cfg;
   const cid=kind==='verification'?v?.channelId:v?.ticketPanelChannelId, mid=kind==='verification'?v?.messageId:v?.ticketPanelMessageId;
   if(kind==='verification'&&!v?.enabled)throw bad('Aktifkan dan simpan verification sebelum mengirim panel.');
   const channel=req.guild.channels.cache.get(cid), me=req.guild.members.me;
   if(!channel || channel.type!==ChannelType.GuildText || !me)throw bad('Channel panel tidak tersedia.');
   if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory]))throw bad('Bot memerlukan izin View Channel, Send Messages, Embed Links, dan Read Message History.',403);
   const marker=kind==='verification'?'verify_user':'create_ticket';let msg=null;
   if(mid){try{msg=await channel.messages.fetch(mid)}catch(e){if(e.code!==10008)throw bad('Panel lama tidak dapat diperiksa. Tidak membuat panel baru.',409)}
    if(msg && (msg.author?.id!==client.user.id || !messageHasPanelMarker(msg,{buttonCustomId:marker})))throw bad('Pesan lama bukan panel bot yang sesuai.',409);
   }
   if (!msg) {const recent=await channel.messages.fetch({limit:50});msg=[...recent.values()].find(m=>m.author?.id===client.user.id && messageHasPanelMarker(m,{buttonCustomId:marker}))||null;}
   const body=kind==='verification'?{embeds:[new EmbedBuilder().setTitle('Server Verification').setDescription(v.message||'Click the button below to verify.').setColor(0x57f287)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(marker).setLabel(v.buttonText||'Verify').setStyle(ButtonStyle.Success).setEmoji('✅'))],allowedMentions:{parse:[]}}:{embeds:[new EmbedBuilder().setTitle('Support Tickets').setDescription(v.ticketPanelMessage||'Click to create a ticket.').setColor(0x5865f2)],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(marker).setLabel(v.ticketButtonLabel||'Create Ticket').setStyle(ButtonStyle.Primary).setEmoji('📩'))],allowedMentions:{parse:[]}};
   if(msg){await msg.edit(body);}else{msg=await channel.send(body);}
   try{await transaction(client,req.guild.id,c=>{if(kind==='verification'){if(c.verification?.channelId!==cid)throw bad('Konfigurasi berubah; periksa panel Discord.',409);c.verification={...c.verification,messageId:msg.id};}else{if(c.ticketPanelChannelId!==cid)throw bad('Konfigurasi berubah; periksa panel Discord.',409);c.ticketPanelMessageId=msg.id;}});}catch(e){throw bad('Panel dikirim/diperbarui tetapi ID tidak dapat disimpan. Periksa Discord sebelum mencoba lagi.',409);}
   return {messageId:msg.id};
  });res.json({ok:true,...result});
 }catch(e){answer(res,e)}});
 return router;
}
