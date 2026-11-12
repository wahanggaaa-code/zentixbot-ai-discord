import {getAFKKey} from '../../utils/database/keys.js';
// Bounded experimental copy, not a cutover. UTC must be verified historically.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function integer(v){if(typeof v!=='string'||v.length>20||!/^\d+(?:\.0+)?$/.test(v))throw fail('Invalid number');const n=BigInt(v.split('.')[0]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Unsafe number','MIGRATION_UNSAFE_NUMBER');return Number(n)}
function time(v,exact){if(v===null){if(exact!==true)throw fail('Invalid null timestamp');return null}if(exact!==true)throw fail('Sub-millisecond timestamp');const value=integer(v),d=new Date(value);if(Number.isNaN(d.getTime()))throw fail('Timestamp out of range');return d.toISOString()}
export async function importPostgresAfkSnapshot(conn,sqlite,guildId,{runtimeTimeZone}={}){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(guildId)||runtimeTimeZone!=='UTC')throw fail('Invalid parameters or unconfirmed UTC history');
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['afk_status','temp_data','cache_data'];const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==names.length||new Set(catalog.rows.map(x=>x.relname)).size!==names.length||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  const columns=await conn.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='afk_status' AND column_name=ANY($2::text[])",[meta.schema_name,['status_at','expires_at']]);if(columns.rows?.length!==2||new Set(columns.rows.map(r=>r.column_name)).size!==2||columns.rows.some(r=>!['status_at','expires_at'].includes(r.column_name)||r.data_type!=='timestamp without time zone'))throw fail('Unexpected AFK timestamp type');
  for(const table of ['temp_data','cache_data']){const rows=(await conn.query(`SELECT 1 FROM ${schema}."${table}" WHERE key LIKE 'guild:%:afk:%' LIMIT 1`)).rows;if(rows.length)throw fail('Source AFK key requires review','MIGRATION_SOURCE_LEGACY');}
  const table=`${schema}."afk_status"`,stats=(await conn.query(`SELECT count(*)::text AS n,coalesce(sum(octet_length(reason)),0)::text AS bytes FROM ${table}`)).rows?.[0],count=integer(stats?.n),bytes=integer(stats?.bytes);if(count>500||bytes>2097152)throw fail('AFK source exceeds batch limits');
  const rows=(await conn.query(`SELECT guild_id,user_id,CASE WHEN octet_length(reason)<=262144 THEN reason ELSE NULL END AS reason,reason IS NULL AS reason_null,
   CASE WHEN status_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (status_at AT TIME ZONE 'UTC'))*1000)::text END AS status_ms,
   CASE WHEN status_at IS NULL THEN true ELSE extract(epoch FROM (status_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (status_at AT TIME ZONE 'UTC'))*1000) END AS status_exact,
   CASE WHEN expires_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (expires_at AT TIME ZONE 'UTC'))*1000)::text END AS expiry_ms,
   CASE WHEN expires_at IS NULL THEN true ELSE extract(epoch FROM (expires_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (expires_at AT TIME ZONE 'UTC'))*1000) END AS expiry_exact
   FROM ${table} ORDER BY user_id COLLATE "C" LIMIT 501`)).rows;
  if(!Array.isArray(rows)||rows.length!==count)throw fail('AFK source count mismatch');entries=[];let last='';
  for(const row of rows){if(row.guild_id!==guildId||!id(row.user_id)||row.user_id<=last||(row.reason_null!==true&&typeof row.reason!=='string')||(row.reason_null===true&&row.reason!==null)||Buffer.byteLength(row.reason??'')>262144)throw fail('AFK row requires review');last=row.user_id;entries.push({key:getAFKKey(guildId,row.user_id),value:{reason:row.reason,setAt:time(row.status_ms,row.status_exact),expiresAt:time(row.expiry_ms,row.expiry_exact)}})}
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{if(tx.hasAnyAfkData())throw fail('Destination AFK data already exists','MIGRATION_DESTINATION_CONFLICT');for(const entry of entries){tx.botSet(entry.key,entry.value);const saved=tx.botGetRaw(entry.key);if(!saved||saved.expiresAt!==null||JSON.stringify(saved.value)!==JSON.stringify(entry.value))throw fail('AFK verification failed','MIGRATION_VERIFY_FAILED')}return entries.length});
 return {format:'zentix-afk-copy-v1',migrationReady:false,snapshotTime,users:copied};
}
