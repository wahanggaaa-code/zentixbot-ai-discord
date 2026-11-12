import {mkdirSync,openSync,closeSync,unlinkSync,lstatSync} from 'node:fs';
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
 const file=path===':memory:'?path:resolve(path);
 if(file!==':memory:'){
  // A trusted, private parent directory is still required. New files are private;
  // existing file permissions are not silently changed. Reject symlink final paths.
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  try{const fd=openSync(file,'wx',0o600);closeSync(fd)}catch(e){if(e.code!=='EEXIST')throw e}
  const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw error('File SQLite harus berupa file biasa, bukan symlink.','SQLITE_PATH');
 }
 const database=new DatabaseSync(file);let closed=false,inTransaction=false,backupInProgress=false;
 try{database.exec(`PRAGMA busy_timeout=${busyTimeout}; PRAGMA foreign_keys=ON;`);
  // Do not alter the journal mode or create Zentix tables in an unrelated SQLite file.
  const initial=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
  if(initial.length&&!initial.includes('zentix_storage_meta'))throw error('File SQLite bukan database Zentix.','SQLITE_SCHEMA');
  if(initial.includes('zentix_storage_meta')){const prior=database.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get()?.value;if(prior!==undefined&&!['1','2','3','4'].includes(prior))throw error('Versi skema SQLite tidak didukung.','SQLITE_SCHEMA');if(prior===undefined&&initial.some(name=>name!=='zentix_storage_meta'))throw error('Skema SQLite tanpa versi tidak dikenali.','SQLITE_SCHEMA');}
  const mode=database.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode;if(file!==':memory:'&&String(mode).toLowerCase()!=='wal')throw error('SQLite WAL tidak tersedia.','SQLITE_UNAVAILABLE');
  database.exec('BEGIN IMMEDIATE');
  database.exec('CREATE TABLE IF NOT EXISTS zentix_storage_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const version=database.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get()?.value;
  if(version!==undefined&&!['1','2','3','4'].includes(version))throw error('Versi skema SQLite tidak didukung.','SQLITE_SCHEMA');
  const expected={zentix_kv:[['key','TEXT',1],['value','TEXT',0],['expires_at','INTEGER',0]],zentix_economy:[['guild_id','TEXT',1],['user_id','TEXT',2],['data','TEXT',0]],zentix_bot_kv:[['key','TEXT',1],['value','TEXT',0],['expires_at','INTEGER',0],...(['3','4'].includes(version)?[['updated_at','INTEGER',0]]:[])]};
  const exists=database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?");
  if(version==='4')expected.zentix_verification_audit=[['id','INTEGER',1],['guild_id','TEXT',0],['user_id','TEXT',0],['action','TEXT',0],['source','TEXT',0],['moderator_id','TEXT',0],['metadata','TEXT',0],['created_at','TEXT',0]];
  if(version!=='4'&&exists.get('zentix_verification_audit'))throw error('Tabel audit SQLite tidak dikenali.','SQLITE_SCHEMA');
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
  if(!['3','4'].includes(version))database.exec('ALTER TABLE zentix_bot_kv ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
  database.exec(`CREATE TABLE IF NOT EXISTS zentix_verification_audit (id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, source TEXT, moderator_id TEXT, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS zentix_verification_audit_guild ON zentix_verification_audit(guild_id,id);
   CREATE INDEX IF NOT EXISTS zentix_kv_expires ON zentix_kv(expires_at) WHERE expires_at IS NOT NULL;
   CREATE INDEX IF NOT EXISTS zentix_bot_kv_expires ON zentix_bot_kv(expires_at) WHERE expires_at IS NOT NULL;
   INSERT INTO zentix_storage_meta (key,value) VALUES ('schema_version','4') ON CONFLICT(key) DO UPDATE SET value=excluded.value; COMMIT;`);
 }catch(e){try{database.exec('ROLLBACK')}catch{}database.close();throw e;}
 const getKV=database.prepare('SELECT value,expires_at FROM zentix_kv WHERE key=?');
 const putKV=database.prepare('INSERT INTO zentix_kv(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at');
 const delKV=database.prepare('DELETE FROM zentix_kv WHERE key=?');
 const anyLevelAI=database.prepare("SELECT 1 AS found FROM zentix_kv WHERE key GLOB '*:leveling:users:*' LIMIT 1");
 const anyLevelBot=database.prepare("SELECT 1 AS found FROM zentix_bot_kv WHERE key GLOB '*:leveling:users:*' LIMIT 1");
 const anyAI=database.prepare("SELECT 1 AS found FROM zentix_kv WHERE substr(key,1,3)='ai:' LIMIT 1");
 const anyBotAI=database.prepare("SELECT 1 AS found FROM zentix_bot_kv WHERE substr(key,1,3)='ai:' LIMIT 1");
 const anyEconomyAccount=database.prepare('SELECT 1 AS found FROM zentix_economy LIMIT 1');
 const anyLegacyAI=database.prepare("SELECT 1 AS found FROM zentix_kv WHERE key GLOB 'economy:*' OR key GLOB 'guild:*:economy:*' LIMIT 1");
 const anyLegacyBot=database.prepare("SELECT 1 AS found FROM zentix_bot_kv WHERE key GLOB 'economy:*' OR key GLOB 'guild:*:economy:*' LIMIT 1");
 const getAccount=database.prepare('SELECT data FROM zentix_economy WHERE guild_id=? AND user_id=?');
 const putAccount=database.prepare('INSERT INTO zentix_economy(guild_id,user_id,data) VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET data=excluded.data');
 const getBot=database.prepare('SELECT value,expires_at FROM zentix_bot_kv WHERE key=?');
 const putBot=database.prepare('INSERT INTO zentix_bot_kv(key,value,expires_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at,updated_at=excluded.updated_at');
 const delBot=database.prepare('DELETE FROM zentix_bot_kv WHERE key=?');
 const listBot=database.prepare('SELECT key FROM zentix_bot_kv WHERE substr(key,1,length(?))=? AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT 10001');
 const listLevels=database.prepare('SELECT key,value FROM zentix_bot_kv WHERE (substr(key,1,length(?))=? OR substr(key,1,length(?))=?) AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT 10001');
 const listTickets=database.prepare("SELECT key,value,updated_at FROM zentix_bot_kv WHERE substr(key,1,length(?))=? AND length(substr(key,length(?)+1)) BETWEEN 17 AND 20 AND substr(key,length(?)+1) NOT GLOB '*[^0-9]*' AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC,key ASC LIMIT ?");
 const listAccounts=database.prepare("SELECT 'guild:'||guild_id||':economy:'||user_id AS key FROM zentix_economy WHERE substr('guild:'||guild_id||':economy:'||user_id,1,length(?))=? ORDER BY guild_id,user_id LIMIT 10001");
 const addAudit=database.prepare('INSERT INTO zentix_verification_audit(guild_id,user_id,action,source,moderator_id,metadata,created_at) VALUES(?,?,?,?,?,?,?)');
 const importAudit=database.prepare('INSERT INTO zentix_verification_audit(id,guild_id,user_id,action,source,moderator_id,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)');
 const anyAudit=database.prepare('SELECT 1 AS found FROM zentix_verification_audit LIMIT 1');
 const auditById=database.prepare('SELECT id,guild_id,user_id,action,source,moderator_id,metadata,created_at FROM zentix_verification_audit WHERE id=?');
 const readAudit=database.prepare('SELECT id,guild_id,user_id,action,source,moderator_id,metadata,created_at FROM zentix_verification_audit WHERE guild_id=? ORDER BY id DESC LIMIT ?');
 const pruneAI=database.prepare('DELETE FROM zentix_kv WHERE key IN (SELECT key FROM zentix_kv WHERE expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,key LIMIT ?)');
 const pruneBot=database.prepare('DELETE FROM zentix_bot_kv WHERE key IN (SELECT key FROM zentix_bot_kv WHERE expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at,key LIMIT ?)');
 const day=database.prepare("SELECT strftime('%Y-%m-%d','now') AS day");
 function open(){if(closed)throw error('SQLite sudah ditutup.','SQLITE_CLOSED')}
 function checkKey(k){if(!validKey(k))throw error('Key SQLite tidak valid.')}
 function checkIds(g,u){if(!validId(g)||!validId(u))throw error('ID akun tidak valid.')}
 function auditArgs(record){if(!record||!validId(record.guildId)||!validId(record.userId)||typeof record.action!=='string'||!record.action||record.action.length>50||(record.source!=null&&(typeof record.source!=='string'||record.source.length>50))||(record.moderatorId!=null&&!validId(record.moderatorId)))throw error('Audit verifikasi tidak valid.');const created=new Date(record.createdAt??Date.now());if(Number.isNaN(created.getTime()))throw error('Waktu audit tidak valid.');const metadata=encode(record.metadata??{});if(Buffer.byteLength(metadata)>65536)throw error('Metadata audit terlalu besar.');return [record.guildId,record.userId,record.action,record.source??null,record.moderatorId??null,metadata,created.toISOString()]}
 function auditRow(row){return {id:row.id,guildId:row.guild_id,userId:row.user_id,action:row.action,source:row.source,moderatorId:row.moderator_id,metadata:decode(row.metadata),createdAt:row.created_at}}
 const ops={
  // Raw existence includes expired or JSON-null values; migration must not silently overwrite them.
  hasRawKey(key){open();checkKey(key);return Boolean(getKV.get(key)||getBot.get(key))},
  hasRawAIKey(key){open();checkKey(key);return Boolean(getKV.get(key))},
  botGetRaw(key){open();checkKey(key);const row=getBot.get(key);return row?{value:decode(row.value),expiresAt:row.expires_at}:null},
  hasAnyEconomyData(){open();return Boolean(anyEconomyAccount.get()||anyLegacyAI.get()||anyLegacyBot.get())},
  hasAnyAIData(){open();return Boolean(anyAI.get()||anyBotAI.get())},
  hasAnyLevelData(){open();return Boolean(anyLevelAI.get()||anyLevelBot.get())},
  get(key){open();checkKey(key);const row=getKV.get(key);return !row||(row.expires_at!==null&&row.expires_at<=Date.now())?null:decode(row.value)},
  set(key,value,expiresAt=null){open();checkKey(key);if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<0))throw error('Kedaluwarsa tidak valid.');putKV.run(key,encode(value),expiresAt)},
  delete(key){open();checkKey(key);return Number(delKV.run(key).changes)>0},
  botGet(key){open();checkKey(key);const row=getBot.get(key);return !row||(row.expires_at!==null&&row.expires_at<=Date.now())?null:decode(row.value)},
  botSet(key,value,expiresAt=null){open();checkKey(key);if(expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<0))throw error('Kedaluwarsa tidak valid.');putBot.run(key,encode(value),expiresAt,Date.now())},
  botDelete(key){open();checkKey(key);return Number(delBot.run(key).changes)>0},
  botList(prefix=''){open();if(typeof prefix!=='string'||prefix.length>255||/[\u0000-\u001f]/.test(prefix))throw error('Prefix tidak valid.');const rows=listBot.all(prefix,prefix,Date.now());if(rows.length>10000)throw error('Terlalu banyak key untuk didaftar.','SQLITE_LIST_LIMIT');return rows.map(row=>row.key)},
  botLevels(guild){open();if(!validId(guild))throw error('Guild tidak valid.');const canonical=`guild:${guild}:leveling:users:`,legacy=`${guild}:leveling:users:`,rows=listLevels.all(canonical,canonical,legacy,legacy,Date.now());if(rows.length>10000)throw error('Terlalu banyak akun level.','SQLITE_LIST_LIMIT');const found=new Map();for(const row of rows){const isCanonical=row.key.startsWith(canonical),user=row.key.slice((isCanonical?canonical:legacy).length);if(!validId(user))continue;const value=decode(row.value);if(value!==null&&(!found.has(user)||isCanonical))found.set(user,value);}return [...found].map(([userId,data])=>({userId,data}))},
  botTickets(guild,limit){open();if(!validId(guild)||!Number.isInteger(limit)||limit<1||limit>1000)throw error('Batas atau guild tidak valid.');const prefix=`guild:${guild}:ticket:`;return listTickets.all(prefix,prefix,prefix,prefix,Date.now(),limit).map(row=>({key:row.key,value:decode(row.value),updatedAt:row.updated_at}))},
  accountKeys(prefix=''){open();if(typeof prefix!=='string'||prefix.length>255||/[\u0000-\u001f]/.test(prefix))throw error('Prefix tidak valid.');const rows=listAccounts.all(prefix,prefix);if(rows.length>10000)throw error('Terlalu banyak akun untuk didaftar.','SQLITE_LIST_LIMIT');return rows.map(row=>row.key)},
  getAccount(g,u){open();checkIds(g,u);const row=getAccount.get(g,u);return row?decode(row.data):null},
  setAccount(g,u,value){open();checkIds(g,u);if(!value||typeof value!=='object'||Array.isArray(value))throw error('Akun tidak valid.');putAccount.run(g,u,encode(value))},
  addVerificationAudit(record){open();addAudit.run(...auditArgs(record))},
  hasAnyVerificationAudit(){open();return Boolean(anyAudit.get())},
  importVerificationAudit(record){open();if(!Number.isSafeInteger(record?.id)||record.id<1||record.id>2147483647)throw error('ID audit tidak valid.');importAudit.run(record.id,...auditArgs(record))},
  verificationAuditById(id){open();if(!Number.isSafeInteger(id)||id<1)throw error('ID audit tidak valid.');const row=auditById.get(id);return row?auditRow(row):null},
  verificationAudit(guild,limit=100){open();if(!validId(guild)||!Number.isInteger(limit)||limit<1||limit>1000)throw error('Permintaan audit tidak valid.');return readAudit.all(guild,limit).map(auditRow)},
  cleanupExpired(now,limit){open();if(!Number.isSafeInteger(now)||now<0||!Number.isInteger(limit)||limit<1||limit>1000)throw error('Batas pembersihan tidak valid.');const ai=Number(pruneAI.run(now,limit).changes),bot=Number(pruneBot.run(now,limit-ai).changes);return {ai,bot,total:ai+bot}},
  utcDay(){open();return day.get().day},
 };
 return {
  dialect:'sqlite',file,
  isOpen(){return !closed},
  get(key){return ops.get(key)},
  getAccount(g,u){return ops.getAccount(g,u)},
  botGet(key){return ops.botGet(key)},
  verificationAudit(guild,limit=100){return ops.verificationAudit(guild,limit)},
  botList(prefix=''){return ops.botList(prefix)},
  botTickets(guild,limit){return ops.botTickets(guild,limit)},
  botLevels(guild){return ops.botLevels(guild)},
  accountKeys(prefix=''){return ops.accountKeys(prefix)},
  set(key,value,expiresAt=null){return this.transaction(tx=>tx.set(key,value,expiresAt))},
  cleanupExpired({now=Date.now(),limit=500}={}){return this.transaction(tx=>tx.cleanupExpired(now,limit))},
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
