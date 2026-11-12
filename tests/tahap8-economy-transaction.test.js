import test from 'node:test';import assert from 'node:assert/strict';import {withEconomyTransaction} from '../src/services/economy/transaction.js';import EconomyService from '../src/services/economyService.js';
const gid='123456789012345678',a='234567890123456789',b='345678901234567890';
// Mock transactions serialize at BEGIN. This tests SQL contract and rollback logic, not real PostgreSQL row locking.
function fixture(initial={}){
 const legacy=new Set();let rows=new Map(Object.entries(initial).map(([k,data])=>[k,{user_id:k,balance:data.wallet,bank:data.bank,data:structuredClone(data)}])),tail=Promise.resolve(),failOnUser=null,commands=[];
 const pool={connect:async()=>{let local,unlock;return {release(){},query:async(sql,args=[])=>{commands.push({sql,args});if(sql==='BEGIN'){const prior=tail;tail=new Promise(r=>unlock=r);await prior;local=new Map([...rows].map(([k,v])=>[k,structuredClone(v)]));return {rows:[]}}if(sql==='ROLLBACK'){unlock();return {rows:[]}}if(sql==='COMMIT'){rows=local;unlock();return {rows:[]}}if(sql.startsWith('SELECT 1 FROM economy'))return {rows:local.has(args[1])?[{exists:1}]:[]};if(sql.startsWith('SELECT 1 FROM temp_data'))return {rows:args[0].some(k=>legacy.has(k))?[{exists:1}]:[]};if(sql.startsWith('INSERT INTO economy ')){const [,user,wallet,bank,json]=args;if(!local.has(user))local.set(user,{user_id:user,balance:wallet,bank,data:JSON.parse(json)});return {rows:[],rowCount:1}}if(sql.startsWith('INSERT'))return {rows:[]};if(sql.startsWith('SELECT user_id,balance'))return {rows:args[1].filter(x=>local.has(x)).map(x=>structuredClone(local.get(x)))};if(sql.startsWith('UPDATE economy')){const [,user,wallet,bank,json]=args;if(user===failOnUser)throw Error('simulated DB error');local.set(user,{user_id:user,balance:wallet,bank,data:JSON.parse(json)});return {rowCount:1,rows:[]}}throw Error('unexpected SQL: '+sql)}}}};
 const client={db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool}}};return {client,commands,read:user=>structuredClone(rows.get(user)?.data),fail:user=>{failOnUser=user},legacy:key=>legacy.add(key)};
}
test('transaction preserves data, initializes accounts and locks in deterministic order',async()=>{
 const f=fixture({[a]:{wallet:100,bank:20,custom:'preserved'}});const result=await withEconomyTransaction(f.client,gid,[b,a],accounts=>{accounts.get(a).wallet-=10;accounts.get(b).wallet+=10;return 'ok'});assert.equal(result,'ok');assert.equal(f.read(a).wallet,90);assert.equal(f.read(a).custom,'preserved');assert.equal(f.read(b).wallet,10);const select=f.commands.find(x=>x.sql.includes('FOR UPDATE'));assert.deepEqual(select.args[1],[a,b]);assert.match(select.sql,/ORDER BY user_id FOR UPDATE/);
});
test('transaction rolls back all writes if second update fails',async()=>{
 const f=fixture({[a]:{wallet:100,bank:0},[b]:{wallet:10,bank:0}});f.fail(b);await assert.rejects(withEconomyTransaction(f.client,gid,[a,b],accounts=>{accounts.get(a).wallet-=10;accounts.get(b).wallet+=10}));assert.equal(f.read(a).wallet,100);assert.equal(f.read(b).wallet,10);assert.ok(f.commands.some(x=>x.sql==='ROLLBACK'));
});
test('transaction rejects invalid identities, unsafe balances and async mutations',async()=>{
 const f=fixture({[a]:{wallet:100,bank:0}});await assert.rejects(withEconomyTransaction(f.client,gid,[a,a],()=>{}));await assert.rejects(withEconomyTransaction(f.client,gid,[a],m=>{m.get(a).wallet=Number.MAX_SAFE_INTEGER+1}));await assert.rejects(withEconomyTransaction(f.client,gid,[a],async()=>{}));assert.equal(f.read(a).wallet,100);await assert.rejects(withEconomyTransaction({db:{getStatus:()=>({isDegraded:true})}},gid,[a],()=>{}));
});
test('transfer uses a single transaction and handles concurrency and insufficient funds',async()=>{
 const f=fixture({[a]:{wallet:100,bank:0},[b]:{wallet:0,bank:0}});const outcomes=await Promise.allSettled([EconomyService.transferMoney(f.client,gid,a,b,70),EconomyService.transferMoney(f.client,gid,a,b,70)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);assert.equal(f.read(a).wallet,30);assert.equal(f.read(b).wallet,70);assert.equal(f.commands.filter(x=>x.sql==='COMMIT').length,1);assert.equal(f.commands.filter(x=>x.sql==='ROLLBACK').length,1);
});

test('robbery changes both accounts and cooldown atomically',async()=>{
 const {attemptRob}=await import('../src/services/economy/rob.js');const f=fixture({[a]:{wallet:100,bank:0,lastRob:0},[b]:{wallet:1000,bank:0,inventory:{}}});const args={client:f.client,guildId:gid,robberId:a,victimId:b,victimName:'Victim',now:200000000,random:()=>0};const result=await attemptRob(args);assert.equal(result.status,'success');assert.equal(result.amount,150);assert.equal(f.read(a).wallet,250);assert.equal(f.read(b).wallet,850);assert.equal(f.read(a).lastRob,args.now);await assert.rejects(attemptRob(args));assert.equal(f.read(a).wallet,250);assert.equal(f.read(b).wallet,850);
});
test('robbery rollback preserves both accounts on failure and safe blocks theft',async()=>{
 const {attemptRob}=await import('../src/services/economy/rob.js');const f=fixture({[a]:{wallet:100,bank:0,lastRob:0},[b]:{wallet:1000,bank:0,inventory:{}}}),args={client:f.client,guildId:gid,robberId:a,victimId:b,victimName:'Victim',now:200000000,random:()=>0};f.fail(b);await assert.rejects(attemptRob(args));assert.equal(f.read(a).wallet,100);assert.equal(f.read(a).lastRob,0);assert.equal(f.read(b).wallet,1000);
 const protectedF=fixture({[a]:{wallet:100,bank:0,lastRob:0},[b]:{wallet:1000,bank:0,inventory:{personal_safe:1}}});const r=await attemptRob({...args,client:protectedF.client});assert.equal(r.status,'blocked');assert.equal(protectedF.read(a).lastRob,args.now);assert.equal(protectedF.read(b).wallet,1000);
});

test('unmigrated legacy records prevent creating a fresh account and cannot be overwritten',async()=>{
 const f=fixture();f.legacy(`economy:${gid}:${a}`);await assert.rejects(withEconomyTransaction(f.client,gid,[a],m=>{m.get(a).wallet=500}),{code:'ECONOMY_LEGACY'});assert.equal(f.read(a),undefined);assert.ok(f.commands.some(x=>x.sql==='ROLLBACK'));
});

test('daily claim checks cooldown and credits wallet in one transaction',async()=>{
 const {claimDailyAtomic}=await import('../src/services/economy/daily.js');const f=fixture({[a]:{wallet:25,bank:0,lastDaily:0}}),args={client:f.client,guildId:gid,userId:a,premium:true,now:200000000};const outcomes=await Promise.allSettled([claimDailyAtomic(args),claimDailyAtomic(args)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);const reward=outcomes.find(x=>x.status==='fulfilled').value;assert.equal(reward.bonus,10);assert.equal(reward.earned,110);assert.equal(f.read(a).wallet,135);assert.equal(f.read(a).lastDaily,args.now);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
});
