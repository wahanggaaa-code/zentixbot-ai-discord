import {spawnSync} from 'node:child_process';
import {mkdir,open,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import dotenv from 'dotenv';
import {backupEnvironment} from './lib/postgresBackupConfig.js';
import {existsSync} from 'node:fs';
import {chooseDatabase} from '../src/config/database/engine.js';
import {openSQLiteStore} from '../src/services/storage/sqlite.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));dotenv.config({path:path.join(root,'.env')});
function argumentsFor(argv){const args={};for(let i=0;i<argv.length;i++){const raw=argv[i];if(!['--output','--backup-dir'].includes(raw)||args[raw]!==undefined||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Only --output and --backup-dir with explicit values are supported');args[raw]=argv[++i]}return args}
function run(command,args,env){const result=spawnSync(command,args,{env,stdio:'ignore',shell:false,timeout:600000});if(result.error||result.status!==0)throw new Error(`${command} failed or was unavailable; incomplete backup was not retained`)}
// SQLite: a consistent copy of the database file, taken through SQLite's own backup
// function, so it is safe while the bot is running. The copy is one file without -wal/-shm.
async function backupSQLite(args,source){
 if(!existsSync(source))throw new Error(`SQLite database file not found: ${source}. Run this from the folder the bot is started in, or set DATABASE_PATH.`);
 const directory=path.resolve(args['--backup-dir']||process.env.BACKUP_DIR||path.join(process.cwd(),'backups'));await mkdir(directory,{recursive:true,mode:0o700});
 const file=path.resolve(args['--output']||path.join(directory,`zentix-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(4).toString('hex')}.db`));
 const store=await openSQLiteStore({path:source,busyTimeout:5000});
 // backupTo creates the target exclusively, verifies the copy and removes it again when it fails.
 try{await store.backupTo(file)}finally{store.close()}
 process.stdout.write(`Backup created: ${file}\n`);
}
async function main(){
 const args=argumentsFor(process.argv.slice(2)),database=chooseDatabase(process.env);
 if(database.engine==='sqlite')return backupSQLite(args,database.path);
 const source=process.env.POSTGRES_URL||process.env.DATABASE_URL;if(!source)throw new Error('POSTGRES_URL or DATABASE_URL is required');const env=backupEnvironment(source),directory=path.resolve(args['--backup-dir']||process.env.BACKUP_DIR||path.join(process.cwd(),'backups'));await mkdir(directory,{recursive:true,mode:0o700});
 const file=path.resolve(args['--output']||path.join(directory,`zentix-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomBytes(4).toString('hex')}.dump`));
 // Exclusive creation rejects existing files and final-component symlinks.
 const handle=await open(file,'wx',0o600);await handle.close();let complete=false;
 try{run('pg_dump',['--format=custom','--no-owner','--no-privileges','--file',file],env);run('pg_restore',['--list',file],Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TMPDIR','SYSTEMROOT','SystemRoot','WINDIR'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])));complete=true}finally{if(!complete)await unlink(file).catch(()=>{})}
 process.stdout.write(`Backup created: ${file}\n`);
}
main().catch(error=>{console.error(`Backup failed: ${error.message}`);process.exitCode=1});
