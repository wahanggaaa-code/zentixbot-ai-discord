import {mutateLevelInTransaction} from '../leveling/sqliteLevels.js';
import {getUserLevelKey} from '../../utils/database/keys.js';
// Experimental bounded copy; requires independently confirmed UTC runtime for
// PG timestamp-without-time-zone semantics and stopped source/target writers.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function integer(v){if(typeof v!=='string'||v.length>20||!/^\d+(?:\.0+)?$/.test(v))throw fail('Level number requires review');const n=BigInt(v.split('.')[0]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Level number is unsafe','MIGRATION_UNSAFE_NUMBER');return Number(n)}
export async function importPostgresLevelsSnapshot(conn,sqlite,guildId,{runtimeTimeZone}={}){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(guildId)||runtimeTimeZone!=='UTC')throw fail('Invalid parameters or unconfirmed UTC runtime');
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['user_levels','temp_data','cache_data'];const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity, EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==3||new Set(catalog.rows.map(x=>x.relname)).size!==3||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  const columns=await conn.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='user_levels' AND column_name='last_message'",[meta.schema_name]);
  if(columns.rows?.length!==1||columns.rows[0].data_type!=='timestamp without time zone')throw fail('Unexpected last_message type');
  for(const table of ['temp_data','cache_data']){const r=await conn.query(`SELECT 1 FROM ${schema}."${table}" WHERE key LIKE '%:leveling:users:%' LIMIT 1`);if(r.rows.length)throw fail('Source contains legacy level keys','MIGRATION_SOURCE_LEGACY');}
  const rows=(await conn.query(`SELECT guild_id,user_id,xp::text AS xp_text,level::text AS level_text,total_xp::text AS total_xp_text,rank::text AS rank_text,
   CASE WHEN last_message IS NULL THEN NULL ELSE trunc(extract(epoch FROM (last_message AT TIME ZONE 'UTC'))*1000)::text END AS last_ms,
   CASE WHEN last_message IS NULL THEN true ELSE extract(epoch FROM (last_message AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (last_message AT TIME ZONE 'UTC'))*1000) END AS last_exact
   FROM ${schema}."user_levels" ORDER BY user_id COLLATE "C" LIMIT 501`)).rows;
  if(!Array.isArray(rows)||rows.length>500)throw fail('Too many level rows');entries=[];let last='';
  for(const row of rows){
   if(row.guild_id!==guildId||!id(row.user_id)||row.user_id<=last||row.last_exact!==true)throw fail('Level row requires review');last=row.user_id;
   const value={xp:integer(row.xp_text),level:integer(row.level_text),totalXp:integer(row.total_xp_text),lastMessage:row.last_ms===null?0:integer(row.last_ms),rank:integer(row.rank_text)};
   if(value.level>1000)throw fail('Level outside supported range');entries.push({userId:row.user_id,value});
  }
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const users=sqlite.transaction(tx=>{
  if(tx.hasAnyLevelData())throw fail('Destination level data is not empty','MIGRATION_DESTINATION_CONFLICT');
  for(const entry of entries){mutateLevelInTransaction(tx,guildId,entry.userId,data=>{Object.assign(data,entry.value);return {result:true}});const saved=tx.botGet(getUserLevelKey(guildId,entry.userId));if(JSON.stringify(saved)!==JSON.stringify(entry.value))throw fail('Level verification failed','MIGRATION_VERIFY_FAILED');}
  return entries.length;
 });return {format:'zentix-level-copy-v1',migrationReady:false,snapshotTime,users};
}
