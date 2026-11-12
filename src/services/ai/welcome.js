import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { pgConfig } from '../../config/database/postgres.js';
import { buildWelcomePayload } from '../welcomePayload.js';
import { formatWelcomeMessage } from '../../utils/welcome.js';

export const DEFAULT_AI_WELCOME=Object.freeze({enabled:false,toChannel:true,toDm:false,channelId:null,tone:'warm',language:'id',fallback:'Selamat datang {user} di {server}!'});
const invalid=message=>Object.assign(new Error(message),{status:400,code:'INVALID_WELCOME'});
export function validateAIWelcome(v,guild){
 const keys=Object.keys(DEFAULT_AI_WELCOME);
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||!keys.every(k=>Object.hasOwn(v,k)))throw invalid('Pengaturan AI Welcome tidak valid.');
 if(['enabled','toChannel','toDm'].some(k=>typeof v[k]!=='boolean'))throw invalid('Status harus boolean.');
 if(v.channelId!==null&&(typeof v.channelId!=='string'||!/^\d{17,20}$/.test(v.channelId)))throw invalid('ID channel tidak valid.');
 if(guild&&v.channelId!==null&&guild.channels.cache.get(v.channelId)?.type!==ChannelType.GuildText)throw invalid('Pilih channel teks pada server ini.');
 if(v.enabled&&(!v.toChannel&&!v.toDm))throw invalid('Pilih channel atau DM.');
 if(v.enabled&&v.toChannel&&!v.channelId)throw invalid('Pilih channel untuk AI Welcome.');
 if(guild&&v.enabled&&v.toChannel){const channel=guild.channels.cache.get(v.channelId),me=guild.members.me;const perms=me&&channel?.permissionsFor?.(me);if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw invalid('Bot memerlukan izin View Channel dan Send Messages pada channel.');}
 if(!['warm','casual','funny','formal'].includes(v.tone)||!['id','en'].includes(v.language))throw invalid('Gaya atau bahasa tidak valid.');
 if(typeof v.fallback!=='string'||!v.fallback.trim()||v.fallback.length>1000)throw invalid('Template cadangan harus 1–1000 karakter.');
 return {...v};
}
export function createAIWelcomeStore(client){
 const key=id=>`ai:welcome:settings:${id}`,table=pgConfig.tables.cache_data;
 const pool=()=>{const db=client.db;if(!db||db.getStatus?.().isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool)throw new Error('Persistent database unavailable');return db.db.pool;};
 return {async read(id){const r=await pool().query(`SELECT value FROM ${table} WHERE key=$1`,[key(id)]);return r.rows[0]?.value?validateAIWelcome(r.rows[0].value):{...DEFAULT_AI_WELCOME};},async save(id,settings){const v=validateAIWelcome(settings);await pool().query(`INSERT INTO ${table} (key,value,expires_at) VALUES ($1,$2::jsonb,NULL) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=NULL`,[key(id),JSON.stringify(v)]);return v;}};
}
// No guild or user data is sent to the provider; only fixed instructions and validated enum values.
export function welcomePrompt(cfg){return `Write one short, friendly Discord server welcome in ${cfg.language==='id'?'Indonesian':'English'} with a ${cfg.tone} tone. Output only the message. Include the exact placeholders {user} and {server}; do not include URLs, mentions or other placeholders.`;}
export function safeGeneratedTemplate(text){
 if(typeof text!=='string')return null;const s=text.trim();
 if(!s||s.length>1000||!s.includes('{user}')||!s.includes('{server}')||/https?:\/\/|www\.|discord\.gg|<@|@(everyone|here)/i.test(s)||/\{(?!user\}|server\})[^}]*\}/.test(s))return null;
 return s;
}
export async function generateWelcomeTemplate({foundation,guildId,actorId,cfg}){
 try{if(!foundation)throw Error('unavailable');const result=await foundation.generate({guildId,userId:actorId,consent:true,prompt:welcomePrompt(cfg)});const template=safeGeneratedTemplate(result.text);if(!template)throw Error('invalid');return {template,source:'ai'};}catch{return {template:cfg.fallback,source:'fallback'};}
}
// The returned text is rendered locally, after generation, without passing Discord names to AI.
export function renderAIWelcome(template,member){return formatWelcomeMessage(template,{member,user:member.user,guild:member.guild}).slice(0,1900);}
export async function deliverJoinWelcome(member,legacyConfig,{store,foundation}={}){
 const guild=member.guild, client=member.client;
 if(!guild||!client||guild.id!==client.homeGuildId)return {source:'blocked'};
 let cfg;try{cfg=await (store||createAIWelcomeStore(client)).read(guild.id);}catch{cfg={...DEFAULT_AI_WELCOME};}
 if(!cfg.enabled){
  if(!legacyConfig?.enabled||!legacyConfig.channelId)return {source:'disabled'};
  const ch=guild.channels.cache.get(legacyConfig.channelId),me=guild.members.me,perms=ch?.isTextBased?.()&&me?ch.permissionsFor(me):null;
  if(!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))return {source:'legacy-unavailable'};
  await ch.send(buildWelcomePayload({member,config:legacyConfig,canEmbed:perms.has(PermissionFlagsBits.EmbedLinks)}));return {source:'legacy'};
 }
 const channel=cfg.toChannel?guild.channels.cache.get(cfg.channelId):null, me=guild.members.me;
 const perms=channel?.type===ChannelType.GuildText && me?channel.permissionsFor(me):null;
 const canChannel=Boolean(perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]));
 if(!canChannel&&!cfg.toDm)return {source:'unavailable'};
 const generated=await generateWelcomeTemplate({foundation:foundation||client.aiFoundation,guildId:guild.id,actorId:client.user?.id,cfg});
 const content=renderAIWelcome(generated.template,member);const payload={content,allowedMentions:{parse:[]}};
 const sends=[];if(canChannel)sends.push(Promise.resolve().then(()=>channel.send(payload)));if(cfg.toDm)sends.push(Promise.resolve().then(()=>member.send(payload)));
 const results=await Promise.allSettled(sends);return {source:generated.source,sent:results.filter(r=>r.status==='fulfilled').length,failed:results.filter(r=>r.status==='rejected').length+(cfg.toChannel&&!canChannel?1:0)};
}
