import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

// Experimental building block: NOT wired into application startup yet.
// SQLite's synchronous transaction callbacks must never await network/Discord/provider calls.
const error=(message,code='SQLITE_INVALID')=>Object.assign(new Error(message),{code});
const validKey=k=>typeof k==='string'&&k.length>0&&k.length<=255&&!/[\u0000-\u001f]/.test(k);
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
function encode(value){let text;try{text=JSON.stringify(value)}catch{throw error('Nilai tidak dapat disimpan.')}if(typeof text!=='string'||Buffer.byteLength(text)>2097152)throw error('Nilai tidak valid atau terlalu besar.');return text;}
function decode(value){try{return JSON.parse(value)}catch{throw error('Data SQLite rusak.','SQLITE_CORRUPT')}}
export async function openSQLiteStore({path=':memory:',busyTimeout=1000}={}){
 if(typeof path!=='string'||!path||path.includes('\0')||!Number.isInteger(busyTimeout)||busyTimeout<0||busyTimeout>5000)throw error('Konfigurasi SQLite tidak valid.');
 let DatabaseSync;try{({DatabaseSync}=await import('node:sqlite'))}catch{throw error('SQLite memerlukan Node.js 22.5 atau lebih baru.','SQLITE_RUNTIME')}
 const file=path===':memory:'?path:resolve(path);if(file!==':memory:')mkdirSync(dirname(file),{recursive:true});
 const database=new DatabaseSync(file);let closed=false,inTransaction=false;
 try{database.exec(`PRAGMA busy_timeout=${busyTimeout}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;`);
  database.exec('BEGIN IMMEDIATE');
  database.exec('CREATE TABLE IF NOT EXISTS zentix_storage_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const version=database.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get()?.value;
  if(version!==undefined&&version!=='1')throw error('Versi skema SQLite tidak didukung.','SQLITE_SCHEMA');
  database.exec(`CREATE TABLE IF NOT EXISTS zentix_kv (key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);
   CREATE TABLE IF NOT EXISTS zentix_economy (guild_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,user_id));
   INSERT INTO zentix_storage_meta (key,value) VALUES ('schema_version','1') ON CONFLICT(key) DO NOTHING; COMMIT;`);
 }catch(e){try{database.exec('ROLLBACK')}catch{}database.close();throw e;}
 const getKV=database.prepare('SELECT value,expires_at FROM zentix_kv WHERE key=?');
 const putKV=database.prepare('INSERT INTO zentix_kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at');
 const delKV=database.prepare('DELETE FROM zentix_kv WHERE key=?');
 const getAccount=database.prepare('SELECT data FROM zentix_economy WHERE guild_id=? AND user_id=?');
 const putAccount=database.prepare('INSERT INTO zentix_economy(guild_id,user_id,data) VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET data=excluded.data');
 const day=database.prepare("SELECT strftime('%Y-%m-%d','now') AS day");
 function open(){if(closed)throw error('SQLite sudah ditutup.','SQLITE_CLOSED')}
 function checkKey(k){if(!validKey(k))throw error('Key SQLite tidak valid.')}
 function checkIds(g,u){if(!validId(g)||!validId(u))throw error('ID akun tidak valid.')}
 const ops={
  get(key){open();checkKey(key);const row=getKV.get(key);return !row||(row.expires_at!==null&&row.expires_at<=Date.now())?null:decode(row.value)},
  set(key,value,expiresAt=null){open();checkKey(key);if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<0))throw error('Kedaluwarsa tidak valid.');putKV.run(key,encode(value),expiresAt)},
  delete(key){open();checkKey(key);return Number(delKV.run(key).changes)>0},
  getAccount(g,u){open();checkIds(g,u);const row=getAccount.get(g,u);return row?decode(row.data):null},
  setAccount(g,u,value){open();checkIds(g,u);if(!value||typeof value!=='object'||Array.isArray(value))throw error('Akun tidak valid.');putAccount.run(g,u,encode(value))},
  utcDay(){open();return day.get().day},
 };
 return {
  dialect:'sqlite',file,
  get(key){return ops.get(key)},
  getAccount(g,u){return ops.getAccount(g,u)},
  set(key,value,expiresAt=null){return this.transaction(tx=>tx.set(key,value,expiresAt))},
  transaction(fn){open();if(inTransaction||typeof fn!=='function'||fn.constructor?.name==='AsyncFunction')throw error('Transaksi harus sinkron dan tidak boleh bersarang.');let alive=true;const tx=Object.fromEntries(Object.entries(ops).map(([k,v])=>[k,(...args)=>{if(!alive)throw error('Transaksi telah berakhir.');return v(...args)}]));
   inTransaction=true;try{database.exec('BEGIN IMMEDIATE');const result=fn(tx);if(result&&typeof result.then==='function')throw error('Transaksi tidak boleh async.');database.exec('COMMIT');return result}catch(e){try{database.exec('ROLLBACK')}catch{}throw e}finally{alive=false;inTransaction=false}},
  close(){open();if(inTransaction)throw error('Transaksi masih berjalan.');database.close();closed=true},
 };
}
// Adapter discovery is explicit; no automatic failover between separate databases.
export function sqliteBackend(client){const db=client?.db;if(!db||db.getStatus?.().isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.())return null;return db.db.sqlite?.dialect==='sqlite'?db.db.sqlite:null;}
