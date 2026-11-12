import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openSQLiteStore} from '../src/services/storage/sqlite.js';import {convertEconomyRow,importEconomyBatch} from '../src/services/migration/economyBatch.js';import {withEconomyTransaction} from '../src/services/economy/transaction.js';
const g='123456789012345678',a='234567890123456789',b='345678901234567890';
function row(user=a,extra={}){return {guild_id:g,user_id:user,balance_text:'42',bank_text:'10',data_text:'{"wallet":42,"bank":10,"inventory":{"item":{"qty":2}},"note":"value 9007199254740993"}',...extra}}
function file(t){let dir=mkdtempSync(join(tmpdir(),'zentix-econ-migrate-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'db.sqlite')}
function client(db){return {homeGuildId:g,db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{sqlite:db,isAvailable:()=>true}}}}
test('imports matching structured account rows atomically, checks totals and survives reopen',async t=>{
 const path=file(t);let db=await openSQLiteStore({path});const result=importEconomyBatch(db,g,[row(),row(b,{balance_text:'0',bank_text:'7',data_text:'{}'})]);assert.deepEqual(result,{accounts:2,walletTotal:'42',bankTotal:'17'});assert.equal(db.getAccount(g,a).inventory.item.qty,2);assert.deepEqual(db.getAccount(g,b),{wallet:0,bank:7});db.close();db=await openSQLiteStore({path});assert.equal(db.getAccount(g,a).wallet,42);await withEconomyTransaction(client(db),g,[a,b],m=>{m.get(a).wallet-=3;m.get(b).wallet+=3});assert.equal(db.getAccount(g,a).wallet,39);assert.equal(db.getAccount(g,b).wallet,3);db.close();
});
test('rejects conflicts and invalid input before modifying SQLite',async t=>{
 const db=await openSQLiteStore({path:file(t)});for(const bad of [row(b,{balance_text:'-1'}),row(b,{bank_text:'9007199254740992'}),row(b,{data_text:'{"wallet":41,"bank":10}'}),row(b,{data_text:'{"wallet":42}'}),row(b,{data_text:'null'}),row(b,{guild_id:a}),row(b,{data_text:'{"wallet":42,"bank":10,"inventory":[]}'}),row(b,{user_id:'bad'}),row()]){assert.throws(()=>importEconomyBatch(db,g,[row(),bad]));assert.equal(db.getAccount(g,a),null);assert.equal(db.getAccount(g,b),null)}db.close();
});
test('rejects precision loss anywhere in JSONB while allowing numeric text inside strings',()=>{
 for(const value of ['9007199254740992','-9007199254740992','1.01','1e10','0.00000000000000000001'])assert.throws(()=>convertEconomyRow(row(a,{data_text:`{"wallet":42,"bank":10,"extra":${value}}`}),g),{code:'MIGRATION_UNSAFE_NUMBER'});
 const parsed=convertEconomyRow(row(a,{data_text:'{"wallet":42,"bank":10,"extra":"escaped \\\" 999999999999999999999 and 0.1","small":9007199254740991}'}),g);assert.equal(parsed.account.small,Number.MAX_SAFE_INTEGER);assert.match(parsed.account.extra,/999999999999999999999/);
});
test('never overwrites account or raw expired/null legacy keys, including a later batch row',async t=>{
 const db=await openSQLiteStore({path:file(t)});db.transaction(tx=>tx.botSet(`economy:${g}:${b}`,null,Date.now()-10000));assert.throws(()=>importEconomyBatch(db,g,[row(),row(b)]),{code:'MIGRATION_DESTINATION_CONFLICT'});assert.equal(db.getAccount(g,a),null);db.transaction(tx=>tx.botDelete(`economy:${g}:${b}`));importEconomyBatch(db,g,[row(b)]);assert.throws(()=>importEconomyBatch(db,g,[row(),row(b)]),{code:'MIGRATION_DESTINATION_CONFLICT'});assert.equal(db.getAccount(g,a),null);assert.equal(db.getAccount(g,b).wallet,42);db.close();
});
test('write errors roll back all rows in the batch',async t=>{
 const db=await openSQLiteStore({path:file(t)}),faulty={dialect:'sqlite',isOpen:()=>true,transaction:fn=>db.transaction(tx=>fn({...tx,setAccount:(g,u,data)=>{if(u===b)throw Error('injected failure');tx.setAccount(g,u,data)}}))};assert.throws(()=>importEconomyBatch(faulty,g,[row(),row(b)]),/injected failure/);assert.equal(db.getAccount(g,a),null);assert.equal(db.getAccount(g,b),null);db.close();
});
test('caps batches and payload and preserves values with string escape sequences',async t=>{
 const db=await openSQLiteStore({path:file(t)});assert.throws(()=>importEconomyBatch(db,g,[]));assert.throws(()=>importEconomyBatch(db,g,Array(501).fill(row())));assert.throws(()=>convertEconomyRow(row(a,{data_text:JSON.stringify({wallet:42,bank:10,text:'x'.repeat(65536)})}),g));const source={wallet:42,bank:10,note:'quote " and slash \\ 123.123'};importEconomyBatch(db,g,[row(a,{data_text:JSON.stringify(source)})]);assert.deepEqual(db.getAccount(g,a),source);db.close();
});
test('independent processes cannot both import the same account',async t=>{
 const {spawn}=await import('node:child_process');const path=file(t),db=await openSQLiteStore({path,busyTimeout:5000});const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['tests/fixtures/sqlite-economy-migration-worker.js',path,g,a],{stdio:['ignore','ignore','pipe','ipc']});let out='',err='';p.on('message',x=>out=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(Error(err)))});assert.deepEqual((await Promise.all([run(),run()])).sort(),['committed','conflict']);assert.deepEqual(db.getAccount(g,a),{wallet:42,bank:1});db.close();
});
test('reconciliation totals use BigInt across individually safe account balances',async t=>{
 const db=await openSQLiteStore({path:file(t)}),max='9007199254740991';const result=importEconomyBatch(db,g,[row(a,{balance_text:max,bank_text:'0',data_text:'{}'}),row(b,{balance_text:max,bank_text:'0',data_text:'{}'})]);assert.equal(result.walletTotal,'18014398509481982');db.close();
});
test('reconciliation mismatch and unrelated legacy data roll back before any write',async t=>{
 const db=await openSQLiteStore({path:file(t)});assert.throws(()=>importEconomyBatch(db,g,[row()],{expectedTotals:{wallet:'43',bank:'10'}}),{code:'MIGRATION_VERIFY_FAILED'});assert.equal(db.getAccount(g,a),null);
 db.transaction(tx=>tx.set(`economy:${g}:${b}`,null,Date.now()-1000));assert.throws(()=>importEconomyBatch(db,g,[row()],{requireEmptyDestination:true}),{code:'MIGRATION_DESTINATION_CONFLICT'});assert.equal(db.getAccount(g,a),null);db.close();
});
