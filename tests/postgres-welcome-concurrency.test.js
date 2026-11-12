import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {ChannelType} from 'discord.js';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getWelcomeConfigForEditing, saveWelcomeConfig, updateWelcomeConfig} from '../src/utils/database.js';
import {createBotApiRouter} from '../src/dashboard/botApi.js';

const guildId='123456789012345678',channelId='234567890123456789';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function fixture(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();
 const schema=`welcome_atomic_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',created_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY REFERENCES "${schema}".guilds(id) ON DELETE CASCADE,config jsonb NOT NULL DEFAULT '{}',updated_at timestamp DEFAULT now())`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:20});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.isConnected=true;backend.pool=pool;
 const client={db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable()),get:(...x)=>backend.get(...x),set:(...x)=>backend.set(...x)}};
 return {pool,client,backend};
}

test('PostgreSQL welcome partial writes serialize including initial creation', {skip:!enabled},async t=>{
 const {pool,client}=await fixture(t);
 await Promise.all(Array.from({length:60},(_,i)=>updateWelcomeConfig(client,guildId,{[`field${i}`]:i})));
 const raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;
 for(let i=0;i<60;i++)assert.equal(raw[`field${i}`],i);
 const cfg=await getWelcomeConfigForEditing(client,guildId);assert.equal(cfg.field59,59);
});

test('full welcome replacements reject stale, absent, cloned, wrong-guild and legacy snapshots', {skip:!enabled},async t=>{
 const {pool,client,backend}=await fixture(t);
 const first=await getWelcomeConfigForEditing(client,guildId),stale=await getWelcomeConfigForEditing(client,guildId);
 first.enabled=true;assert.equal(await saveWelcomeConfig(client,guildId,first),true);
 stale.goodbyeEnabled=true;await assert.rejects(saveWelcomeConfig(client,guildId,stale),e=>e.userMessage?.includes('changed'));
 await assert.rejects(saveWelcomeConfig(client,guildId,{...first}),e=>e.userMessage?.includes('Reload'));
 await assert.rejects(saveWelcomeConfig(client,channelId,first),e=>e.userMessage?.includes('Reload'));
 first.welcomeMessage='updated';await saveWelcomeConfig(client,guildId,first);
 const before=await getWelcomeConfigForEditing(client,guildId);await updateWelcomeConfig(client,guildId,{goodbyeEnabled:true});
 before.welcomeMessage='stale';await assert.rejects(saveWelcomeConfig(client,guildId,before),e=>e.userMessage?.includes('changed'));
 let raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;
 assert.equal(raw.welcomeMessage,'updated');assert.equal(raw.goodbyeEnabled,true);
 const old=await getWelcomeConfigForEditing(client,guildId);await pool.query('DELETE FROM welcome_configs WHERE guild_id=$1',[guildId]);
 await assert.rejects(saveWelcomeConfig(client,guildId,old),e=>e.userMessage?.includes('changed'));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM welcome_configs')).rows[0].n,0);
 await pool.query('INSERT INTO welcome_configs(guild_id,config) VALUES($1,$2)',[guildId,JSON.stringify({ok:true,value:{welcomeMessage:'old'}})]);
 await assert.rejects(updateWelcomeConfig(client,guildId,{enabled:true}),e=>e.userMessage?.includes('review'));
 raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;assert.deepEqual(raw,{ok:true,value:{welcomeMessage:'old'}});
 const key=`guild:${guildId}:welcome`;
 assert.equal(await backend.set(key,{}),false);assert.equal(await backend.delete(key),false);
 await assert.rejects(backend.increment(key),{code:'CONFIG_WRITE_DISABLED'});await assert.rejects(backend.decrement(key),{code:'CONFIG_WRITE_DISABLED'});
 assert.equal(await backend.setStructuredData({type:'welcome_config',guildId},{}),false);assert.equal(await backend.deleteStructuredData({type:'welcome_config',guildId}),false);
 assert.deepEqual((await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config,raw);
});

test('web dashboard and bot partial writes coordinate through PostgreSQL row locks', {skip:!enabled},async t=>{
 const {pool,client}=await fixture(t);
 const me={permissions:{has:()=>true},roles:{highest:{comparePositionTo:()=>1}}},channel={id:channelId,name:'general',type:ChannelType.GuildText};
 const guild={id:guildId,channels:{cache:new Map([[channelId,channel]])},roles:{cache:new Map()},members:{me}};
 const auth=(req,res,next)=>{req.guild=guild;next()},csrf=(_req,_res,next)=>next();const app=express();app.use('/bot',createBotApiRouter(client,{auth,csrf}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const payload={enabled:true,channelId,welcomeMessage:'Hello {user}',welcomePing:false,welcomeImage:null,roleIds:[],welcomeEmbed:{title:'Hi',footer:'',color:42}};
 const request=()=>fetch(`http://127.0.0.1:${server.address().port}/bot/welcome`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
 await updateWelcomeConfig(client,guildId,{custom:'initial'});
 const snapshot=await getWelcomeConfigForEditing(client,guildId);
 const [response]=await Promise.all([request(),updateWelcomeConfig(client,guildId,{custom:'preserved'})]);
 assert.equal(response.status,200);
 const raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;
 assert.equal(raw.custom,'preserved');assert.equal(raw.welcomeMessage,'Hello {user}');
 snapshot.welcomeMessage='stale';await assert.rejects(saveWelcomeConfig(client,guildId,snapshot),e=>e.userMessage?.includes('changed'));
});

test('25 simultaneous full welcome writes from the same version allow one change', {skip:!enabled},async t=>{
 const {pool,client}=await fixture(t);
 await updateWelcomeConfig(client,guildId,{welcomeMessage:'original'});
 const snapshots=await Promise.all(Array.from({length:25},()=>getWelcomeConfigForEditing(client,guildId)));
 snapshots.forEach((snapshot,i)=>{snapshot.welcomeMessage=`option-${i}`});
 const results=await Promise.allSettled(snapshots.map(snapshot=>saveWelcomeConfig(client,guildId,snapshot)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.userMessage?.includes('changed')).length,24);
 assert.match((await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config.welcomeMessage,/^option-/);
});

test('mutating a full-write object while it is in flight invalidates its later snapshot', {skip:!enabled},async t=>{
 const {pool,client}=await fixture(t);await updateWelcomeConfig(client,guildId,{welcomeMessage:'initial'});
 const cfg=await getWelcomeConfigForEditing(client,guildId);const blocker=await pool.connect();
 try{
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM guilds WHERE id=$1 FOR UPDATE',[guildId]);
  cfg.welcomeMessage='first';const pending=saveWelcomeConfig(client,guildId,cfg);
  cfg.goodbyeEnabled=true;
  await blocker.query('COMMIT');await pending;
 }finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();}
 const saved=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;
 assert.equal(saved.welcomeMessage,'first');assert.equal(saved.goodbyeEnabled,false);
 await assert.rejects(saveWelcomeConfig(client,guildId,cfg),e=>e.userMessage?.includes('Reload'));
});
