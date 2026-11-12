import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {stat} from 'node:fs/promises';
import dotenv from 'dotenv';
import {backupEnvironment} from './lib/postgresBackupConfig.js';
dotenv.config({path:path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))),'.env')});
function parse(argv){const args={};for(let i=0;i<argv.length;i++){const k=argv[i];if(!['--input','--confirm-db'].includes(k)||args[k]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Provide only --input and --confirm-db, each with a value');args[k]=argv[++i]}if(!args['--input']||!args['--confirm-db'])throw new Error('Both --input and --confirm-db are required');return args}
function run(cmd,args,env,timeout=600000){const r=spawnSync(cmd,args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe'],shell:false,timeout,maxBuffer:1024*1024});if(r.error||r.status!==0)throw new Error(`${cmd} failed or timed out; inspect the isolated target before retrying`);return r.stdout.trim()}
async function main(){
 const args=parse(process.argv.slice(2));if(!process.env.POSTGRES_RESTORE_URL)throw new Error('POSTGRES_RESTORE_URL is required; no fallback to production URL');const env=backupEnvironment(process.env.POSTGRES_RESTORE_URL);const db=env.PGDATABASE;
 if(!/^zentix_restore_test_[a-z0-9_]{1,42}$/.test(db)||args['--confirm-db']!==db)throw new Error('Target name must start zentix_restore_test_ and match --confirm-db exactly');
 const input=path.resolve(args['--input']);const file=await stat(input).catch(()=>null);if(!file?.isFile())throw new Error('Input must be a trusted backup file');
 const childEnv={...env};delete childEnv.PGPASSWORD;run('pg_restore',['--list',input],childEnv);
 // Empty public schema, no other user schemas or installed extensions. This is
 // a preliminary guard, not a lock against concurrent writers or malicious SQL.
 const sql=`SELECT current_database() = '${db}' AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public')) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') AND NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql');`;
 const empty=run('psql',['-X','--no-password','-A','-t','-v','ON_ERROR_STOP=1','-c',sql],env,30000);if(empty!=='t')throw new Error('Target is not an empty isolated test database');
 // No --clean or DROP. Single transaction rolls back SQL errors where supported;
 // connection loss during commit may still leave the outcome unknown.
 run('pg_restore',['--no-password','--exit-on-error','--single-transaction','--no-owner','--no-privileges','--dbname',db,input],env);
 console.log(`Restore drill completed in test database ${db}. Verify application data before trusting this backup.`);
}
main().catch(error=>{console.error(`Restore drill failed: ${error.message}`);process.exitCode=1});
