import {parseMigrationJSON} from './safeJson.js';
import {GuildConfigSchema} from '../../utils/schemas.js';
import {getGuildConfigKey,getWelcomeConfigKey,getLevelingKey,getServerCountersKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
// Experimental limited copy only; the caller must stop all writers and verify
// backups. No timestamps or unrelated data are migrated, so never cut over.
const fail=(message,code='MIGRATION_SOURCE_INVALID')=>Object.assign(new Error(message),{code});
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function quote(v){if(typeof v!=='string'||!v||v.includes('\0')||Buffer.byteLength(v)>63)throw fail('Invalid schema');return `"${v.replaceAll('"','""')}"`}
function decode(text,kind){
 const value=parseMigrationJSON(text,262144);
 if(kind==='counters'){if(!Array.isArray(value))throw fail('Server counters require review');}
 else if(!value||typeof value!=='object'||Array.isArray(value)||('ok' in value&&'value' in value))throw fail('Configuration payload requires review');
 if(kind==='config'&&!GuildConfigSchema.safeParse(value).success)throw fail('Guild configuration is invalid');
 return value;
}
export async function importPostgresConfigSnapshot(conn,sqlite,guildId){
 if(!conn||typeof conn.query!=='function'||!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!validId(guildId))throw fail('Invalid migration parameters');
 const keys={config:getGuildConfigKey(guildId),counters:getServerCountersKey(guildId),welcome:getWelcomeConfigKey(guildId),leveling:getLevelingKey(guildId)};
 const protectedKeys=[...new Set(Object.values(keys).flatMap(key=>[key,...getLegacyVariantsForCanonical(key)]))];
 let began=false,entries,snapshotTime;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
  await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name);
  if(meta.snapshot_time==null||Number.isNaN(new Date(meta.snapshot_time).getTime()))throw fail('Invalid snapshot time');snapshotTime=new Date(meta.snapshot_time).toISOString();
  const names=['guilds','welcome_configs','leveling_configs','temp_data','cache_data'];
  const catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity, EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==names.length||new Set(catalog.rows.map(x=>x.relname)).size!==names.length||catalog.rows.some(x=>!names.includes(x.relname)||x.relkind!=='r'||x.relrowsecurity!==false||x.inherited!==false))throw fail('Source relations unavailable or unsafe');
  for(const table of ['temp_data','cache_data']){const result=await conn.query(`SELECT 1 FROM ${schema}."${table}" WHERE key = ANY($1::text[]) LIMIT 1`,[protectedKeys]);if(result.rows.length)throw fail('Conflicting source key','MIGRATION_SOURCE_LEGACY');}
  // Limit 2 intentionally fails on extra guilds instead of silently omitting them.
  const guild=(await conn.query(`SELECT id, CASE WHEN octet_length(config::text)<=262144 THEN config::text ELSE NULL END AS config_text, CASE WHEN octet_length(counters::text)<=262144 THEN counters::text ELSE NULL END AS counters_text FROM ${schema}."guilds" LIMIT 2`)).rows;
  if(!Array.isArray(guild)||guild.length!==1||guild[0].id!==guildId)throw fail('Expected exactly one matching guild');
  entries=[{key:keys.config,value:decode(guild[0].config_text,'config')},{key:keys.counters,value:decode(guild[0].counters_text,'counters')}];
  for(const [kind,table] of [['welcome','welcome_configs'],['leveling','leveling_configs']]){
   const result=await conn.query(`SELECT guild_id, CASE WHEN octet_length(config::text)<=262144 THEN config::text ELSE NULL END AS config_text FROM ${schema}."${table}" LIMIT 2`);
   if(!Array.isArray(result.rows)||result.rows.length>1||(result.rows.length&&result.rows[0].guild_id!==guildId))throw fail('Configuration scope or row count invalid');
   if(result.rows.length)entries.push({key:keys[kind],value:decode(result.rows[0].config_text,kind)});
  }
  // Runtime configuration writes refuse these conflicting role/verification
  // combinations; do not import a state that cannot later be safely edited.
  const config=entries.find(x=>x.key===keys.config).value,welcome=entries.find(x=>x.key===keys.welcome)?.value||{};
  const verification=config.verification||{};
  if((welcome?.roleIds?.length&&(verification.enabled||verification.autoVerify?.enabled))||(verification.enabled&&(config.autoRole||verification.autoVerify?.enabled)))throw fail('Conflicting verification and autorole settings');
  await conn.query('COMMIT');began=false;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
 const copied=sqlite.transaction(tx=>{
  if(protectedKeys.some(key=>tx.hasRawKey(key)))throw fail('Destination configuration is not empty','MIGRATION_DESTINATION_CONFLICT');
  for(const entry of entries){tx.botSet(entry.key,entry.value);if(JSON.stringify(tx.botGet(entry.key))!==JSON.stringify(entry.value))throw fail('Configuration verification failed','MIGRATION_VERIFY_FAILED');}
  return entries.length;
 });
 return {format:'zentix-config-copy-v1',migrationReady:false,snapshotTime,keys:copied};
}
