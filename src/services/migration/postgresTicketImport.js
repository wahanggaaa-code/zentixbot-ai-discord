import {parseMigrationJSON} from './safeJson.js';
import {getTicketKey} from '../../utils/database/keys.js';
// Experimental copy only. Freeze all writers and verify backups separately.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function integer(v){if(typeof v!=='string'||v.length>20||!/^\d+(?:\.0+)?$/.test(v))throw fail('Invalid integer');const n=BigInt(v.split('.')[0]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Unsafe integer','MIGRATION_UNSAFE_NUMBER');return Number(n)}
export async function importPostgresTicketsSnapshot(conn,sqlite,guildId,{runtimeTimeZone}={}){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(guildId)||runtimeTimeZone!=='UTC')throw fail('Invalid parameters or unconfirmed UTC history');
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['ticket_data','temp_data','cache_data'];const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==names.length||new Set(catalog.rows.map(x=>x.relname)).size!==names.length||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  const columns=await conn.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='ticket_data' AND column_name='updated_at'",[meta.schema_name]);if(columns.rows?.length!==1||columns.rows[0].data_type!=='timestamp without time zone')throw fail('Unexpected ticket timestamp type');
  for(const table of ['temp_data','cache_data']){const rows=(await conn.query(`SELECT 1 FROM ${schema}."${table}" WHERE key LIKE 'guild:%:ticket:%' AND key NOT LIKE 'guild:%:ticket:counter' LIMIT 1`)).rows;if(rows.length)throw fail('Source ticket key requires review','MIGRATION_SOURCE_LEGACY');}
  const table=`${schema}."ticket_data"`,stats=(await conn.query(`SELECT count(*)::text AS n,coalesce(sum(octet_length(data::text)),0)::text AS bytes FROM ${table}`)).rows?.[0],count=integer(stats?.n),bytes=integer(stats?.bytes);if(count>500||bytes>2097152)throw fail('Ticket source exceeds batch limits');
  const rows=(await conn.query(`SELECT guild_id,channel_id,expires_at IS NULL AS no_expiry,CASE WHEN octet_length(data::text)<=262144 THEN data::text ELSE NULL END AS data_text,
   CASE WHEN updated_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (updated_at AT TIME ZONE 'UTC'))*1000)::text END AS updated_ms,
   CASE WHEN updated_at IS NULL THEN false ELSE extract(epoch FROM (updated_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (updated_at AT TIME ZONE 'UTC'))*1000) END AS updated_exact
   FROM ${table} ORDER BY channel_id COLLATE "C" LIMIT 501`)).rows;
  if(!Array.isArray(rows)||rows.length!==count)throw fail('Ticket source count mismatch');entries=[];let last='';
  for(const row of rows){
   if(row.guild_id!==guildId||!id(row.channel_id)||row.channel_id<=last||row.no_expiry!==true||row.updated_exact!==true||row.updated_ms===null)throw fail('Ticket scope, identity, TTL or time requires review');last=row.channel_id;
   const updatedAt=integer(row.updated_ms);if(Number.isNaN(new Date(updatedAt).getTime()))throw fail('Ticket timestamp out of range');const data=parseMigrationJSON(row.data_text,262144);
   if(!data||typeof data!=='object'||Array.isArray(data)||('ok' in data&&'value' in data)||data.id!==row.channel_id||data.guildId!==guildId||!id(data.userId)||!['open','closed','deleted'].includes(data.status)||(data.claimedBy!=null&&!id(data.claimedBy)))throw fail('Ticket JSON requires review');
   entries.push({key:getTicketKey(guildId,row.channel_id),data,updatedAt});
  }
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{
  if(tx.hasAnyTicketData())throw fail('Destination ticket data already exists','MIGRATION_DESTINATION_CONFLICT');
  for(const entry of entries){if(tx.hasRawKey(entry.key))throw fail('Ticket key already exists','MIGRATION_DESTINATION_CONFLICT');tx.importTicket(entry.key,entry.data,entry.updatedAt);const saved=tx.botGetRaw(entry.key);if(!saved||saved.expiresAt!==null||saved.updatedAt!==entry.updatedAt||JSON.stringify(saved.value)!==JSON.stringify(entry.data))throw fail('Ticket verification failed','MIGRATION_VERIFY_FAILED');}
  return entries.length;
 });return {format:'zentix-tickets-copy-v1',migrationReady:false,snapshotTime,tickets:copied};
}
