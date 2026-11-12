import {mkdirSync,openSync,closeSync,unlinkSync} from 'node:fs';
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
 let DatabaseSync,backupSQLite;try{({DatabaseSync,backup:backupSQLite}=await import('node:sqlite'))}catch{throw error('SQLite memerlukan Node.js 22.5 atau lebih baru.','SQLITE_RUNTIME')}
 const file=path===':memory:'?path:resolve(path);if(file!==':memory:')mkdirSync(dirname(file),{recursive:true});
 const database=new DatabaseSync(file);let closed=false,inTransaction=false,backupInProgress=false;
 try{database.exec(`PRAGMA busy_timeout=${busyTimeout}; PRAGMA foreign_keys=ON;`);
  // Do not alter the journal mode or create Zentix tables in an unrelated SQLite file.
  const initial=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
  if(initial.length&&!initial.includes('zentix_storage_meta'))throw error('File SQLite bukan database Zentix.','SQLITE_SCHEMA');
  if(initial.includes('zentix_storage_meta')){const prior=database.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get()?.value;if(prior!==undefined&&!['1','2','3'].includes(prior))throw error('Versi skema SQLite tidak didukung.','SQLITE_SCHEMA');if(prior===undefined&&initial.some(name=>name!=='zentix_storage_meta'))throw error('Skema SQLite tanpa versi tidak dikenali.','SQLITE_SCHEMA');}
  const mode=database.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode;if(file!==':memory:'&&String(mode).toLowerCase()!=='wal')throw error('SQLite WAL tidak tersedia.','SQLITE_UNAVAILABLE');
  database.exec('BEGIN IMMEDIATE');
  database.exec('CREATE TABLE IF NOT EXISTS zentix_storage_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const version=database.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get()?.value;
  if(version!==undefined&&!['1','2','3'].includes(version))throw error('Versi skema SQLite tidak didukung.','SQLITE_SCHEMA');
  const expected={zentix_kv:[['key','TEXT',1],['value','TEXT',0],['expires_at','INTEGER',0]],zentix_economy:[['guild_id','TEXT',1],['user_id','TEXT',2],['data','TEXT',0]],zentix_bot_kv:[['key','TEXT',1],['value','TEXT',0],['expires_at','INTEGER',0],...(version==='3'?[['updated_at','INTEGER',0]]:[])]};
  const exists=database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?");
  if(version===undefined){for(const name of Object.keys(expected))if(exists.get(name))throw error('Skema SQLite tanpa versi tidak dikenali.','SQLITE_SCHEMA');}
  else for(const [name,columns] of Object.entries(expected)){
   if(name==='zentix_bot_kv'&&version==='1'){if(exists.get(name))throw error('Tabel SQLite versi lama tidak dikenali.','SQLITE_SCHEMA');continue;}
   if(!exists.get(name))throw error('Tabel SQLite yang diperlukan tidak ada.','SQLITE_SCHEMA');
   const actual=database.prepare(`PRAGMA table_info(${name})`).all();
   for(const [column,type,pk] of columns){const info=actual.find(x=>x.name===column);if(!info||info.type.toUpperCase()!==type||info.pk!==pk)throw error('Struktur tabel SQLite tidak valid.','SQLITE_SCHEMA');}
  }
  database.exec(`CREATE TABLE IF NOT EXISTS zentix_kv (key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);
   CREATE TABLE IF NOT EXISTS zentix_economy (guild_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,user_id));
   CREATE TABLE IF NOT EXISTS zentix_bot_kv (key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);
   `);
  if(version!=='3')database.exec('ALTER TABLE zentix_bot_kv ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  database.exec("INSERT INTO zentix_storage_meta (key,value) VALUES ('schema_version','3') ON CONFLICT(key) DO UPDATE SET value=excluded.value; COMMIT;");
 }catch(e){try{database.exec('ROLLBACK')}catch{}database.close();throw e;}
 const getKV=database.prepare('SELECT value,expires_at FROM zentix_kv WHERE key=?');
 const putKV=database.prepare('INSERT INTO zentix_kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at');
 const delKV=database.prepare('DELETE FROM zentix_kv WHERE key=?');
 const getAccount=database.prepare('SELECT data FROM zentix_economy WHERE guild_id=? AND user_id=?');
 const putAccount=database.prepare('INSERT INTO zentix_economy(guild_id,user_id,data) VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET data=excluded.data');
 const getBot=database.prepare('SELECT value,expires_at FROM zentix_bot_kv WHERE key=?');
 const putBot=database.prepare('INSERT INTO zentix_bot_kv(key,value,expires_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at,updated_at=excluded.updated_at');
 const delBot=database.prepare('DELETE FROM zentix_bot_kv WHERE key=?');
 const listBot=database.prepare('SELECT key FROM zentix_bot_kv WHERE (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT 10001');
 const listLevels=database.prepare('SELECT key,value FROM zentix_bot_kv WHERE (substr(key,1,length(?))=? OR substr(key,1,length(?))=?) AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT 10001');
 const listTickets=database.prepare("SELECT key,value,updated_at FROM zentix_bot_kv WHERE substr(key,1,length(?))=? AND length(substr(key,length(?)+1)) BETWEEN 17 AND 20 AND substr(key,length(?)+1) NOT GLOB '*[^0-9]*' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,key ASC LIMIT ?");
 const listAccounts=database.prepare("SELECT 'guild:'||guild_id||':economy:'||user_id AS key FROM zentix_economy ORDER BY guild_id,user_id LIMIT 10001");
 const day=database.prepare("SELECT strftime('%Y-%m-%d','now') AS day");
 function open(){if(closed)throw error('SQLite sudah ditutup.','SQLITE_CLOSED')}
 function checkKey(k){if(!validKey(k))throw error('Key SQLite tidak valid.')}
 function checkIds(g,u){if(!validId(g)||!validId(u))throw error('ID akun tidak valid.')}
 const ops={
  get(key){open();checkKey(key);const row=getKV.get(key);return !row||(row.expires_at!==null&&row.expires_at<=Date.now())?null:decode(row.value)},
  set(key,value,expiresAt=null){open();checkKey(key);if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<0))throw error('Kedaluwarsa tidak valid.');putKV.run(key,encode(value),expiresAt)},
  delete(key){open();checkKey(key);return Number(delKV.run(key).changes)>0},
  botGet(key){open();checkKey(key);const row=getBot.get(key);return !row||(row.expires_at!==null&&row.expires_at<=Date.now())?null:decode(row.value)},
  botSet(key,value,expiresAt=null){open();checkKey(key);if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<0))throw error('Kedaluwarsa tidak valid.');putBot.run(key,encode(value),expiresAt,Date.now())},
  botDelete(key){open();checkKey(key);return Number(delBot.run(key).changes)>0},
  botList(){open();const rows=listBot.all(Date.now());if(rows.length>10000)throw error('Terlalu banyak key untuk didaftar.','SQLITE_LIST_LIMIT');return rows.map(row=>row.key)},
  botLevels(guild){open();if(!validId(guild))throw error('Guild tidak valid.');const canonical=`guild:${guild}:leveling:users:`,legacy=`${guild}:leveling:users:`,rows=listLevels.all(canonical,canonical,legacy,legacy,Date.now());if(rows.length>10000)throw error('Terlalu banyak akun level.','SQLITE_LIST_LIMIT');const found=new Map();for(const row of rows){const isCanonical=row.key.startsWith(canonical),user=row.key.slice((isCanonical?canonical:legacy).length);if(!validId(user))continue;const value=decode(row.value);if(value!==null&&(!found.has(user)||isCanonical))found.set(user,value);}return [...found].map(([userId,data])=>({userId,data}))},
  botTickets(guild,limit){open();if(!validId(guild)||!Number.isInteger(limit)||limit<1||limit>1000)throw error('Batas atau guild tidak valid.');const prefix=`guild:${guild}:ticket:`;return listTickets.all(prefix,prefix,prefix,prefix,Date.now(),limit).map(row=>({key:row.key,value:decode(row.value),updatedAt:row.updated_at}))},
  accountKeys(){open();const rows=listAccounts.all();if(rows.length>10000)throw error('Terlalu banyak akun untuk didaftar.','SQLITE_LIST_LIMIT');return rows.map(row=>row.key)},
  getAccount(g,u){open();checkIds(g,u);const row=getAccount.get(g,u);return row?decode(row.data):null},
  setAccount(g,u,value){open();checkIds(g,u);if(!value||typeof value!=='object'||Array.isArray(value))throw error('Akun tidak valid.');putAccount.run(g,u,encode(value))},
  utcDay(){open();return day.get().day},
 };
 return {
  dialect:'sqlite',file,
  isOpen(){return !closed},
  get(key){return ops.get(key)},
  getAccount(g,u){return ops.getAccount(g,u)},
  botGet(key){return ops.botGet(key)},
  botList(){return ops.botList()},
  botTickets(guild,limit){return ops.botTickets(guild,limit)},
  botLevels(guild){return ops.botLevels(guild)},
  accountKeys(){return ops.accountKeys()},
  set(key,value,expiresAt=null){return this.transaction(tx=>tx.set(key,value,expiresAt))},
  transaction(fn){open();if(inTransaction||typeof fn!=='function'||fn.constructor?.name==='AsyncFunction')throw error('Transaksi harus sinkron dan tidak boleh bersarang.');let alive=true;const tx=Object.fromEntries(Object.entries(ops).map(([k,v])=>[k,(...args)=>{if(!alive)throw error('Transaksi telah berakhir.');return v(...args)}]));
   inTransaction=true;try{database.exec('BEGIN IMMEDIATE');const result=fn(tx);if(result&&typeof result.then==='function')throw error('Transaksi tidak boleh async.');database.exec('COMMIT');return result}catch(e){try{database.exec('ROLLBACK')}catch{}throw e}finally{alive=false;inTransaction=false}},
  async backupTo(destination){
   open();if(typeof backupSQLite!=='function')throw error('Backup SQLite memerlukan Node.js 22.16 atau lebih baru.','SQLITE_RUNTIME');
   if(inTransaction||backupInProgress)throw error('Transaksi atau backup masih berjalan.','SQLITE_BUSY');
   if(typeof destination!=='string'||!destination||destination.includes('\0')||destination===':memory:')throw error('Lokasi backup tidak valid.');
   const target=resolve(destination);if(target===file)throw error('Backup tidak boleh menimpa database sumber.');
   // Exclusive creation prevents accidental overwrite. Backup directory must be trusted.
   const fd=openSync(target,'wx',0o600);closeSync(fd);backupInProgress=true;
   try{const pages=await backupSQLite(database,target);const copy=new DatabaseSync(target,{readOnly:true});try{const result=copy.prepare('PRAGMA quick_check').get();if(Object.values(result)[0]!=='ok')throw error('Verifikasi backup gagal.','SQLITE_BACKUP');}finally{copy.close()}return {path:target,pages};}
   catch(e){try{unlinkSync(target)}catch{}throw e}finally{backupInProgress=false}
  },
  close(){open();if(inTransaction||backupInProgress)throw error('Transaksi atau backup masih berjalan.','SQLITE_BUSY');database.close();closed=true},
 };
}
// Adapter discovery is explicit; no automatic failover between separate databases.
export function sqliteBackend(client){const db=client?.db;if(!db||db.getStatus?.().isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.())return null;return db.db.sqlite?.dialect==='sqlite'?db.db.sqlite:null;}
