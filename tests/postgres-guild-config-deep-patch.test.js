import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getGuildConfig,patchGuildConfig,updateGuildConfig} from '../src/services/config/guildConfig.js';

const guild='123456789012345678',role='345678901234567890';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();
 const schema=`deep_patch_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',updated_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}')`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:30});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;return {pool,client:{db:{db:backend,isAvailable:()=>Boolean(backend.isAvailable()),getStatus:()=>({connectionType:'postgresql',isDegraded:false}),get:(...args)=>backend.get(...args),set:(...args)=>backend.set(...args)}}};
}

test('nested verification patch keeps sibling fields, while arrays/scalars/null replace', {skip:!enabled},async t=>{
 const {client}=await setup(t);
 await patchGuildConfig(client,guild,{verification:{enabled:false,autoVerify:{enabled:true,criteria:'account_age',accountAgeDays:7,roleId:role}},custom:{inner:{x:1,y:2},list:[1,2],flag:true}});
 await patchGuildConfig(client,guild,{verification:{autoVerify:{accountAgeDays:30}},custom:{inner:{x:9},list:[3],flag:null}});
 let cfg=await getGuildConfig(client,guild);assert.equal(cfg.verification.autoVerify.enabled,true);assert.equal(cfg.verification.autoVerify.criteria,'account_age');assert.equal(cfg.verification.autoVerify.roleId,role);assert.equal(cfg.verification.autoVerify.accountAgeDays,30);
 assert.deepEqual(cfg.custom,{inner:{x:9,y:2},list:[3],flag:null});
 await patchGuildConfig(client,guild,{custom:{inner:{}}});cfg=await getGuildConfig(client,guild);assert.deepEqual(cfg.custom.inner,{x:9,y:2});
 await updateGuildConfig(client,guild,{custom:{replacement:true}});cfg=await getGuildConfig(client,guild);assert.deepEqual(cfg.custom,{replacement:true});
});

test('deep patches on separate paths serialize under PostgreSQL row locks', {skip:!enabled},async t=>{
 const {client}=await setup(t);
 await Promise.all(Array.from({length:60},(_,i)=>patchGuildConfig(client,guild,{custom:{one:{two:{[`k${i}`]:i}}}})));
 const data=(await getGuildConfig(client,guild)).custom.one.two;for(let i=0;i<60;i++)assert.equal(data[`k${i}`],i);
 await patchGuildConfig(client,guild,{verification:{autoVerify:{enabled:false,criteria:'account_age',accountAgeDays:7,roleId:role}}});
 await Promise.all([patchGuildConfig(client,guild,{verification:{autoVerify:{accountAgeDays:20}}}),patchGuildConfig(client,guild,{verification:{autoVerify:{roleId:'456789012345678901'}}})]);
 const auto=(await getGuildConfig(client,guild)).verification.autoVerify;assert.equal(auto.accountAgeDays,20);assert.equal(auto.roleId,'456789012345678901');assert.equal(auto.criteria,'account_age');
});

test('invalid and unsafe patch input fails without modifying PostgreSQL or object prototypes', {skip:!enabled},async t=>{
 const {client,pool}=await setup(t);const cyclic={};cyclic.self=cyclic;const deep={};let cursor=deep;for(let i=0;i<35;i++)cursor=cursor.child={};
 const getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){throw new Error('getter should not run')}});
 const holes=Array(2);holes[1]=4;
 for(const patch of [null,[],{x:undefined},{x:NaN},{x:Infinity},{x:new Date()},cyclic,deep,{x:getter},{x:holes},JSON.parse('{"x":{"__proto__":{"polluted":true}}}'),JSON.parse('{"x":[{"constructor":{"prototype":{"polluted":true}}}]}'),JSON.parse('{"prototype":{"polluted":true}}')]){
  await assert.rejects(patchGuildConfig(client,guild,patch),e=>e.type==='validation');
 }
 assert.equal({}.polluted,undefined);assert.equal((await pool.query('SELECT count(*)::int AS n FROM guilds')).rows[0].n,0);
 await patchGuildConfig(client,guild,{verification:{enabled:false},custom:{safe:'before'}});
 await assert.rejects(patchGuildConfig(client,guild,{verification:{enabled:'yes'},custom:{safe:'after'}}));
 assert.equal((await getGuildConfig(client,guild)).custom.safe,'before');
});

test('patch input is captured before waiting for the row lock', {skip:!enabled},async t=>{
 const {client,pool}=await setup(t);await patchGuildConfig(client,guild,{custom:{nested:{value:'initial'}}});
 const conn=await pool.connect();try{
  await conn.query('BEGIN');await conn.query('SELECT config FROM guilds WHERE id=$1 FOR UPDATE',[guild]);
  const patch={custom:{nested:{value:'captured'},list:[{safe:'before'}]}};
  const pending=patchGuildConfig(client,guild,patch);patch.custom.nested.value='later';patch.custom.list[0].safe='later';
  await conn.query('COMMIT');await pending;
 }finally{await conn.query('ROLLBACK').catch(()=>{});conn.release();}
 const cfg=await getGuildConfig(client,guild);assert.equal(cfg.custom.nested.value,'captured');assert.equal(cfg.custom.list[0].safe,'before');
});

test('existing stored prototype-like keys remain inert when an adjacent field is patched', {skip:!enabled},async t=>{
 const {pool,client}=await setup(t);
 await pool.query('INSERT INTO guilds(id,config) VALUES($1,$2::jsonb)',[guild,'{"custom":{"__proto__":{"polluted":true},"safe":"before"}}']);
 await patchGuildConfig(client,guild,{custom:{safe:'after'}});
 const raw=(await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config;
 assert.equal({}.polluted,undefined);assert.equal(Object.getPrototypeOf(raw.custom),Object.prototype);
 assert.deepEqual(raw.custom.__proto__,{polluted:true});assert.equal(raw.custom.safe,'after');
});

test('deep patch cannot bypass onboarding conflict checks and rolls back sibling changes', {skip:!enabled},async t=>{
 const {pool,client}=await setup(t);await patchGuildConfig(client,guild,{verification:{autoVerify:{enabled:false,criteria:'account_age',accountAgeDays:7,roleId:role}},custom:{safe:'before'}});
 await pool.query('INSERT INTO welcome_configs(guild_id,config) VALUES($1,$2::jsonb)',[guild,JSON.stringify({roleIds:[role]})]);
 await assert.rejects(patchGuildConfig(client,guild,{verification:{autoVerify:{enabled:true}},custom:{safe:'after'}}));
 const cfg=await getGuildConfig(client,guild);assert.equal(cfg.verification.autoVerify.enabled,false);assert.equal(cfg.verification.autoVerify.roleId,role);assert.equal(cfg.custom.safe,'before');
});
