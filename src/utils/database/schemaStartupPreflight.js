import {pgConfig} from '../../config/database/postgres.js';
import {assertAllowlistedIdentifier,quoteIdentifier} from '../sqlIdentifiers.js';

const failure=(code,message)=>Object.assign(new Error(message),{code});
// This is deliberately read-only. It identifies common partial/old installations,
// not all schema drift or concurrent changes; run only with other writers stopped.
export async function inspectStartupSchema(client){
 const ledger=assertAllowlistedIdentifier(pgConfig.migration.table,new Set([pgConfig.migration.table]),'PostgreSQL migration table identifier');
 const tables=[...new Set(Object.values(pgConfig.tables))],names=[...tables,ledger];
 const result=await client.query(`SELECT c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])`,[names]);
 if(!Array.isArray(result.rows))throw new Error('Schema preflight query failed');
 const found=new Map(result.rows.map(row=>[row.relname,row.relkind]));
 if(found.has(ledger)&&found.get(ledger)!=='r')throw failure('SCHEMA_UNVERSIONED_EXISTING','Existing schema ledger requires offline review.');
 let latest=null;if(found.has(ledger)){const r=await client.query(`SELECT version,label,applied_at FROM ${quoteIdentifier(ledger)} ORDER BY version DESC LIMIT 1`);latest=r.rows[0]||null;}
 if(!latest){if(tables.some(name=>found.has(name)))throw failure('SCHEMA_UNVERSIONED_EXISTING','Existing bot tables have no schema version; offline review required.');return {fresh:true};}
 if(Number(latest.version)!==Number(pgConfig.migration.expectedVersion))throw failure('SCHEMA_VERSION_MISMATCH','PostgreSQL schema version does not match.');
 if(tables.some(name=>found.get(name)!=='r'))throw failure('SCHEMA_INCOMPLETE','Versioned PostgreSQL schema is missing expected tables or has unsupported relation types.');
 return {fresh:false};
}
