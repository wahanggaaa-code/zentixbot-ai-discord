import {pathToFileURL} from 'node:url';
import {inventoryPostgres} from '../src/services/migration/postgresInventory.js';

async function main(){
 const args=process.argv.slice(2);
 if(args.length===1&&args[0]==='--help'){
  console.log('Read-only PostgreSQL inventory for an experimental SQLite migration.\nSet POSTGRES_URL in the environment; run: node scripts/sqlite-migration-inventory.js\nOutputs relation names and row counts as JSON to stdout. No data is exported or migrated.\nDo not pass credentials on the command line.');return;
 }
 if(args.length)throw new Error('Unknown argument');
 const url=process.env.POSTGRES_URL?.trim();if(!url||!/^postgres(?:ql)?:\/\//i.test(url))throw new Error('POSTGRES_URL must be set to a PostgreSQL URL');
 const {default:pg}=await import('pg');const client=new pg.Client({connectionString:url,connectionTimeoutMillis:10000,application_name:'zentix-sqlite-inventory'});
 try{await client.connect();const report=await inventoryPostgres(client);process.stdout.write(JSON.stringify(report,null,2)+'\n');}finally{await client.end().catch(()=>{});}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(()=>{console.error('Inventory failed. Check PostgreSQL connectivity, permissions, schema and timeouts. No migration was performed.');process.exitCode=1;});
