// Read-only aggregate preflight, not an export, migration, or cutover decision.
// A dedicated connection is required because this function owns its transaction.
const id=value=>typeof value==='string'&&/^\d{17,20}$/.test(value);
const fail=message=>Object.assign(new Error(message),{code:'RELATION_AUDIT_INVALID'});
const quote=value=>{if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>63)throw fail('Invalid PostgreSQL schema');return `"${value.replaceAll('"','""')}"`};
const parse=value=>{if(typeof value!=='string'||!/^\d+$/.test(value))throw fail('Invalid audit count');return BigInt(value)};
// These are baseline schema identities, not a claim that every reference is an FK.
const relations=[
 ['guild_users','user_id',false],['birthdays','user_id',false],['afk_status','user_id',false],
 ['user_levels','user_id',false],['economy','user_id',false],['verification_audit','user_id',false],
 ['invite_tracking','inviter_id',true],['giveaways',null,false],['ticket_data',null,false],
 ['welcome_configs',null,false],['leveling_configs',null,false],['application_roles',null,false],
];
const countFields=(row,fields)=>Object.fromEntries(fields.map(field=>[field,parse(row?.[field]).toString()]));
export async function auditPostgresRelations(conn,homeGuildId){
 if(!conn||typeof conn.query!=='function'||!id(homeGuildId))throw fail('Invalid relation audit parameters');let began=false;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;await conn.query("SET LOCAL statement_timeout = '15s'");await conn.query("SET LOCAL lock_timeout = '3s'");
  const meta=(await conn.query('SELECT current_schema() AS schema_name, CURRENT_TIMESTAMP AS snapshot_time')).rows?.[0],schema=quote(meta?.schema_name),date=new Date(meta?.snapshot_time);if(meta?.snapshot_time==null||Number.isNaN(date.getTime()))throw fail('Invalid snapshot time');
  const names=['guilds','users',...relations.map(([name])=>name)],catalog=await conn.query(`SELECT c.relname,c.relkind,c.relrowsecurity,EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherited FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,[meta.schema_name,names]);
  if(!Array.isArray(catalog.rows)||catalog.rows.length!==names.length||new Set(catalog.rows.map(r=>r.relname)).size!==names.length||catalog.rows.some(r=>!names.includes(r.relname)||r.relkind!=='r'||r.relrowsecurity!==false||r.inherited!==false))throw fail('Relation audit source missing or unsafe');
  const guilds=`${schema}."guilds"`,users=`${schema}."users"`;
  const masterFields=['rows','invalid_id'],userFields=[...masterFields,'with_username','with_discriminator','with_avatar','with_created_at','with_updated_at','without_guild_users'];
  const guildResult=(await conn.query(`SELECT count(*)::text AS rows,count(*) FILTER (WHERE id IS NULL OR id !~ '^[0-9]{17,20}$')::text AS invalid_id FROM ${guilds}`)).rows?.[0];
  const userResult=(await conn.query(`SELECT count(*)::text AS rows,count(*) FILTER (WHERE id IS NULL OR id !~ '^[0-9]{17,20}$')::text AS invalid_id,
   count(*) FILTER (WHERE username IS NOT NULL)::text AS with_username,count(*) FILTER (WHERE discriminator IS NOT NULL)::text AS with_discriminator,count(*) FILTER (WHERE avatar IS NOT NULL)::text AS with_avatar,
   count(*) FILTER (WHERE created_at IS NOT NULL)::text AS with_created_at,count(*) FILTER (WHERE updated_at IS NOT NULL)::text AS with_updated_at,
   count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM ${schema}."guild_users" gu WHERE gu.user_id=users.id))::text AS without_guild_users FROM ${users} users`)).rows?.[0];
  const results={};
  for(const [name,user,optional] of relations){
   const table=`${schema}.${quote(name)}`,membershipCounts=name==='guild_users'?`,count(*) FILTER (WHERE r.joined_at IS NOT NULL)::text AS with_joined_at,count(*) FILTER (WHERE r.updated_at IS NOT NULL)::text AS with_updated_at`:'',userCounts=user?`,count(*) FILTER (WHERE r."${user}" IS NULL)::text AS null_user,
    count(*) FILTER (WHERE r."${user}" IS NOT NULL AND r."${user}" !~ '^[0-9]{17,20}$')::text AS invalid_user,
    count(*) FILTER (WHERE r."${user}" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${users} u WHERE u.id=r."${user}"))::text AS missing_user`:'';
   const result=(await conn.query(`SELECT count(*)::text AS rows,count(*) FILTER (WHERE r.guild_id=$1)::text AS home_guild,
    count(*) FILTER (WHERE r.guild_id IS DISTINCT FROM $1)::text AS other_or_null_guild,
    count(*) FILTER (WHERE r.guild_id IS NULL OR r.guild_id !~ '^[0-9]{17,20}$')::text AS invalid_guild,
    count(*) FILTER (WHERE r.guild_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${guilds} g WHERE g.id=r.guild_id))::text AS missing_guild${userCounts}${membershipCounts} FROM ${table} r`,[homeGuildId])).rows?.[0];
   const fields=['rows','home_guild','other_or_null_guild','invalid_guild','missing_guild',...(user?['null_user','invalid_user','missing_user']:[]),...(name==='guild_users'?['with_joined_at','with_updated_at']:[])],counts=countFields(result,fields);
   if(parse(counts.home_guild)+parse(counts.other_or_null_guild)!==parse(counts.rows))throw fail('Inconsistent relation counts');
   results[name]={...counts,...(user?{userColumn:user,userNullable:optional}:{}),baselineForeignKeys:{guild:name!=='verification_audit',...(user?{user:!['verification_audit','invite_tracking'].includes(name)}:{})}};
  }
  await conn.query('COMMIT');began=false;
  return {format:'zentix-postgres-relations-audit-v1',migrationReady:false,snapshotTime:date.toISOString(),guilds:countFields(guildResult,masterFields),users:countFields(userResult,userFields),relations:results,
   limitations:['Aggregate counts only; no records are exported, imported, repaired, or deleted.','Missing parent counts describe references, not necessarily database foreign-key violations; actual constraints are not inspected.','This checks selected scalar IDs only; JSON, moderator IDs, invite codes, membership semantics, other schemas and other tables are not verified.','Counts do not prove permissions or visibility in another database or schema.','A snapshot does not stop writers or verify SQLite, backups, restore, or readiness for cutover.']};
 }catch(error){if(began)await conn.query('ROLLBACK').catch(()=>{});throw error}
}
