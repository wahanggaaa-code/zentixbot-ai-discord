import {getGuildBirthdaysKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
import {validBirthday} from '../storage/sqliteBirthdays.js';
// Experimental bounded subset; backup, writer freeze and all other tables are
// caller responsibilities. This function never enables SQLite at startup.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
export async function importPostgresBirthdaysSnapshot(conn,sqlite,guildId){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(guildId))throw fail('Invalid migration parameters');
 const key=getGuildBirthdaysKey(guildId),keys=[key,...getLegacyVariantsForCanonical(key)];let began=false,values,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['birthdays','temp_data','cache_data'];const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity, EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==3||new Set(catalog.rows.map(x=>x.relname)).size!==3||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  for(const table of ['temp_data','cache_data']){const result=await conn.query(`SELECT 1 FROM ${schema}."${table}" WHERE key = ANY($1::text[]) LIMIT 1`,[keys]);if(result.rows.length)throw fail('Conflicting source key','MIGRATION_SOURCE_LEGACY');}
  const rows=(await conn.query(`SELECT guild_id,user_id,month,day FROM ${schema}."birthdays" ORDER BY user_id COLLATE "C" LIMIT 501`)).rows;
  if(!Array.isArray(rows)||rows.length>500)throw fail('Too many birthday rows');values=Object.create(null);let last='';
  for(const row of rows){if(row.guild_id!==guildId||!id(row.user_id)||row.user_id<=last||!validBirthday(row.month,row.day))throw fail('Birthday row requires review');last=row.user_id;values[row.user_id]={month:row.month,day:row.day};}
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{if(keys.some(k=>tx.hasRawKey(k)))throw fail('Destination birthday data already exists','MIGRATION_DESTINATION_CONFLICT');tx.botSet(key,values);if(JSON.stringify(tx.botGet(key))!==JSON.stringify(values))throw fail('Birthday verification failed','MIGRATION_VERIFY_FAILED');return Object.keys(values).length;});
 return {format:'zentix-birthdays-copy-v1',migrationReady:false,snapshotTime,users:copied};
}
