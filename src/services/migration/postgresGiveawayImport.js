import {parseMigrationJSON} from './safeJson.js';
// Experimental bounded copy, never a cutover tool. PG and SQLite writers must
// be stopped, backups verified, and Discord scheduling reconciled separately.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function integer(value){if(typeof value!=='string'||value.length>20||!/^\d+(?:\.0+)?$/.test(value))throw fail('Invalid integer');const n=BigInt(value.split('.')[0]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Unsafe integer','MIGRATION_UNSAFE_NUMBER');return Number(n)}
function ids(value){return Array.isArray(value)&&value.length<=10000&&value.every(id)&&new Set(value).size===value.length}
function validate(row,guildId){
 if(row.guild_id!==guildId||!id(row.message_id)||row.ends_exact!==true||row.ends_ms===null)throw fail('Giveaway scope, identity or timestamp requires review');
 const ends=integer(row.ends_ms);if(Number.isNaN(new Date(ends).getTime()))throw fail('Giveaway timestamp out of range');
 const data=parseMigrationJSON(row.data_text,262144);
 if(!data||typeof data!=='object'||Array.isArray(data)||('ok' in data&&'value' in data)||data.guildId!==guildId||data.messageId!==row.message_id||!id(data.channelId)||!id(data.hostId)||typeof data.prize!=='string'||!data.prize.trim()||data.prize.length>256||!Number.isInteger(data.winnerCount)||data.winnerCount<1||data.winnerCount>10||!ids(data.participants)||typeof data.ended!=='boolean'||typeof data.isEnded!=='boolean'||data.ended!==data.isEnded)throw fail('Giveaway JSON requires review');
 // SQLite scheduler reads JSON while PG reads a separate timestamp column.
 // Only an unambiguous integer-millisecond representation is copied here.
 if(!Number.isSafeInteger(data.endsAt)||data.endsAt!==ends||(data.endTime!==undefined&&data.endTime!==ends))throw fail('Giveaway end timestamps disagree');
 if(data.winnerIds!==undefined&&(!ids(data.winnerIds)||data.winnerIds.length>data.winnerCount||data.winnerIds.some(x=>!data.participants.includes(x))))throw fail('Giveaway winners require review');
 return {data,ends};
}
export async function importPostgresGiveawaysSnapshot(conn,sqlite,guildId,{runtimeTimeZone}={}){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(guildId)||runtimeTimeZone!=='UTC')throw fail('Invalid parameters or unconfirmed UTC history');
 let began=false,entries,snapshotTime,dueActive;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['giveaways','temp_data','cache_data'];const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==names.length||new Set(catalog.rows.map(x=>x.relname)).size!==names.length||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  const columns=await conn.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='giveaways' AND column_name='ends_at'",[meta.schema_name]);if(columns.rows?.length!==1||columns.rows[0].data_type!=='timestamp without time zone')throw fail('Unexpected giveaway timestamp type');
  for(const table of ['temp_data','cache_data']){const rows=(await conn.query(`SELECT 1 FROM ${schema}."${table}" WHERE key LIKE 'guild:%:giveaways' OR key LIKE 'giveaway:%' LIMIT 1`)).rows;if(rows.length)throw fail('Source giveaway key requires review','MIGRATION_SOURCE_LEGACY');}
  const table=`${schema}."giveaways"`,stats=(await conn.query(`SELECT count(*)::text AS n,coalesce(sum(octet_length(data::text)),0)::text AS bytes FROM ${table}`)).rows?.[0],count=integer(stats?.n),bytes=integer(stats?.bytes);if(count>500||bytes>2097152)throw fail('Giveaway source exceeds batch limits');
  const rows=(await conn.query(`SELECT guild_id,message_id,CASE WHEN octet_length(data::text)<=262144 THEN data::text ELSE NULL END AS data_text,
   CASE WHEN ends_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000)::text END AS ends_ms,
   CASE WHEN ends_at IS NULL THEN false ELSE extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (ends_at AT TIME ZONE 'UTC'))*1000) END AS ends_exact
   FROM ${table} ORDER BY message_id COLLATE "C" LIMIT 501`)).rows;
  if(!Array.isArray(rows)||rows.length!==count)throw fail('Giveaway source count mismatch');entries=Object.create(null);let last='';dueActive=0;
  for(const row of rows){if(typeof row.message_id!=='string'||row.message_id<=last)throw fail('Giveaway order or identity invalid');last=row.message_id;const {data,ends}=validate(row,guildId);entries[row.message_id]=data;if(!data.ended&&ends<=new Date(snapshotTime).getTime())dueActive++;}
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{
  if(tx.hasAnyGiveawayData())throw fail('Destination giveaway data already exists','MIGRATION_DESTINATION_CONFLICT');
  const key=`guild:${guildId}:giveaways`;tx.botSet(key,entries);if(JSON.stringify(tx.botGet(key))!==JSON.stringify(entries))throw fail('Giveaway verification failed','MIGRATION_VERIFY_FAILED');return Object.keys(entries).length;
 });return {format:'zentix-giveaways-copy-v1',migrationReady:false,snapshotTime,giveaways:copied,dueActive};
}
