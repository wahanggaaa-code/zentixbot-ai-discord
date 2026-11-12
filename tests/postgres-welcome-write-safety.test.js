import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getWelcomeConfig, getWelcomeConfigForEditing, saveWelcomeConfig, updateWelcomeConfig} from '../src/utils/database.js';

const guild='123456789012345678';
test('welcome writes do not report success after rejected or failed database operations',async()=>{
  let writes=0, raw={enabled:true, welcomeMessage:'existing'};
  const client={db:{isAvailable:()=>true,get:async()=>raw,set:async()=>{writes++;return false;}}};
  await assert.rejects(saveWelcomeConfig(client,guild,{welcomeMessage:'changed'}),e=>e.type==='database');
  await assert.rejects(updateWelcomeConfig(client,guild,{welcomeMessage:'changed'}),e=>e.type==='database');
  assert.equal(writes,2);
  client.db.get=async()=>{throw new Error('offline')};
  await assert.rejects(updateWelcomeConfig(client,guild,{enabled:false}),e=>e.type==='database');
  assert.equal(writes,2);
  client.db.get=async()=>raw;client.db.set=async(_key,value)=>{writes++;raw=value;return true};
  const saved=await updateWelcomeConfig(client,guild,{enabled:false});
  assert.equal(saved.welcomeMessage,'existing');assert.equal(raw.enabled,false);assert.equal(raw.welcomeMessage,'existing');
  assert.equal(await saveWelcomeConfig(client,guild,{welcomeMessage:'changed'}),true);
});

test('PostgreSQL welcome writes fail closed on read failure or malformed data', {skip:process.env.ZENTIX_TEST_PG_SOCKET!=='/tmp/zentix-local-pg'},async t=>{
  const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'};
  const admin=new pg.Client(base);await admin.connect();
  const schema=`welcome_write_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) primary key,created_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) primary key REFERENCES "${schema}".guilds(id),config jsonb,updated_at timestamp DEFAULT now())`);
  const pool=new pg.Pool({...base,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
  const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;
  const client={db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable()),get:(...args)=>backend.get(...args),set:(...args)=>backend.set(...args)}};
  await updateWelcomeConfig(client,guild,{enabled:true,welcomeMessage:'important',roleIds:['234567890123456789']});
  await pool.query('ALTER TABLE welcome_configs RENAME TO offline');
  // The old best-effort read still returns defaults; write must independently fail.
  assert.equal((await getWelcomeConfig(client,guild)).enabled,false);
  await assert.rejects(getWelcomeConfigForEditing(client,guild),e=>e.type==='database');
  await assert.rejects(updateWelcomeConfig(client,guild,{welcomeMessage:'changed'}),e=>e.type==='database');
  await pool.query('ALTER TABLE offline RENAME TO welcome_configs');
  let raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guild])).rows[0].config;
  assert.equal(raw.welcomeMessage,'important');assert.deepEqual(raw.roleIds,['234567890123456789']);
  for(const bad of ['null','[]','"invalid"']){
    await pool.query('UPDATE welcome_configs SET config=$2::jsonb WHERE guild_id=$1',[guild,bad]);
    await assert.rejects(updateWelcomeConfig(client,guild,{enabled:false}),e=>e.type==='database');
    assert.deepEqual((await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guild])).rows[0].config,JSON.parse(bad));
  }
  await pool.query('UPDATE welcome_configs SET config=$2::jsonb WHERE guild_id=$1',[guild,JSON.stringify(raw)]);
  const saved=await updateWelcomeConfig(client,guild,{welcomeMessage:'changed'});
  assert.equal(saved.enabled,true);assert.deepEqual(saved.roleIds,['234567890123456789']);
  raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guild])).rows[0].config;
  assert.equal(raw.welcomeMessage,'changed');assert.deepEqual(raw.roleIds,['234567890123456789']);
});
