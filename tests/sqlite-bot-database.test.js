import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {openSQLiteStore} from '../src/services/storage/sqlite.js';
import {createSQLiteBotDatabase} from '../src/services/storage/sqliteBotDatabase.js';
import {withEconomyTransaction} from '../src/services/economy/transaction.js';
const g='123456789012345678',u='234567890123456789';
function file(t){const dir=mkdtempSync(join(tmpdir(),'zentix-bot-kv-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'data.db')}
function client(adapter){return {homeGuildId:g,db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:adapter}}}
test('SQLite bot key-value CRUD, TTL and AI namespace isolation persist after restart',async t=>{
 const path=file(t);let s=await openSQLiteStore({path}),db=createSQLiteBotDatabase(s);s.set('ai:foundation:config:test',{ai:true});await db.set('ai:foundation:config:test',{bot:true});assert.deepEqual(s.get('ai:foundation:config:test'),{ai:true});assert.deepEqual(await db.get('ai:foundation:config:test'),{bot:true});
 assert.equal(await db.get('absent','default'),'default');assert.equal(await db.set('cache:test','value',0.002),true);await new Promise(r=>setTimeout(r,10));assert.equal(await db.get('cache:test'),null);assert.equal(await db.exists('cache:test'),false);
 // Structured PostgreSQL rows do not expire based on the generic TTL argument.
 await db.set(`guild:${g}:ticket:${u}`,{status:'open'},0.001);await new Promise(r=>setTimeout(r,8));assert.deepEqual(await db.get(`guild:${g}:ticket:${u}`),{status:'open'});await assert.rejects(db.set('test','value',-1));
 s.close();assert.equal(db.isAvailable(),false);await assert.rejects(db.get('test'),{code:'SQLITE_UNAVAILABLE'});s=await openSQLiteStore({path});db=createSQLiteBotDatabase(s);assert.deepEqual(await db.get('ai:foundation:config:test'),{bot:true});assert.deepEqual(s.get('ai:foundation:config:test'),{ai:true});s.close();
});
test('legacy aliases read, list and delete consistently; canonical values take priority',async t=>{
 const s=await openSQLiteStore({path:file(t)}),db=createSQLiteBotDatabase(s),canonical=`guild:${g}:warnings:${u}`,legacy=`moderation:warnings:${g}:${u}`;
 s.transaction(tx=>tx.botSet(legacy,[{id:1}]));assert.deepEqual(await db.get(canonical),[{id:1}]);assert.deepEqual(await db.list(`guild:${g}:warnings:`),[canonical]);assert.deepEqual(await db.list(`moderation:warnings:${g}:`),[canonical]);
 await db.set(canonical,[{id:2}]);assert.deepEqual(await db.get(legacy),[{id:2}]);await db.delete(canonical);assert.equal(await db.get(legacy),null);assert.deepEqual(await db.list(`guild:${g}:`),[]);s.close();
});
test('economy keys resolve to transaction accounts and block stale and legacy writes',async t=>{
 const s=await openSQLiteStore({path:file(t)}),db=createSQLiteBotDatabase(s),c=client(db),canonical=`guild:${g}:economy:${u}`,legacy=`economy:${g}:${u}`;
 s.transaction(tx=>tx.botSet(legacy,{wallet:10}));await assert.rejects(db.get(canonical),{code:'ECONOMY_LEGACY'});await assert.rejects(withEconomyTransaction(c,g,[u],()=>{}),{code:'ECONOMY_LEGACY'});await assert.rejects(db.set(canonical,{wallet:1}),{code:'ECONOMY_LEGACY_WRITE_DISABLED'});await assert.rejects(db.delete(legacy),{code:'ECONOMY_LEGACY_WRITE_DISABLED'});
 s.transaction(tx=>tx.botDelete(legacy));await withEconomyTransaction(c,g,[u],m=>{m.get(u).wallet=123});assert.equal((await db.get(legacy)).wallet,123);assert.deepEqual(await db.list(`economy:${g}:`),[canonical]);assert.deepEqual(await db.list(`guild:${g}:`),[canonical]);s.close();
});
test('increment and decrement are atomic across separate processes',async t=>{
 const path=file(t),s=await openSQLiteStore({path,busyTimeout:5000}),db=createSQLiteBotDatabase(s);await db.set('test:counter',0);
 await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['tests/fixtures/sqlite-bot-counter-worker.js',path],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(`worker ${code}: ${err}`)));})));assert.equal(await db.get('test:counter'),300);assert.equal(await db.decrement('test:counter',2),298);await assert.rejects(db.increment('test:counter',Number.MAX_SAFE_INTEGER));assert.equal(await db.get('test:counter'),298);s.close();
});
test('schema version 1 migrates to version 4 without altering existing AI or economy data',async t=>{
 const path=file(t),{DatabaseSync}=await import('node:sqlite'),raw=new DatabaseSync(path);raw.exec(`CREATE TABLE zentix_storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO zentix_storage_meta VALUES('schema_version','1');CREATE TABLE zentix_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);INSERT INTO zentix_kv VALUES('ai:config','{"old":true}',NULL);CREATE TABLE zentix_economy(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,user_id));INSERT INTO zentix_economy VALUES('${g}','${u}','{"wallet":21,"bank":0}');`);raw.close();
 const s=await openSQLiteStore({path}),db=createSQLiteBotDatabase(s);assert.deepEqual(s.get('ai:config'),{old:true});assert.equal(s.getAccount(g,u).wallet,21);await db.set('counter',1);s.close();const check=new DatabaseSync(path);assert.equal(check.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get().value,'4');check.close();
});
test('version 2 upgrades with all prior bot data and initializes update ordering',async t=>{
 const path=file(t),{DatabaseSync}=await import('node:sqlite'),raw=new DatabaseSync(path);raw.exec(`CREATE TABLE zentix_storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO zentix_storage_meta VALUES('schema_version','2');CREATE TABLE zentix_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);CREATE TABLE zentix_economy(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(guild_id,user_id));CREATE TABLE zentix_bot_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);INSERT INTO zentix_bot_kv VALUES('example','42',NULL);`);raw.close();
 const s=await openSQLiteStore({path});assert.equal(await createSQLiteBotDatabase(s).get('example'),42);s.close();const check=new DatabaseSync(path);assert.equal(check.prepare("SELECT value FROM zentix_storage_meta WHERE key='schema_version'").get().value,'4');assert.equal(check.prepare("SELECT updated_at FROM zentix_bot_kv WHERE key='example'").get().updated_at,0);check.close();
});
test('missing or unversioned tables fail closed instead of creating empty replacements',async t=>{
 const path=file(t),{DatabaseSync}=await import('node:sqlite'),raw=new DatabaseSync(path);raw.exec("CREATE TABLE zentix_storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO zentix_storage_meta VALUES('schema_version','3');");raw.close();await assert.rejects(openSQLiteStore({path}),{code:'SQLITE_SCHEMA'});
 const check=new DatabaseSync(path);assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='zentix_kv'").get().n,0);check.close();
 const path2=join(path,'..','unversioned.db'),broken=new DatabaseSync(path2);broken.exec('CREATE TABLE zentix_kv(key TEXT)');broken.close();await assert.rejects(openSQLiteStore({path:path2}),{code:'SQLITE_SCHEMA'});
});
test('SQLite ticket counter allocation is atomic through the bot wrapper',async t=>{
 const sqlite=await openSQLiteStore({path:file(t)}),adapter=createSQLiteBotDatabase(sqlite),{db:wrapper}=await import('../src/utils/database/wrapper.js'),{incrementTicketCounter}=await import('../src/utils/database/tickets.js');const old={db:wrapper.db,initialized:wrapper.initialized,useFallback:wrapper.useFallback};wrapper.db=adapter;wrapper.initialized=true;wrapper.useFallback=false;t.after(()=>{Object.assign(wrapper,old);sqlite.close()});
 const allocated=await Promise.all(Array.from({length:30},()=>incrementTicketCounter(g)));assert.equal(new Set(allocated).size,30);assert.equal(allocated[0],'001');assert.equal(allocated.at(-1),'030');
});
test('SQLite disables role purchase before touching Discord and blocks partial data wipe',async t=>{
 const sqlite=await openSQLiteStore({path:file(t)}),adapter=createSQLiteBotDatabase(sqlite),c=client(adapter),{default:buy}=await import('../src/commands/Economy/buy.js'),{wipedataConfirmHandler}=await import('../src/handlers/wipedataButtons.js');let roleCalls=0,wipedMessage;
 const interaction={id:'999999999999999999',guildId:g,user:{id:u,tag:'test'},options:{getString:()=> 'premium_role',getInteger:()=>1},deferred:true,replied:false,isChatInputCommand:()=>true,member:{roles:{add:async()=>{roleCalls++}}},editReply:async value=>{wipedMessage=value}};
 await assert.rejects(buy.execute(interaction,{},c));assert.equal(roleCalls,0);await adapter.set(`guild:${g}:warnings:${u}`,[{id:1}]);await wipedataConfirmHandler.execute(interaction,c);assert.match(wipedMessage.content,/No data was deleted/);assert.deepEqual(await adapter.get(`guild:${g}:warnings:${u}`),[{id:1}]);sqlite.close();
});
