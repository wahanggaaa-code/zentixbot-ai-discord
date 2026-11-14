import {parseMigrationJSON} from './safeJson.js';
// Experimental bounded source-to-SQLite AI KV copy. NOT a full migration.
// The caller must stop all writers and perform verified backups externally.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function count(v){if(typeof v!=='string'||!/^\d+$/.test(v))throw fail('Invalid count');return BigInt(v)}
function allowedKey(key,g){
 const singles=['ai:foundation:config:','ai:foundation:usage:g:','ai:welcome:settings:','ai:goodbye:settings:','ai:chat:settings:','ai:chat:proactive:','ai:interactive:settings:','ai:builder:history:','ai:smart:settings:','ai:digest:sent:','ai:activity:settings:','ai:activity:round:','ai:activity:schedule:','ai:knowledge:docs:'];
 if(singles.some(prefix=>key===prefix+g))return true;
 for(const prefix of [`ai:foundation:usage:u:${g}:`,`ai:activity:points:${g}:`])if(key.startsWith(prefix)&&validId(key.slice(prefix.length)))return true;
 // The usage report keeps one record per UTC day.
 if(key.startsWith(`ai:usage:day:${g}:`)&&/^\d{4}-\d{2}-\d{2}$/.test(key.slice(`ai:usage:day:${g}:`.length)))return true;
 return false;
}
export async function importPostgresAIDataSnapshot(conn,sqlite,guildId){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!validId(guildId))throw fail('Invalid migration parameters');
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
  await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity, EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[meta.schema_name,['temp_data','cache_data']]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==2||new Set(catalog.rows.map(x=>x.relname)).size!==2||catalog.rows.some(x=>!['temp_data','cache_data'].includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  const temp=`${schema}."temp_data"`,cache=`${schema}."cache_data"`;
  if(count((await conn.query(`SELECT count(*)::text AS n FROM ${temp} WHERE key LIKE 'ai:%'`)).rows?.[0]?.n)>0n)throw fail('AI keys in temp_data require review','MIGRATION_SOURCE_LEGACY');
  const total=count((await conn.query(`SELECT count(*)::text AS n FROM ${cache} WHERE key LIKE 'ai:%'`)).rows?.[0]?.n);if(total>500n)throw fail('Too many AI keys');
  const raw=await conn.query(`SELECT key,expires_at,CASE WHEN octet_length(value::text)<=262144 THEN value::text ELSE NULL END AS value_text FROM ${cache} WHERE key LIKE 'ai:%' ORDER BY key COLLATE "C" LIMIT 501`);
  if(!Array.isArray(raw.rows)||raw.rows.length>500||BigInt(raw.rows.length)!==total)throw fail('AI count mismatch');
  let size=0,last='';entries=[];
  for(const row of raw.rows){
   if(typeof row.key!=='string'||!allowedKey(row.key,guildId)||row.key<=last||row.expires_at!==null)throw fail('AI key, scope, ordering or TTL requires review');last=row.key;
   size+=typeof row.value_text==='string'?Buffer.byteLength(row.value_text):0;if(size>2097152)throw fail('AI batch too large');
   const value=parseMigrationJSON(row.value_text,262144);if(!value||typeof value!=='object')throw fail('AI value must be an object or array');entries.push({key:row.key,value});
  }
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{
  if(tx.hasAnyAIData())throw fail('Destination AI storage is not empty','MIGRATION_DESTINATION_CONFLICT');
  for(const entry of entries){tx.set(entry.key,entry.value);if(JSON.stringify(tx.get(entry.key))!==JSON.stringify(entry.value))throw fail('AI value verification failed','MIGRATION_VERIFY_FAILED');}
  return entries.length;
 });
 return {format:'zentix-ai-copy-v1',migrationReady:false,snapshotTime,keys:copied};
}
