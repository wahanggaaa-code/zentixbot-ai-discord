import crypto from 'node:crypto';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const snowflake=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const allowed={ViewChannel:PermissionFlagsBits.ViewChannel,SendMessages:PermissionFlagsBits.SendMessages,ReadMessageHistory:PermissionFlagsBits.ReadMessageHistory,AddReactions:PermissionFlagsBits.AddReactions,EmbedLinks:PermissionFlagsBits.EmbedLinks,AttachFiles:PermissionFlagsBits.AttachFiles,Connect:PermissionFlagsBits.Connect,Speak:PermissionFlagsBits.Speak,Stream:PermissionFlagsBits.Stream,UseVAD:PermissionFlagsBits.UseVAD};
const allowedMask=Object.values(allowed).reduce((a,b)=>a|b,0n);
const permissionNames=bits=>Object.entries(allowed).filter(([,v])=>(BigInt(bits)&v)!==0n).map(([k])=>k);
const channelTypes=new Set([ChannelType.GuildText,ChannelType.GuildVoice,ChannelType.GuildCategory]);
function state(obj,kind){return kind==='role'?{kind,id:obj.id,name:obj.name,permissions:String(obj.permissions.bitfield)}:{kind,id:obj.id,name:obj.name,type:obj.type,parentId:obj.parentId??null};}
function equal(a,b){return JSON.stringify(a)===JSON.stringify(b);}
function checkName(name,kind,type){if(typeof name!=='string'||!name.trim()||name.length>40||/[@<>\r\n]/.test(name))throw fail('Nama tidak valid.');if(kind==='channel'&&type!==ChannelType.GuildCategory&&!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name))throw fail('Nama channel harus berupa huruf kecil ASCII, angka, - atau _.');if((kind==='role'||type===ChannelType.GuildCategory)&&!/^[\p{L}\p{N}_ .-]+$/u.test(name))throw fail('Nama tidak valid.');return name.trim();}
function validatedPermissions(names){if(!Array.isArray(names)||names.length>Object.keys(allowed).length||new Set(names).size!==names.length||names.some(n=>typeof n!=='string'||!Object.hasOwn(allowed,n)))throw fail('Pilihan izin role tidak valid.');return names.reduce((mask,n)=>mask|allowed[n],0n);}
export function createManualBuilder({client,now=Date.now}){
 const tickets=new Map(),active=new Set();
 function purge(){for(const [k,v] of tickets)if(v.expires<=now())tickets.delete(k)}
 function issue(data){purge();if(tickets.size>=50)throw fail('Terlalu banyak tindakan menunggu.',429);const id=crypto.randomBytes(20).toString('hex');tickets.set(id,{...data,expires:now()+300000});return id;}
 function ticket(id,guild,userId,type){purge();const t=tickets.get(id);if(!t||t.type!==type||t.guildId!==guild.id||t.userId!==userId||guild.id!==client.homeGuildId)throw fail('Tinjauan tidak ditemukan atau kedaluwarsa.',404);return t;}
 async function inspect(guild,kind,id,action){
  if(guild.id!==client.homeGuildId||!snowflake(id)||!['role','channel'].includes(kind))throw fail('Target tidak valid.',403);
  const me=await guild.members.fetchMe({force:true});if(!me?.permissions?.has(kind==='role'?PermissionFlagsBits.ManageRoles:PermissionFlagsBits.ManageChannels))throw fail('Izin bot tidak mencukupi.',403);
  if(kind==='role'){
   const role=await guild.roles.fetch(id,{force:true});if(!role||role.id!==id||role.guild?.id!==guild.id||role.id===guild.id||role.managed||role.editable!==true)throw fail('Role tidak tersedia atau tidak aman diubah.',403);
   if((role.permissions.bitfield&~allowedMask)!==0n)throw fail('Role berizin tinggi atau di luar daftar aman tidak dapat dikelola di sini.',403);
   return {object:role,snapshot:state(role,kind)};
  }
  const channel=await guild.channels.fetch(id,{force:true});if(!channel||channel.id!==id||channel.guild?.id!==guild.id||!channelTypes.has(channel.type)||!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels))throw fail('Channel tidak tersedia atau tidak aman diubah.',403);
  if([guild.systemChannelId,guild.rulesChannelId,guild.publicUpdatesChannelId,guild.afkChannelId,guild.widgetChannelId,guild.safetyAlertsChannelId].includes(id))throw fail('Channel sistem tidak dapat dikelola di sini.',403);
  if(action==='delete'&&channel.type===ChannelType.GuildCategory){const all=await guild.channels.fetch();if([...all.values()].some(x=>x?.parentId===id))throw fail('Kategori berisi channel; pindahkan dahulu secara manual.',409);}
  return {object:channel,snapshot:state(channel,kind)};
 }
 function expected(before,action,value){return action==='rename'?{...before,name:value}:action==='permissions'?{...before,permissions:String(value)}:null;}
 return {
  async prepare({guild,userId,kind,targetId,action,value}){
   if(!snowflake(userId)||!['rename','delete','permissions'].includes(action)||action==='permissions'&&kind!=='role')throw fail('Tindakan tidak valid.');
   const {snapshot}=await inspect(guild,kind,targetId,action);let next=null;
   if(action==='rename')next=checkName(value,kind,snapshot.type);
   else if(action==='permissions')next=String(validatedPermissions(value));
   else if(value!==null)throw fail('Tindakan tidak valid.');
   const after=expected(snapshot,action,next);if(after&&equal(snapshot,after))throw fail('Tidak ada perubahan.');
   const id=issue({type:'apply',guildId:guild.id,userId,kind,targetId,action,before:snapshot,after});
   return {id,before:snapshot,after,action,...(kind==='role'?{permissionsBefore:permissionNames(snapshot.permissions),permissionsAfter:after?permissionNames(after.permissions):null}:{}),expiresInSeconds:300,warning:action==='delete'?'PENGHAPUSAN PERMANEN: pesan, pengaturan atau keanggotaan role dapat hilang dan tidak bisa dipulihkan oleh bot.':'Perubahan berlaku di Discord; permission overwrite channel dapat mengubah izin efektif.'};
  },
  async apply({guild,userId,id,confirmation}){
   const t=ticket(id,guild,userId,'apply');if(confirmation!==(t.action==='delete'?`HAPUS ${t.targetId}`:t.targetId))throw fail('Konfirmasi target tidak cocok.');
   if(active.has(guild.id))throw fail('Tindakan lain sedang berjalan.',409);active.add(guild.id);
   try{
    const {object,snapshot}=await inspect(guild,t.kind,t.targetId,t.action);if(!equal(snapshot,t.before))throw fail('Target berubah setelah ditinjau; buat tinjauan baru.',409);
    // One shot even if a Discord timeout leaves the result unknown.
    tickets.delete(id);
    try{if(t.action==='delete')await object.delete('AI builder: owner confirmed permanent deletion');else if(t.action==='rename')await object.setName(t.after.name,'AI builder: owner confirmed rename');else await object.setPermissions(BigInt(t.after.permissions),'AI builder: owner confirmed permissions');}
    catch{throw fail('Discord gagal atau timeout; hasil mungkin berubah. Periksa Discord sebelum mencoba ulang.',409)}
    let undoId=null;if(t.after){try{undoId=issue({type:'undo',guildId:guild.id,userId,kind:t.kind,targetId:t.targetId,action:t.action,before:t.after,after:t.before});}catch{/* action completed; rollback not guaranteed */}}
    return {action:t.action,targetId:t.targetId,undoId,undoExpiresInSeconds:undoId?300:null};
   }finally{active.delete(guild.id)}
  },
  async undo({guild,userId,id,confirmation}){
   const t=ticket(id,guild,userId,'undo');if(confirmation!==t.targetId)throw fail('Konfirmasi target tidak cocok.');if(active.has(guild.id))throw fail('Tindakan lain sedang berjalan.',409);active.add(guild.id);
   try{const {object,snapshot}=await inspect(guild,t.kind,t.targetId,t.action);if(!equal(snapshot,t.before))throw fail('Target berubah setelah tindakan; rollback dibatalkan.',409);tickets.delete(id);
    try{if(t.action==='rename')await object.setName(t.after.name,'AI builder: owner confirmed undo');else await object.setPermissions(BigInt(t.after.permissions),'AI builder: owner confirmed undo');}catch{throw fail('Rollback gagal atau timeout; periksa Discord sebelum tindakan lain.',409)}return {undone:true,targetId:t.targetId};
   }finally{active.delete(guild.id)}
  }
 };
}
export const MANUAL_ROLE_PERMISSIONS=Object.freeze(Object.keys(allowed));
