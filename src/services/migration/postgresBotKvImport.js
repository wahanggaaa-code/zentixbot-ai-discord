import {parseMigrationJSON} from './safeJson.js';
import {canonicalizeKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
import {parseKey,isTempBackedType} from '../../utils/database/keyParser.js';
// Experimental bounded subset only; writers must be stopped and backups verified
// externally. It rejects unrecognized keys rather than silently dropping them.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const validKey=x=>typeof x==='string'&&x.length>0&&x.length<=255&&!/[\u0000-\u001f]/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function count(v){if(typeof v!=='string'||!/^\d+$/.test(v))throw fail('Invalid count');return BigInt(v)}
function canonicalBotKey(source,key,guild){
 if(!validKey(key)||key.startsWith('ai:'))throw fail('Unrecognized bot key');
 const canonical=canonicalizeKey(key),parsed=parseKey(canonical);if(!validKey(canonical))throw fail('Invalid canonical key');
 if(source==='cache'){
  // Other cache names have no reliable guild identity; do not guess.
  if(parsed.type!=='cache'||!canonical.startsWith(`cache:${guild}:`)||canonical.length<=`cache:${guild}:`.length)throw fail('Unscoped cache key requires review');
 }else if(canonical===`moderation_cases_list_${guild}`){/* dashboard case list */}
 else {
  if(parsed.type==='temp'||!isTempBackedType(parsed.type)||parsed.guildId!==guild)throw fail('Unscoped, structured or unrecognized key requires review');
  for(const field of ['userId','messageId'])if(parsed[field]!==undefined&&!validId(parsed[field]))throw fail('Invalid Discord ID in key');
 }
 return canonical;
}
function expiry(row){
 if(row.expiry_ms===null){if(row.expiry_exact!==true)throw fail('Invalid expiry');return null;}
 if(row.expiry_exact!==true||typeof row.expiry_ms!=='string'||!/^\d+(?:\.0+)?$/.test(row.expiry_ms))throw fail('Expiry requires review');
 const n=BigInt(row.expiry_ms.split('.')[0]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Expiry out of range');return Number(n);
}
export async function importPostgresBotKvSnapshot(conn,sqlite,guildId){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!validId(guildId))throw fail('Invalid migration parameters');
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['temp_data','cache_data'];const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity, EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==2||new Set(catalog.rows.map(x=>x.relname)).size!==2||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  entries=[];const seen=new Set();let bytes=0;
  for(const [source,table,filter] of [['temp','temp_data',"key <> '__meta:key_migration:v1'"],['cache','cache_data',"key NOT LIKE 'ai:%'"]]){
   const qualified=`${schema}."${table}"`;
   const stats=(await conn.query(`SELECT count(*)::text AS n, coalesce(sum(octet_length(value::text)),0)::text AS bytes FROM ${qualified} WHERE ${filter}`)).rows?.[0];
   const total=count(stats?.n),sourceBytes=count(stats?.bytes);if(total>500n||sourceBytes>2097152n||entries.length+Number(total)>500||BigInt(bytes)+sourceBytes>2097152n)throw fail('Bot KV source exceeds batch limits');
   const result=await conn.query(`SELECT key,CASE WHEN octet_length(value::text)<=262144 THEN value::text ELSE NULL END AS value_text,
    CASE WHEN expires_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (expires_at AT TIME ZONE current_setting('TimeZone')))*1000)::text END AS expiry_ms,
    CASE WHEN expires_at IS NULL THEN true ELSE extract(epoch FROM (expires_at AT TIME ZONE current_setting('TimeZone')))*1000 = trunc(extract(epoch FROM (expires_at AT TIME ZONE current_setting('TimeZone')))*1000) END AS expiry_exact
    FROM ${qualified} WHERE ${filter} ORDER BY key COLLATE "C" LIMIT 501`);
   if(!Array.isArray(result.rows)||BigInt(result.rows.length)!==total)throw fail('Bot KV source count mismatch');
   let last='';for(const row of result.rows){
    if(typeof row.key!=='string'||row.key<=last)throw fail('Invalid key order');last=row.key;
    const key=canonicalBotKey(source,row.key,guildId);if(seen.has(key))throw fail('Multiple legacy or canonical keys conflict','MIGRATION_SOURCE_LEGACY');seen.add(key);
    const value=parseMigrationJSON(row.value_text,262144);if(value===null)throw fail('JSON null key needs review');
    bytes+=Buffer.byteLength(row.value_text);if(bytes>2097152)throw fail('Bot KV source exceeds batch limits');entries.push({key,value,expiresAt:expiry(row)});
   }
  }
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{
  for(const entry of entries)for(const key of [entry.key,...getLegacyVariantsForCanonical(entry.key)])if(tx.hasRawKey(key))throw fail('Destination bot key already exists','MIGRATION_DESTINATION_CONFLICT');
  for(const entry of entries){tx.botSet(entry.key,entry.value,entry.expiresAt);const after=tx.botGetRaw(entry.key);if(!after||after.expiresAt!==entry.expiresAt||JSON.stringify(after.value)!==JSON.stringify(entry.value))throw fail('Bot KV verification failed','MIGRATION_VERIFY_FAILED');}
  return entries.length;
 });return {format:'zentix-bot-kv-copy-v1',migrationReady:false,snapshotTime,keys:copied};
}
