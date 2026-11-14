import { pgConfig } from '../../config/database/postgres.js';
import { sqliteBackend } from '../storage/sqlite.js';

// Endpoints are fixed deliberately: arbitrary provider URLs would allow SSRF and secret exfiltration.
export const PROVIDERS = Object.freeze({
  groq: { url:'https://api.groq.com/openai/v1/chat/completions', key:'AI_GROQ_API_KEY' },
  gemini: { url:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key:'AI_GEMINI_API_KEY' },
  openrouter: { url:'https://openrouter.ai/api/v1/chat/completions', key:'AI_OPENROUTER_API_KEY' },
  nvidia: { url:'https://integrate.api.nvidia.com/v1/chat/completions', key:'AI_NVIDIA_API_KEY' },
});
export const DEFAULT_AI = Object.freeze({ enabled:false, providerDataConsent:false, primary:'groq', primaryModel:'', backup:'none', backupModel:'', backup2:'none', backup2Model:'', backup3:'none', backup3Model:'', perUserDaily:20, guildDaily:200, timeoutSeconds:20, maxOutputTokens:256 });
// Backups are tried in this order after the primary. A slot set to 'none' is skipped, so gaps are allowed.
export const BACKUP_SLOTS = Object.freeze([['backup','backupModel'],['backup2','backup2Model'],['backup3','backup3Model']]);
const ADDED_SLOT_KEYS = BACKUP_SLOTS.slice(1).flat();
/**
 * Settings saved before the second and third backup existed lack those four keys. They are read as
 * "no second or third backup"; anything else about the record is left for validateSettings to judge.
 */
