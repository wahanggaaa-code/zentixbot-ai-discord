import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {openSQLiteStore} from '../src/services/storage/sqlite.js';
import {withEconomyTransaction} from '../src/services/economy/transaction.js';
import {getEconomyData,setEconomyData} from '../src/utils/economy.js';
import {createAIStore,DEFAULT_AI} from '../src/services/ai/foundation.js';
import {createAIWelcomeStore,DEFAULT_AI_WELCOME} from '../src/services/ai/welcome.js';
import {createChatStore,DEFAULT_CHAT} from '../src/services/ai/chat.js';
import {createKnowledgeStore} from '../src/services/ai/knowledge.js';
import {createActivityStore} from '../src/services/ai/activities.js';
const guild='123456789012345678',a='234567890123456789',b='345678901234567890';
function client(sqlite){return {homeGuildId:guild,db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{sqlite,isAvailable:()=>true}}}}
function path(t){const dir=mkdtempSync(join(tmpdir(),'zentix-sqlite-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'data.db')}
test('file persistence, expiration, transaction rollback and transaction lifetime',async t=>{
 const file=path(t);let db=await openSQLiteStore({path:file});db.set('test',{x:1});db.set('expired',1,Date.now()-1);assert.equal(db.get('expired'),null);let escaped;
 assert.throws(()=>db.transaction(tx=>{escaped=tx;tx.set('test',{x:2});throw Error('rollback')}));assert.deepEqual(db.get('test'),{x:1});assert.throws(()=>escaped.set('no',1));assert.throws(()=>db.transaction(async()=>{}));assert.throws(()=>db.transaction(()=>db.transaction(()=>{})));
 db.close();db=await openSQLiteStore({path:file});assert.deepEqual(db.get('test'),{x:1});db.close();
});
test('independent processes serialize writes to a real WAL database',async t=>{
 const file=path(t),db=await openSQLiteStore({path:file,busyTimeout:5000});db.set('counter',0);
 const jobs=Array.from({length:4},()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['tests/fixtures/sqlite-increment-worker.js',file],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(`worker ${code}: ${err}`)));}));await Promise.all(jobs);assert.equal(db.get('counter'),400);db.close();
});
test('economy transactions preserve both accounts on rollback and reject legacy and stale writes',async t=>{
 const file=path(t),db=await openSQLiteStore({path:file}),c=client(db);
 await withEconomyTransaction(c,guild,[a,b],m=>{m.get(a).wallet=100;m.get(b).wallet=10});
 await assert.rejects(withEconomyTransaction(c,guild,[a,b],m=>{m.get(a).wallet-=20;m.get(b).wallet+=20;throw Error('abort')}));
 assert.equal((await getEconomyData(c,guild,a)).wallet,100);assert.equal(db.getAccount(guild,b).wallet,10);
 await Promise.all(Array.from({length:20},()=>withEconomyTransaction(c,guild,[a,b],m=>{m.get(a).wallet--;m.get(b).wallet++})));assert.equal(db.getAccount(guild,a).wallet,80);assert.equal(db.getAccount(guild,b).wallet,30);
 await assert.rejects(setEconomyData(c,guild,a,{wallet:1}),{code:'ECONOMY_LEGACY_WRITE_DISABLED'});
 const other='456789012345678901';db.set(`economy:${guild}:${other}`,{wallet:999});await assert.rejects(withEconomyTransaction(c,guild,[other],()=>{}),{code:'ECONOMY_LEGACY'});assert.equal(db.getAccount(guild,other),null);await assert.rejects(getEconomyData(c,guild,other),{code:'ECONOMY_LEGACY'});
 db.close();const reopened=await openSQLiteStore({path:file});assert.equal(reopened.getAccount(guild,a).wallet,80);reopened.close();
});
test('AI settings, quota and documents use SQLite and survive reopening',async t=>{
 const file=path(t);let db=await openSQLiteStore({path:file}),c=client(db),ai=createAIStore(c),welcome=createAIWelcomeStore(c),chat=createChatStore(c),knowledge=createKnowledgeStore(c);
 await ai.save(guild,{...DEFAULT_AI,perUserDaily:2,guildDaily:3});await welcome.save(guild,{...DEFAULT_AI_WELCOME,tone:'formal'});await chat.save(guild,{...DEFAULT_CHAT,persona:'Hai'});
 const quota=await Promise.allSettled(Array.from({length:4},()=>ai.reserve(guild,a,{perUserDaily:2,guildDaily:3})));assert.equal(quota.filter(x=>x.status==='fulfilled').length,2);assert.equal(quota.filter(x=>x.status==='rejected'&&x.reason.code==='LIMIT_REACHED').length,2);
 const docs=await Promise.all(Array.from({length:5},(_,i)=>knowledge.add(guild,`doc${i}.txt`,'Isi dokumen')));assert.equal((await knowledge.read(guild)).length,5);await knowledge.remove(guild,docs[0].id);db.close();
 db=await openSQLiteStore({path:file});c=client(db);assert.equal((await createAIStore(c).read(guild)).perUserDaily,2);assert.equal((await createAIWelcomeStore(c).read(guild)).tone,'formal');assert.equal((await createChatStore(c).read(guild)).persona,'Hai');assert.equal((await createKnowledgeStore(c).read(guild)).length,4);await assert.rejects(createAIStore(c).reserve(guild,a,{perUserDaily:2,guildDaily:3}),{code:'LIMIT_REACHED'});db.close();
});
test('unavailable or degraded adapter fails closed',async()=>{const db=await openSQLiteStore();const c=client(db);c.db.getStatus=()=>({isDegraded:true});await assert.rejects(createAIStore(c).read(guild),{code:'STORAGE_UNAVAILABLE'});await assert.rejects(withEconomyTransaction(c,guild,[a],()=>{}),{code:'ECONOMY_UNAVAILABLE'});db.close();});

