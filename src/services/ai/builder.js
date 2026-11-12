import crypto from 'node:crypto';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
const err=(message,status=400,created=[])=>Object.assign(new Error(message),{status,created});
const clean=(s,max)=>typeof s==='string'&&s.length<=max&&s.trim().length>0&&!/[@<>\r\n]/.test(s)&&/^[\p{L}\p{N}_ .-]+$/u.test(s);
export function validatePlan(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='categories,roles'||!Array.isArray(v.categories)||v.categories.length<1||v.categories.length>5||!Array.isArray(v.roles)||v.roles.length>5)throw err('Rencana AI tidak valid.');
 let count=0;const cats=new Set(),roles=new Set(),channels=new Set();
 for(const c of v.categories){if(!c||Object.keys(c).sort().join(',')!=='channels,name'||!clean(c.name,40)||!Array.isArray(c.channels)||c.channels.length>8||cats.has(c.name.trim().toLowerCase()))throw err('Kategori tidak valid atau duplikat.');cats.add(c.name.trim().toLowerCase());
  for(const ch of c.channels){if(!ch||Object.keys(ch).sort().join(',')!=='name,type'||typeof ch.name!=='string'||!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(ch.name)||!['text','voice'].includes(ch.type)||channels.has(ch.name.toLowerCase()))throw err('Channel tidak valid atau duplikat.');channels.add(ch.name.toLowerCase());count++;}}
 if(count<1||count>15)throw err('Rencana harus memiliki 1–15 channel.');for(const role of v.roles){if(!clean(role,40)||role.trim().toLowerCase()==='everyone'||roles.has(role.trim().toLowerCase()))throw err('Role tidak valid atau duplikat.');roles.add(role.trim().toLowerCase());}
 return {categories:v.categories.map(c=>({name:c.name.trim(),channels:c.channels.map(ch=>({...ch}))})),roles:v.roles.map(x=>x.trim())};
}
export function createBuilder({client,foundation=client.aiFoundation,now=Date.now}){
 const plans=new Map(),activeGuilds=new Set();
 function purge(){for(const [k,p] of plans)if(p.expires<=now())plans.delete(k)}
 return {
  async draft({guildId,userId,description,consent}){
   if(guildId!==client.homeGuildId||consent!==true)throw err('Server atau persetujuan tidak valid.',403);
   if(typeof description!=='string'||!description.trim()||description.length>1000)throw err('Deskripsi harus 1–1000 karakter.');purge();if(plans.size>=50)throw err('Terlalu banyak rancangan menunggu.',429);
   const prompt=`Buat rancangan struktur Discord berdasarkan deskripsi berikut. Keluarkan hanya JSON dengan format {"categories":[{"name":"Komunitas","channels":[{"name":"umum","type":"text"}]}],"roles":["Member"]}. Maksimum 5 kategori, 15 channel, 5 role. Tipe channel hanya text atau voice; nama channel huruf kecil ASCII, angka, - atau _. Jangan sertakan izin, penghapusan atau teks lain. Deskripsi:\n${description}`;
   const output=await foundation.generate({guildId,userId,consent:true,prompt});let plan;try{plan=validatePlan(JSON.parse(output.text))}catch{throw err('AI tidak menghasilkan struktur valid. Coba lagi.',502)}
   purge();if(plans.size>=50)throw err('Terlalu banyak rancangan menunggu.',429);
   const id=crypto.randomBytes(20).toString('hex');plans.set(id,{guildId,userId,plan,expires:now()+300000});return {id,plan,expiresInSeconds:300};
  },
  async edit({guildId,userId,id,plan}){
   purge();const entry=plans.get(id);if(!entry||entry.userId!==userId||entry.guildId!==guildId||guildId!==client.homeGuildId)throw err('Rancangan tidak ditemukan atau kedaluwarsa.',404);
   const updated=validatePlan(plan);entry.plan=updated;return {plan:updated,expiresInSeconds:Math.max(0,Math.ceil((entry.expires-now())/1000))};
  },
  async apply({guild,userId,id,confirmed}){
   purge();const entry=plans.get(id);if(!entry||entry.userId!==userId||entry.guildId!==guild.id||guild.id!==client.homeGuildId)throw err('Rancangan tidak ditemukan atau kedaluwarsa.',404);if(confirmed!==true)throw err('Konfirmasi penerapan diperlukan.');
   if(activeGuilds.has(guild.id))throw err('Penerapan lain masih berjalan.',409);
   const me=guild.members.me;if(!me?.permissions?.has(PermissionFlagsBits.ManageChannels)||entry.plan.roles.length&&!me.permissions.has(PermissionFlagsBits.ManageRoles))throw err('Bot memerlukan Manage Channels dan Manage Roles sesuai rencana.',403);
   const existing=[...guild.channels.cache.values()];const categories=existing.filter(x=>x.type===ChannelType.GuildCategory);const plannedChannels=entry.plan.categories.reduce((n,c)=>n+c.channels.length,0);
   if(categories.length+entry.plan.categories.length>50||existing.length+entry.plan.categories.length+plannedChannels>500||guild.roles.cache.size+entry.plan.roles.length>250)throw err('Rencana melewati batas server.',409);
   const channelNames=new Set(existing.map(x=>String(x.name||'').toLowerCase())),roleNames=new Set([...guild.roles.cache.values()].map(x=>String(x.name||'').toLowerCase()));
   if(entry.plan.categories.some(c=>channelNames.has(c.name.toLowerCase())||c.channels.some(ch=>channelNames.has(ch.name.toLowerCase())))||entry.plan.roles.some(r=>roleNames.has(r.toLowerCase())))throw err('Nama sudah ada di server. Buat rancangan lain.',409);
   // Consume before the first side effect: no repeat even if Discord later reports an error.
   plans.delete(id);activeGuilds.add(guild.id);const created=[];
   try{for(const category of entry.plan.categories){const parent=await guild.channels.create({name:category.name,type:ChannelType.GuildCategory,reason:'AI builder: owner confirmed'});created.push({type:'category',id:parent.id,name:category.name});for(const ch of category.channels){const result=await guild.channels.create({name:ch.name,type:ch.type==='text'?ChannelType.GuildText:ChannelType.GuildVoice,parent:parent.id,reason:'AI builder: owner confirmed'});created.push({type:ch.type,id:result.id,name:ch.name});}}
    for(const name of entry.plan.roles){const role=await guild.roles.create({name,permissions:0n,mentionable:false,hoist:false,reason:'AI builder: owner confirmed'});created.push({type:'role',id:role.id,name});}return {created};
   }catch{throw err('Penerapan berhenti; sebagian objek mungkin sudah dibuat. Periksa Discord dan daftar hasil sebelum tindakan lain.',409,created)}finally{activeGuilds.delete(guild.id)}
  }
 };
}
