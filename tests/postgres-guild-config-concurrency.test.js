import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { updateGuildConfig, patchGuildConfig, getGuildConfig } from '../src/services/config/guildConfig.js';

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