test('Activities awards separate points once atomically and rejects duplicate or overflow awards',async t=>{
 const file=path(t),db=await openSQLiteStore({path:file}),store=createActivityStore(client(db)),q={question:'Planet?',options:['A','B','C','D'],answer:1},now=100000;
 assert.deepEqual(await Promise.all([store.claimSchedule(guild,'2026-11-12'),store.claimSchedule(guild,'2026-11-12')]),[true,false]);
 await store.reserve(guild,'r1',now);await store.open(guild,'r1',q,60,now,30);await store.attach(guild,'r1','message');
 assert.equal((await store.status(guild,now)).answer,undefined);const outcomes=await Promise.all([store.answer(guild,'r1','message',a,1,now),store.answer(guild,'r1','message',a,1,now)]);assert.deepEqual(outcomes.map(x=>x.status),['correct','closed']);assert.equal(await store.points(guild,a),30);assert.equal(db.getAccount(guild,a),null);
 await store.reserve(guild,'r2',now);await store.open(guild,'r2',q,60,now,30);await store.attach(guild,'r2','message2');db.set(`ai:activity:points:${guild}:${a}`,{points:Number.MAX_SAFE_INTEGER});await assert.rejects(store.answer(guild,'r2','message2',a,1,now));assert.equal((await store.status(guild,now)).state,'open');
 db.close();const reopened=await openSQLiteStore({path:file});assert.equal(await createActivityStore(client(reopened)).points(guild,a),Number.MAX_SAFE_INTEGER);reopened.close();
});
test('unsupported schema is rejected without creating application tables',async t=>{
 const file=path(t),{DatabaseSync}=await import('node:sqlite'),raw=new DatabaseSync(file);raw.exec("CREATE TABLE zentix_storage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO zentix_storage_meta VALUES('schema_version','999');");raw.close();
 await assert.rejects(openSQLiteStore({path:file}),{code:'SQLITE_SCHEMA'});const check=new DatabaseSync(file);assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='zentix_kv'").get().n,0);check.close();
});
test('busy second writer fails rather than silently losing a transaction',async t=>{
 const file=path(t),first=await openSQLiteStore({path:file,busyTimeout:10}),second=await openSQLiteStore({path:file,busyTimeout:10});first.set('n',0);
 first.transaction(tx=>{tx.set('n',1);assert.throws(()=>second.transaction(other=>other.set('n',2)));});assert.equal(second.get('n'),1);first.close();second.close();
});
test('economy commits from independent processes are serialized',async t=>{
 const file=path(t),db=await openSQLiteStore({path:file,busyTimeout:5000}),c=client(db);await withEconomyTransaction(c,guild,[a],m=>{m.get(a).wallet=0});
 await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['tests/fixtures/sqlite-economy-worker.js',file,guild,a],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(`worker ${code}: ${err}`)));})));assert.equal(db.getAccount(guild,a).wallet,200);db.close();
});
test('corrupt AI quota fails closed without resetting the counter',async t=>{
 const db=await openSQLiteStore({path:path(t)});db.set(`ai:foundation:usage:g:${guild}`,false);await assert.rejects(createAIStore(client(db)).reserve(guild,a,{perUserDaily:2,guildDaily:3}),{code:'STORAGE_UNAVAILABLE'});assert.equal(db.get(`ai:foundation:usage:g:${guild}`),false);db.close();
});
test('online SQLite backup includes WAL data, restores consistently, and refuses overwrite',async t=>{
 const source=path(t),backup=join(source,'..','snapshot.db'),db=await openSQLiteStore({path:source});db.set('committed',{value:'wal-data'});db.transaction(tx=>{tx.set('backup:left',0);tx.set('backup:right',0)});
 const child=spawn(process.execPath,['tests/fixtures/sqlite-backup-writer.js',source],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{if(child.exitCode===null)child.kill()});let err='';child.stderr.on('data',x=>err+=x);const worker=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`worker ${code}: ${err}`)))});
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('message',message=>{if(message==='ready')child.send('start');if(message==='writing')resolve()})});
 const pending=db.backupTo(backup);assert.throws(()=>db.close(),{code:'SQLITE_BUSY'});const result=await pending;assert.equal(result.path,backup);assert.equal(statSync(backup).mode&0o077,0);await worker;await assert.rejects(db.backupTo(backup),{code:'EEXIST'});await assert.rejects(db.backupTo(source));
 const restored=await openSQLiteStore({path:backup});assert.deepEqual(restored.get('committed'),{value:'wal-data'});assert.equal(restored.get('backup:left'),restored.get('backup:right'));restored.close();db.close();
});
