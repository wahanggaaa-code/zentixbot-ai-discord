import {parseMigrationJSON} from './safeJson.js';

// Bounded experimental snapshot copy. It does not freeze writers, verify
// backups, or migrate any other table. Never use this for production cutover.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(value){if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>63)throw fail('Invalid schema');return `"${value.replaceAll('"','""')}"`}
function integer(value){if(typeof value!=='string'||value.length>20||!/^\d+(?:\.0+)?$/.test(value))throw fail('Invalid integer');const n=BigInt(value.split('.')[0]);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Unsafe integer','MIGRATION_UNSAFE_NUMBER');return Number(n)}
export async function importPostgresVerificationAuditSnapshot(conn,sqlite,guildId,{runtimeTimeZone}={}){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(guildId)||runtimeTimeZone!=='UTC')throw fail('Invalid parameters or unconfirmed UTC history');
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const catalog=await conn.query(`SELECT c.relkind,c.relrowsecurity,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='verification_audit'`,[meta.schema_name]);
  const relation=catalog.rows?.[0];if(catalog.rows?.length!==1||relation.relkind!=='r'||relation.relrowsecurity!==false||relation.inherited!==false)throw fail('Source relation unavailable or unsafe');
  const columns=await conn.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='verification_audit' AND column_name='created_at'",[meta.schema_name]);if(columns.rows?.length!==1||columns.rows[0].data_type!=='timestamp without time zone')throw fail('Unexpected audit timestamp type');
  const table=`${schema}."verification_audit"`,stats=(await conn.query(`SELECT count(*)::text AS n,coalesce(sum(octet_length(metadata::text)),0)::text AS bytes FROM ${table}`)).rows?.[0];
  const count=integer(stats?.n),bytes=integer(stats?.bytes);if(count>500||bytes>2097152)throw fail('Audit source exceeds batch limits');
  const rows=(await conn.query(`SELECT id::text AS id_text,guild_id,user_id,action,source,moderator_id,
   CASE WHEN octet_length(metadata::text)<=65536 THEN metadata::text ELSE NULL END AS metadata_text,
   CASE WHEN created_at IS NULL THEN NULL ELSE trunc(extract(epoch FROM (created_at AT TIME ZONE 'UTC'))*1000)::text END AS created_ms,
   CASE WHEN created_at IS NULL THEN false ELSE extract(epoch FROM (created_at AT TIME ZONE 'UTC'))*1000=trunc(extract(epoch FROM (created_at AT TIME ZONE 'UTC'))*1000) END AS created_exact
   FROM ${table} ORDER BY id LIMIT 501`)).rows;
  if(!Array.isArray(rows)||rows.length!==count)throw fail('Audit source count mismatch');entries=[];let last=0;
  for(const row of rows){
   const auditId=integer(row.id_text);if(auditId<=last||auditId>2147483647||row.guild_id!==guildId||!id(row.user_id)||typeof row.action!=='string'||!row.action||row.action.length>50||(row.source!==null&&(typeof row.source!=='string'||row.source.length>50))||(row.moderator_id!==null&&!id(row.moderator_id))||row.created_exact!==true||row.created_ms===null)throw fail('Audit row requires review');last=auditId;
   const milliseconds=integer(row.created_ms),time=new Date(milliseconds);if(Number.isNaN(time.getTime()))throw fail('Audit timestamp out of range');const metadata=parseMigrationJSON(row.metadata_text,65536);if(metadata===null)throw fail('Audit metadata is null');
   entries.push({id:auditId,guildId,userId:row.user_id,action:row.action,source:row.source,moderatorId:row.moderator_id,metadata,createdAt:time.toISOString()});
  }
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{
  if(tx.hasAnyVerificationAudit())throw fail('Destination audit is not empty','MIGRATION_DESTINATION_CONFLICT');
  for(const entry of entries){tx.importVerificationAudit(entry);if(JSON.stringify(tx.verificationAuditById(entry.id))!==JSON.stringify(entry))throw fail('Audit verification failed','MIGRATION_VERIFY_FAILED');}return entries.length;
 });
 return {format:'zentix-verification-audit-copy-v1',migrationReady:false,snapshotTime,rows:copied};
}
