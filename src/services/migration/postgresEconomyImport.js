import {convertEconomyRow,importEconomyBatch} from './economyBatch.js';
// Limited experimental economy-only proof of concept. This does NOT migrate the
// remaining PostgreSQL tables, timestamps, users or relationships; never cut over.
// Caller MUST stop all source and destination writers and manage verified backups.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid PostgreSQL schema');return `"${v.replaceAll('"','""')}"`}
function count(value){if(typeof value!=='string'||!/^\d+$/.test(value))throw fail('Invalid count');return BigInt(value)}
export async function importPostgresEconomySnapshot(conn,sqlite,guildId){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!validId(guildId))throw fail('Invalid migration parameters');
 let began=false,rows,sourceTotalWallet=0n,sourceTotalBank=0n,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
  await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time'),schema=quote(meta.rows?.[0]?.schema_name),when=meta.rows?.[0]?.snapshot_time;
  if(when==null||Number.isNaN(new Date(when).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(when).toISOString();
  const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity,
   EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[meta.rows[0].schema_name,['economy','temp_data','cache_data']]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==3||new Set(catalog.rows.map(x=>x.relname)).size!==3||catalog.rows.some(x=>!['economy','temp_data','cache_data'].includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  const economy=`${schema}."economy"`;
  const totals=(await conn.query(`SELECT count(*) FILTER (WHERE guild_id=$1)::text AS home,
   count(*) FILTER (WHERE guild_id IS DISTINCT FROM $1)::text AS other FROM ${economy}`,[guildId])).rows?.[0];
  const home=count(totals?.home);if(home>500n||count(totals?.other)>0n)throw fail('Source has too many accounts or other guilds');
  for(const table of ['temp_data','cache_data']){
   const r=await conn.query(`SELECT count(*)::text AS count FROM ${schema}."${table}" WHERE key LIKE 'economy:%' OR key LIKE 'guild:%:economy:%'`);
   if(count(r.rows?.[0]?.count)>0n)throw fail('Source contains legacy economy keys','MIGRATION_SOURCE_LEGACY');
  }
  const result=await conn.query(`SELECT guild_id,user_id,balance::text AS balance_text,bank::text AS bank_text,
   CASE WHEN octet_length(data::text)<=65536 THEN data::text ELSE NULL END AS data_text FROM ${economy} WHERE guild_id=$1 ORDER BY user_id COLLATE "C" LIMIT 501`,[guildId]);
  if(!Array.isArray(result.rows)||result.rows.length>500||BigInt(result.rows.length)!==home)throw fail('Source account count mismatch');rows=result.rows;
  let last='',size=0;
  for(const row of rows){
   if(!validId(row.user_id)||row.user_id<=last)throw fail('Invalid or duplicate user ID');last=row.user_id;
   size+=typeof row.data_text==='string'?Buffer.byteLength(row.data_text):0;if(size>2097152)throw fail('Source batch too large');
   const {account}=convertEconomyRow(row,guildId);sourceTotalWallet+=BigInt(account.wallet);sourceTotalBank+=BigInt(account.bank);
  }
  // Do not mix database network I/O with a SQLite write transaction.
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 let destination;
 if(rows.length)destination=importEconomyBatch(sqlite,guildId,rows,{requireEmptyDestination:true,expectedTotals:{wallet:sourceTotalWallet.toString(),bank:sourceTotalBank.toString()}});
 else destination=sqlite.transaction(tx=>{if(tx.hasAnyEconomyData())throw fail('Destination economy storage is not empty','MIGRATION_DESTINATION_CONFLICT');return {accounts:0,walletTotal:'0',bankTotal:'0'}});
 // The converter verifies each row in the transaction, and independently sums
 // source and destination values. This report is not a complete migration proof.
 if(destination.accounts!==rows.length||destination.walletTotal!==sourceTotalWallet.toString()||destination.bankTotal!==sourceTotalBank.toString())throw fail('Economy totals do not match','MIGRATION_VERIFY_FAILED');
 return {format:'zentix-economy-copy-v1',migrationReady:false,snapshotTime,accounts:destination.accounts,walletTotal:destination.walletTotal,bankTotal:destination.bankTotal};
}
