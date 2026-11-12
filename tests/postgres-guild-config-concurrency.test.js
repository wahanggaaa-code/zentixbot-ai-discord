import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { updateGuildConfig, patchGuildConfig, getGuildConfig, setGuildConfig, transferGuildConfigSnapshot } from '../src/services/config/guildConfig.js';

const guild = '123456789012345678';
const enabled = process.env.ZENTIX_TEST_PG_SOCKET === '/tmp/zentix-local-pg';
async function setup(t) {
  const base = {host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'};
  const admin = new pg.Client(base); await admin.connect();
  const schema = `config_concurrent_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE TABLE "${schema}".guilds (id varchar(20) PRIMARY KEY, config jsonb DEFAULT '{}', updated_at timestamp DEFAULT now())`);
  const pool = new pg.Pool({...base, options:`-c search_path=${schema}`, max:20});
  t.after(async()=>{await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();});
  const backend = new PostgreSQLDatabase(); backend.pool=pool; backend.isConnected=true;
  const db = {db:backend, getStatus:()=>({connectionType:'postgresql',isDegraded:false}), isAvailable:()=>Boolean(backend.isAvailable()), get:(...args)=>backend.get(...args), set:(...args)=>backend.set(...args)};
  return {pool, client:{db}, backend};
}

test('PostgreSQL partial config updates serialize, including first-row creation and nested patches', {skip:!enabled}, async t => {
  const {pool,client}=await setup(t);
  await Promise.all(Array.from({length:50},(_,i)=>updateGuildConfig(client,guild,{[`update${i}`]:i})));
  await Promise.all(Array.from({length:50},(_,i)=>patchGuildConfig(client,guild,{customNested:{[`patch${i}`]:i}})));
  const data=(await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config;
  for(let i=0;i<50;i++){assert.equal(data[`update${i}`],i);assert.equal(data.customNested[`patch${i}`],i);}
  assert.equal((await getGuildConfig(client,guild)).customNested.patch49,49);
});

test('partial config mutations serialize with dashboard-style row locks', {skip:!enabled}, async t => {
  const {pool,client}=await setup(t);
  await pool.query('INSERT INTO guilds(id,config) VALUES($1,$2)',[guild,JSON.stringify({prefix:'!'})]);
  const conn=await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('SELECT config FROM guilds WHERE id=$1 FOR UPDATE',[guild]);
    const patch=patchGuildConfig(client,guild,{premiumRoleId:'234567890123456789'});
    await conn.query("UPDATE guilds SET config=config || '{\"prefix\":\"?\"}'::jsonb WHERE id=$1",[guild]);
    await conn.query('COMMIT');
    await patch;
  } finally {await conn.query('ROLLBACK').catch(()=>{});conn.release();}
  const cfg=(await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config;
  assert.equal(cfg.prefix,'?');assert.equal(cfg.premiumRoleId,'234567890123456789');
});

test('bad config, invalid updates and query errors roll back without writing', {skip:!enabled}, async t => {
  const {pool,client,backend}=await setup(t);
  await assert.rejects(updateGuildConfig(client,guild,{prefix:99}));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guilds')).rows[0].n,0);
  await pool.query('INSERT INTO guilds(id,config) VALUES($1,$2::jsonb)',[guild,'null']);
  await assert.rejects(patchGuildConfig(client,guild,{prefix:'?'}));
  assert.equal((await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config,null);
  await pool.query('UPDATE guilds SET config=$2::jsonb WHERE id=$1',[guild,'{"prefix":"!"}']);
  await pool.query('ALTER TABLE guilds RENAME TO offline');
  await assert.rejects(updateGuildConfig(client,guild,{prefix:'?'}));
  await pool.query('ALTER TABLE offline RENAME TO guilds');
  assert.equal((await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config.prefix,'!');
  backend.isConnected=false;
  await assert.rejects(patchGuildConfig(client,guild,{prefix:'?'}));
  assert.equal((await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config.prefix,'!');
});


test('full PostgreSQL writes reject stale or missing snapshots and preserve newer changes', {skip:!enabled}, async t => {
  const {pool,client}=await setup(t);
  const original=await getGuildConfig(client,guild), stale=await getGuildConfig(client,guild);
  original.prefix='!'; await setGuildConfig(client,guild,original);
  stale.prefix='?'; await assert.rejects(setGuildConfig(client,guild,stale),e=>e.userMessage?.includes('changed'));
  await assert.rejects(setGuildConfig(client,guild,{...original}),e=>e.userMessage?.includes('Reload'));
  await assert.rejects(setGuildConfig(client,'234567890123456789',original),e=>e.userMessage?.includes('Reload'));
  const current=await getGuildConfig(client,guild), copy=transferGuildConfigSnapshot(current,{...current,prefix:'%'});
  const saved=await setGuildConfig(client,guild,copy); assert.equal(saved.prefix,'%');
  copy.premiumRoleId='234567890123456789';await setGuildConfig(client,guild,copy);
  const old=await getGuildConfig(client,guild);
  await patchGuildConfig(client,guild,{logging:{enabled:true}});
  old.prefix='#';await assert.rejects(setGuildConfig(client,guild,old),e=>e.userMessage?.includes('changed'));
  const final=(await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config;
  assert.equal(final.prefix,'%');assert.equal(final.premiumRoleId,'234567890123456789');assert.equal(final.logging.enabled,true);
  const fromPatch=await patchGuildConfig(client,guild,{prefix:'&'});fromPatch.prefix='*';await setGuildConfig(client,guild,fromPatch);
  assert.equal((await getGuildConfig(client,guild)).prefix,'*');
});

test('parallel full writes from the same PostgreSQL snapshot allow one differing write', {skip:!enabled}, async t => {
  const {pool,client}=await setup(t);
  await updateGuildConfig(client,guild,{prefix:'!'});
  const snapshot=await getGuildConfig(client,guild);
  const contenders=Array.from({length:25},(_,i)=>transferGuildConfigSnapshot(snapshot,{...snapshot,prefix:`prefix-${i}`}));
  const outcomes=await Promise.allSettled(contenders.map(cfg=>setGuildConfig(client,guild,cfg)));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.userMessage?.includes('changed')).length,24);
  assert.match((await pool.query('SELECT config FROM guilds WHERE id=$1',[guild])).rows[0].config.prefix,/^prefix-/);
});

test('snapshot distinguishes missing rows, JSONB object order, and backend identity', {skip:!enabled}, async t => {
  const {pool,client}=await setup(t);
  const missing=await getGuildConfig(client,guild);
  await pool.query('INSERT INTO guilds(id,config) VALUES($1,$2)',[guild,JSON.stringify({prefix:'!'})]);
  await assert.rejects(setGuildConfig(client,guild,missing),e=>e.userMessage?.includes('changed'));
  const cfg=await getGuildConfig(client,guild);
  const fake={...client,db:{...client.db,db:{...client.db.db,isAvailable:()=>true,pool:{connect(){throw Error('unexpected')}}}}};
  await assert.rejects(setGuildConfig(fake,guild,cfg),e=>e.userMessage?.includes('Reload'));
  await pool.query('UPDATE guilds SET config=$2::jsonb WHERE id=$1',[guild,JSON.stringify({prefix:'!'})]);
  cfg.prefix='?';await setGuildConfig(client,guild,cfg);
  assert.equal((await getGuildConfig(client,guild)).prefix,'?');
  const before=await getGuildConfig(client,guild);await pool.query('DELETE FROM guilds WHERE id=$1',[guild]);
  await assert.rejects(setGuildConfig(client,guild,before),e=>e.userMessage?.includes('changed'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM guilds')).rows[0].n,0);
});

test('ConfigService copies preserve PostgreSQL snapshots for supported settings', {skip:!enabled}, async t => {
  const {client}=await setup(t);
  const {default:ConfigService}=await import('../src/services/config/configService.js');
  client.guilds={cache:new Map([[guild,{id:guild,channels:{cache:new Map()},roles:{cache:new Map()}}]])};
  await ConfigService.updateSetting(client,guild,'prefix','?', '234567890123456789');
  assert.equal((await getGuildConfig(client,guild)).prefix,'?');
  await ConfigService.bulkUpdate(client,guild,{prefix:'%',dmOnClose:false},'234567890123456789');
  const cfg=await getGuildConfig(client,guild);assert.equal(cfg.prefix,'%');assert.equal(cfg.dmOnClose,false);
});
