import {pgConfig} from '../../config/database/postgres.js';

// Read-only inventory, NOT an export or an importer. A single repeatable-read
// snapshot avoids mixing counts from different points in time. It cannot prove
// migration compatibility or that writers have stopped.
const MAX_RELATIONS=256;
const CATALOG=`SELECT n.nspname AS schema_name, c.relname AS relation_name, c.relkind AS relation_kind,
 c.relrowsecurity AS row_security, c.relispartition AS is_partition
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname <> 'information_schema'
 AND left(n.nspname,3) <> 'pg_'
 ORDER BY n.nspname,c.relname LIMIT 257`;
function quoteIdentifier(value){
 if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>63)throw new Error('Invalid PostgreSQL identifier');
 return `"${value.replaceAll('"','""')}"`;
}
function parseCount(value){if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error('Invalid PostgreSQL count');return value;}
function metadata(row){
 if(!row||!['r','p','v','m','f'].includes(row.relation_kind)||typeof row.row_security!=='boolean'||typeof row.is_partition!=='boolean')throw new Error('Invalid PostgreSQL catalog response');
 quoteIdentifier(row.schema_name);quoteIdentifier(row.relation_name);return row;
}
/** Pass a dedicated pg Client or checked-out PoolClient. This owns its transaction. */
export async function inventoryPostgres(conn){
 if(!conn||typeof conn.query!=='function')throw new Error('Invalid PostgreSQL connection');
 let began=false;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
  await conn.query("SET LOCAL statement_timeout = '15s'");
  await conn.query("SET LOCAL lock_timeout = '3s'");
  const info=await conn.query('SELECT current_schema() AS app_schema, CURRENT_TIMESTAMP AS snapshot_time');
  const schema=info.rows?.[0]?.app_schema, when=info.rows?.[0]?.snapshot_time;
  quoteIdentifier(schema);if(when==null)throw new Error('Missing PostgreSQL snapshot time');const snapshotTime=new Date(when);if(Number.isNaN(snapshotTime.getTime()))throw new Error('Invalid PostgreSQL snapshot time');
  const result=await conn.query(CATALOG);if(!Array.isArray(result.rows)||result.rows.length>MAX_RELATIONS)throw new Error('Too many PostgreSQL relations for inventory');
  const expected=new Set([...Object.values(pgConfig.tables),'schema_migrations']);
  const relations=[];
  for(const item of result.rows){
   const row=metadata(item),name=`${quoteIdentifier(row.schema_name)}.${quoteIdentifier(row.relation_name)}`;
   const relation={schema:row.schema_name,name:row.relation_name,kind:row.relation_kind,partition:row.is_partition,rowSecurity:row.row_security,knownAppTable:row.schema_name===schema&&expected.has(row.relation_name),rows:null};
   // RLS can silently hide data. Never report such a count as complete.
   if((row.relation_kind==='r'||row.relation_kind==='p')&&!row.row_security){
    const counted=await conn.query(`SELECT count(*)::text AS count FROM ${name}`);relation.rows=parseCount(counted.rows?.[0]?.count);
    if(row.schema_name===schema&&['temp_data','cache_data'].includes(row.relation_name)){
     const breakdown=await conn.query(`SELECT count(*) FILTER (WHERE key LIKE 'ai:%')::text AS ai_keys,
       count(*) FILTER (WHERE key NOT LIKE 'ai:%')::text AS other_keys,
       count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP)::text AS expired,
       count(*) FILTER (WHERE expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)::text AS active FROM ${name}`);
     const b=breakdown.rows?.[0];relation.keyCounts={ai:parseCount(b?.ai_keys),other:parseCount(b?.other_keys),expired:parseCount(b?.expired),active:parseCount(b?.active)};
    }
   }
   relations.push(relation);
  }
  const present=new Set(relations.filter(x=>x.schema===schema&&['r','p'].includes(x.kind)).map(x=>x.name));
  const missingTables=Object.values(pgConfig.tables).filter(x=>!present.has(x));
  await conn.query('COMMIT');began=false;
  return {format:'zentix-postgres-inventory-v1',migrationReady:false,snapshotTime:snapshotTime.toISOString(),appSchema:schema,relations,missingAppTables:missingTables,
   limitations:['Counts only; no data exported, validated, or migrated.','Writers must still be stopped for an eventual cutover.','Row-level security, views, materialized views and foreign tables are not counted.','Partition counts can overlap; do not sum relation counts.','Only relations visible in PostgreSQL catalogs are listed; confirm permissions and other databases separately.','This snapshot does not verify backup, destination, data mapping, restore, or deployment readiness.']};
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}
}
