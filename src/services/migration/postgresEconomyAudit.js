import {convertEconomyRow} from './economyBatch.js';

// Offline-style, read-only preflight. No writes, no target DB, no imported rows.
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(value){if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>63)throw new Error('Invalid PostgreSQL schema');return `"${value.replaceAll('"','""')}"`;}
function count(value){if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error('Invalid PostgreSQL count');return BigInt(value);}
export async function auditPostgresEconomy(conn,homeGuildId,{maxAccounts=100000}={}){
 if(!conn||typeof conn.query!=='function'||!id(homeGuildId)||!Number.isInteger(maxAccounts)||maxAccounts<1||maxAccounts>100000)throw new Error('Invalid economy audit parameters');
 let began=false;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
  await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time');const schema=meta.rows?.[0]?.schema_name,when=meta.rows?.[0]?.snapshot_time;
  if(when==null)throw new Error('Missing snapshot time');const date=new Date(when);if(Number.isNaN(date.getTime()))throw new Error('Invalid snapshot time');const qSchema=quote(schema);
  // RLS or inheritance can conceal rows or duplicate them under keyset scans.
  const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity,
   EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[schema,['economy','temp_data','cache_data']]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==3||new Set(catalog.rows.map(x=>x.relname)).size!==3||catalog.rows.some(x=>!['economy','temp_data','cache_data'].includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw new Error('Economy source relations are missing or unsafe to audit');
  const economy=`${qSchema}."economy"`,temp=`${qSchema}."temp_data"`,cache=`${qSchema}."cache_data"`;
  const totals=await conn.query(`SELECT count(*) FILTER (WHERE guild_id=$1)::text AS home,
    count(*) FILTER (WHERE guild_id IS DISTINCT FROM $1)::text AS other,
    count(*) FILTER (WHERE guild_id=$1 AND (user_id IS NULL OR user_id !~ '^[0-9]{17,20}$'))::text AS invalid_id FROM ${economy}`,[homeGuildId]);
  const home=count(totals.rows?.[0]?.home),other=count(totals.rows?.[0]?.other),invalid=count(totals.rows?.[0]?.invalid_id);
  if(home>BigInt(maxAccounts))throw new Error('Economy audit account limit exceeded');
  const prefixes=[`economy:${homeGuildId}:`,`guild:${homeGuildId}:economy:`];const legacy={};
  for(const [label,table] of [['temp',temp],['cache',cache]]){
   const r=await conn.query(`SELECT count(*)::text AS count FROM ${table} WHERE left(key,length($1))=$1 OR left(key,length($2))=$2`,prefixes);legacy[label]=count(r.rows?.[0]?.count).toString();
  }
  let cursor='',scanned=0,wallet=0n,bank=0n;const errors=Object.create(null);
  while(true){
   const result=await conn.query(`SELECT guild_id,user_id,balance::text AS balance_text,bank::text AS bank_text,
    CASE WHEN octet_length(data::text)<=65536 THEN data::text ELSE NULL END AS data_text
    FROM ${economy} WHERE guild_id=$1 AND user_id ~ '^[0-9]{17,20}$' AND user_id COLLATE "C" > $2 COLLATE "C"
    ORDER BY user_id COLLATE "C" LIMIT 500`,[homeGuildId,cursor]);
   if(!Array.isArray(result.rows)||result.rows.length>500)throw new Error('Invalid economy audit page');
   if(!result.rows.length)break;
   for(const row of result.rows){
    if(!id(row.user_id)||row.user_id<=cursor)throw new Error('Invalid economy scan order');cursor=row.user_id;scanned++;
    if(scanned>maxAccounts)throw new Error('Economy audit account limit exceeded');
    try{const {account}=convertEconomyRow(row,homeGuildId);wallet+=BigInt(account.wallet);bank+=BigInt(account.bank)}catch(e){const code=['MIGRATION_INVALID','MIGRATION_UNSAFE_NUMBER','MIGRATION_ECONOMY_CONFLICT'].includes(e.code)?e.code:'MIGRATION_INVALID';errors[code]=(errors[code]||0)+1;}
   }
  }
  if(BigInt(scanned)+invalid!==home)throw new Error('Economy scan count mismatch');
  await conn.query('COMMIT');began=false;
  return {format:'zentix-economy-audit-v1',migrationReady:false,snapshotTime:date.toISOString(),homeAccounts:home.toString(),otherGuildAccounts:other.toString(),invalidUserIds:invalid.toString(),scannedAccounts:String(scanned),legacyKeys:legacy,rejectedByReason:{...errors},validAccountsWalletTotal:wallet.toString(),validAccountsBankTotal:bank.toString(),
   limitations:['No source rows are exported or imported.','Legacy key values, other tables, and destination are not checked.','Only JSON numerics supported by the batch converter are accepted.','The audit is a point-in-time snapshot; it does not stop writers or authorize cutover.']};
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
}