export function upgradeSettings(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||ADDED_SLOT_KEYS.some(k=>Object.hasOwn(v,k)))return v;
 return {...v,...Object.fromEntries(ADDED_SLOT_KEYS.map(k=>[k,DEFAULT_AI[k]]))};
}
/** The providers one request may go through, in order: [providerId, model]. */
export function providerChain(cfg){return [[cfg.primary,cfg.primaryModel],...BACKUP_SLOTS.filter(([p])=>cfg[p]!=='none').map(([p,m])=>[cfg[p],cfg[m]])];}
const snowflake=/^\d{17,20}$/;
const error=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const exact=(obj,keys)=>obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).length===keys.length && keys.every(k=>Object.hasOwn(obj,k));
export function validateSettings(v){
 const keys=Object.keys(DEFAULT_AI);
 if(!exact(v,keys))throw error('INVALID_SETTINGS','Pengaturan AI tidak valid.');
 if(typeof v.enabled!=='boolean'||typeof v.providerDataConsent!=='boolean')throw error('INVALID_SETTINGS','Persetujuan dan status harus boolean.');
 if(!Object.hasOwn(PROVIDERS,v.primary)||BACKUP_SLOTS.some(([p])=>!(v[p]==='none'||Object.hasOwn(PROVIDERS,v[p]))))throw error('INVALID_SETTINGS','Provider tidak didukung.');
 const used=[v.primary,...BACKUP_SLOTS.map(([p])=>v[p]).filter(p=>p!=='none')];
 if(new Set(used).size!==used.length)throw error('INVALID_SETTINGS','Provider cadangan harus berbeda dari provider utama dan dari cadangan lain.');
 const model=x=>typeof x==='string'&&x.length<=150&&(!x || /^[a-zA-Z0-9._:/-]+$/.test(x));
 if(!model(v.primaryModel)||(v.enabled&&(!v.primaryModel||!v.providerDataConsent))||BACKUP_SLOTS.some(([p,m])=>!model(v[m])||(v[p]!=='none'&&!v[m])||(v[p]==='none'&&v[m])))throw error('INVALID_SETTINGS','Model atau persetujuan pemrosesan data tidak valid.');
 for(const [key,min,max] of [['perUserDaily',1,10000],['guildDaily',1,100000],['timeoutSeconds',3,60],['maxOutputTokens',16,2048]])if(!Number.isInteger(v[key])||v[key]<min||v[key]>max)throw error('INVALID_SETTINGS',`Nilai ${key} di luar batas.`);
 if(v.perUserDaily>v.guildDaily)throw error('INVALID_SETTINGS','Batas per anggota tidak boleh melebihi batas server.');
 return {...v};
}
function persistentPool(client){const db=client.db;if(!db||db.getStatus?.().isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool)throw error('STORAGE_UNAVAILABLE','Database persisten tidak tersedia.',503);return db.db.pool;}
const cfgKey=id=>`ai:foundation:config:${id}`;
export function createAIStore(client){
 const table=pgConfig.tables.cache_data;
 return {
  async read(id){const sqlite=sqliteBackend(client);if(sqlite){const v=sqlite.get(cfgKey(id));return v?validateSettings(upgradeSettings(v)):{...DEFAULT_AI};}const pool=persistentPool(client);const r=await pool.query(`SELECT value FROM ${table} WHERE key=$1`,[cfgKey(id)]);const v=r.rows[0]?.value;return v?validateSettings(upgradeSettings(v)):{...DEFAULT_AI};},
  async save(id,settings){const v=validateSettings(settings),sqlite=sqliteBackend(client);if(sqlite){sqlite.set(cfgKey(id),v);return v;}await persistentPool(client).query(`INSERT INTO ${table} (key,value,expires_at) VALUES ($1,$2::jsonb,NULL) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, expires_at=NULL`,[cfgKey(id),JSON.stringify(v)]);return v;},
  // Lock both counters in a fixed order; reservation happens before the first external request.
  async reserve(guildId,userId,limits){
   const sqlite=sqliteBackend(client);if(sqlite)return sqlite.transaction(tx=>{
    const day=tx.utcDay(),keys=[`ai:foundation:usage:g:${guildId}`,`ai:foundation:usage:u:${guildId}:${userId}`],counts=keys.map(key=>{const v=tx.get(key)??{day,count:0};if(typeof v.day!=='string'||!Number.isSafeInteger(v.count)||v.count<0)throw error('STORAGE_UNAVAILABLE','Penghitung AI tidak valid.',503);return v.day===day?v.count:0;});
    if(counts[0]>=limits.guildDaily||counts[1]>=limits.perUserDaily)throw error('LIMIT_REACHED','Batas permintaan AI harian telah tercapai.',429);
    for(let i=0;i<2;i++)tx.set(keys[i],{day,count:counts[i]+1});return {day,guild:counts[0]+1,user:counts[1]+1};
   });
   const pool=persistentPool(client),conn=await pool.connect();
   try{await conn.query('BEGIN');const day=(await conn.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")).rows[0].day;
    const keys=[`ai:foundation:usage:g:${guildId}`,`ai:foundation:usage:u:${guildId}:${userId}`];
    for(const key of keys)await conn.query(`INSERT INTO ${table} (key,value) VALUES ($1,$2::jsonb) ON CONFLICT (key) DO NOTHING`,[key,JSON.stringify({day,count:0})]);
    const counts=[];for(const key of keys){const r=await conn.query(`SELECT value FROM ${table} WHERE key=$1 FOR UPDATE`,[key]);const v=r.rows[0]?.value;if(!v||typeof v.day!=='string'||!Number.isSafeInteger(v.count)||v.count<0)throw error('STORAGE_UNAVAILABLE','Penghitung AI tidak valid.',503);counts.push(v.day===day?v.count:0);}
    if(counts[0]>=limits.guildDaily||counts[1]>=limits.perUserDaily)throw error('LIMIT_REACHED','Batas permintaan AI harian telah tercapai.',429);
    for(let i=0;i<2;i++)await conn.query(`UPDATE ${table} SET value=$2::jsonb WHERE key=$1`,[keys[i],JSON.stringify({day,count:counts[i]+1})]);
    await conn.query('COMMIT');return {day,guild:counts[0]+1,user:counts[1]+1};
   }catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release()}
  }
 };
}
async function boundedJSON(response){
 if(!response.body)throw error('PROVIDER_RESPONSE','Respons provider kosong.',502);
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>131072)throw error('PROVIDER_RESPONSE','Respons provider terlalu besar.',502);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8'));}catch{throw error('PROVIDER_RESPONSE','Respons provider tidak valid.',502)}
}
export function createAIFoundation({client,store=createAIStore(client),env=process.env,fetchImpl=globalThis.fetch}={}){
 let active=0;
 return {
  store,
  credentials(){return Object.fromEntries(Object.entries(PROVIDERS).map(([id,p])=>[id,Boolean(env[p.key]?.trim())]));},
  async generate({guildId,userId,prompt,consent,image=null}){
   if(!snowflake.test(guildId||'')||guildId!==client?.homeGuildId||!snowflake.test(userId||''))throw error('FORBIDDEN','Identitas server atau anggota tidak valid.',403);
   if(consent!==true)throw error('CONSENT_REQUIRED','Persetujuan pemrosesan data diperlukan.',403);
   if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw error('INVALID_INPUT','Input harus 1–4000 karakter.');
   if(image!==null&&(!image||!['image/png','image/jpeg'].includes(image.mime)||typeof image.base64!=='string'||!image.base64.length||image.base64.length>1398104||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)))throw error('INVALID_INPUT','Gambar tidak valid.');
   if(active>=4)throw error('BUSY','Terlalu banyak permintaan AI yang berjalan.',429);
   active++;
   try{
    const cfg=validateSettings(await store.read(guildId));if(!cfg.enabled||!cfg.providerDataConsent)throw error('DISABLED','AI belum diaktifkan atau belum disetujui.',403);
    const chain=providerChain(cfg);
    if(!chain.some(([id])=>env[PROVIDERS[id].key]?.trim()))throw error('NO_CREDENTIALS','Kredensial provider belum dikonfigurasi.',503);
    const usage=await store.reserve(guildId,userId,cfg);let attempted=0;
    for(const [id,model] of chain){const provider=PROVIDERS[id],key=env[provider.key]?.trim();if(!key)continue;attempted++;
     try{
      const response=await fetchImpl(provider.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model,messages:[{role:'user',content:image?[{type:'text',text:prompt},{type:'image_url',image_url:{url:`data:${image.mime};base64,${image.base64}`}}]:prompt}],max_tokens:cfg.maxOutputTokens,stream:false}),redirect:'error',signal:AbortSignal.timeout(cfg.timeoutSeconds*1000)});
      if(!response.ok){if([401,403,404,408,429].includes(response.status)||response.status>=500)continue;throw error('REQUEST_REJECTED','Provider menolak permintaan.',502);}
      const data=await boundedJSON(response);const choice=data?.choices?.[0];
      if(choice?.finish_reason==='content_filter'||choice?.message?.refusal)throw error('FILTERED','Respons diblokir oleh kebijakan provider.',422);
      const output=choice?.message?.content;if(typeof output!=='string'||!output.trim()||output.length>32000)throw error('PROVIDER_RESPONSE','Respons provider tidak valid.',502);
      return {text:output,provider:id,model,usedFallback:id!==cfg.primary,usage};
     }catch(e){if(e.code==='FILTERED'||e.code==='REQUEST_REJECTED')throw e; /* no provider body, prompt or secret is logged */}
    }
    throw error('PROVIDERS_UNAVAILABLE',attempted?'Semua provider gagal atau timeout.':'Tidak ada kredensial provider tersedia.',503);
   }finally{active--}
  }
 };
}
