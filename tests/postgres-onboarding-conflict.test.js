import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import express from 'express';
import {ChannelType} from 'discord.js';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {updateWelcomeConfig, getWelcomeConfigForEditing, saveWelcomeConfig} from '../src/utils/database.js';
import {patchGuildConfig, getGuildConfig, setGuildConfig} from '../src/services/config/guildConfig.js';
import {createBotApiRouter} from '../src/dashboard/botApi.js';
import {createModulesApi} from '../src/dashboard/modulesApi.js';
import {assertOnboardingCompatible} from '../src/services/config/onboardingConflict.js';

const guildId='123456789012345678',channelId='234567890123456789',roleId='345678901234567890';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
const welcomeBody={enabled:true,channelId,welcomeMessage:'Hello {user}',welcomePing:false,welcomeImage:null,roleIds:[roleId],welcomeEmbed:{title:'Welcome',footer:'',color:42}};
const verifyBody={enabled:true,channelId,roleId,message:'Verify',buttonText:'Verify'};
async function fixture(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();const schema=`onboarding_${randomBytes(6).toString('hex')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY REFERENCES "${schema}".guilds(id) ON DELETE CASCADE,config jsonb DEFAULT '{}',updated_at timestamp DEFAULT now())`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:16});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;
 const client={db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable()),get:(...x)=>backend.get(...x),set:(...x)=>backend.set(...x)}};
 const role={id:roleId,name:'Member',managed:false},me={permissions:{has:()=>true},roles:{highest:{comparePositionTo:()=>1}}},channel={id:channelId,name:'general',type:ChannelType.GuildText};
 const guild={id:guildId,channels:{cache:new Map([[channelId,channel]])},roles:{cache:new Map([[roleId,role]])},members:{me}};
 const auth=(req,res,next)=>{req.guild=guild;next()},csrf=(_req,_res,next)=>next();const app=express();app.use('/bot',createBotApiRouter(client,{auth,csrf}));app.use('/modules',createModulesApi(client,{auth,csrf}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const request=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const reset=async()=>{await pool.query(`INSERT INTO guilds(id,config) VALUES($1,'{}') ON CONFLICT(id) DO UPDATE SET config='{}'`,[guildId]);await pool.query(`INSERT INTO welcome_configs(guild_id,config) VALUES($1,'{}') ON CONFLICT(guild_id) DO UPDATE SET config='{}'`,[guildId])};
 const records=async()=>({guild:(await pool.query('SELECT config FROM guilds WHERE id=$1',[guildId])).rows[0].config,welcome:(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0]?.config ?? {}});
 return {client,pool,request,reset,records};
}
function outcome(p){return p.then(x=>typeof x?.status==='number'?{ok:x.status===200,status:x.status}:{ok:true},e=>({ok:false,error:e}));}

test('invariant rejects malformed fields and all auto-role / verification conflicts',()=>{
 for(const [guild,welcome] of [[{verification:{enabled:true}},{roleIds:[roleId]}],[{verification:{autoVerify:{enabled:true}},autoRole:roleId},{}],[{verification:{enabled:true,autoVerify:{enabled:true}}},{}],[{verification:{enabled:'true'}},{}],[{}, {roleIds:'bad'}],[{},null],[{ok:true,value:{}},{}]])assert.throws(()=>assertOnboardingCompatible(guild,welcome));
 assert.doesNotThrow(()=>assertOnboardingCompatible({verification:{enabled:false}},{roleIds:[roleId]}));
});

test('concurrent welcome/verification changes across bot and web cannot both enable conflicting settings', {skip:!enabled},async t=>{
 const {client,request,reset,records}=await fixture(t);
 const role=()=>updateWelcomeConfig(client,guildId,{roleIds:[roleId]});
 const verify=()=>patchGuildConfig(client,guildId,{verification:{enabled:true}});
 const autoVerify=()=>patchGuildConfig(client,guildId,{verification:{autoVerify:{enabled:true}}});
 const webRole=()=>request('/bot/welcome',welcomeBody),webVerify=()=>request('/modules/settings/verification',verifyBody);
 for(const [left,right] of [[role,verify],[role,autoVerify],[webRole,verify],[role,webVerify],[webRole,webVerify]]){
  for(let i=0;i<5;i++){
   await reset();const [a,b]=await Promise.all([outcome(left()),outcome(right())]);
   assert.equal(Number(a.ok)+Number(b.ok),1,JSON.stringify({a,b}));
   const data=await records();assert.doesNotThrow(()=>assertOnboardingCompatible(data.guild,data.welcome));
  }
 }
});

test('full snapshots are checked across records and conflicting old data can be corrected', {skip:!enabled},async t=>{
 const {client,pool,reset,records}=await fixture(t);await reset();
 const cfg=await getGuildConfig(client,guildId);await updateWelcomeConfig(client,guildId,{roleIds:[roleId]});cfg.verification={enabled:true};
 await assert.rejects(setGuildConfig(client,guildId,cfg),e=>e.userMessage?.includes('conflicting'));
 await reset();const welcome=await getWelcomeConfigForEditing(client,guildId);await patchGuildConfig(client,guildId,{verification:{enabled:true}});welcome.roleIds=[roleId];
 await assert.rejects(saveWelcomeConfig(client,guildId,welcome),e=>e.userMessage?.includes('conflicting'));
 await pool.query(`UPDATE guilds SET config='{"verification":{"enabled":true}}' WHERE id=$1`,[guildId]);await pool.query(`UPDATE welcome_configs SET config=$2 WHERE guild_id=$1`,[guildId,JSON.stringify({roleIds:[roleId]})]);
 await updateWelcomeConfig(client,guildId,{roleIds:[]});const repaired=await records();assert.doesNotThrow(()=>assertOnboardingCompatible(repaired.guild,repaired.welcome));
});

test('malformed cross-record data blocks bot and dashboard mutations without overwriting', {skip:!enabled},async t=>{
 const {client,pool,request,reset,records}=await fixture(t);await reset();
 await pool.query(`UPDATE welcome_configs SET config='{"roleIds":"broken"}' WHERE guild_id=$1`,[guildId]);
 await assert.rejects(patchGuildConfig(client,guildId,{prefix:'?'}));assert.equal((await request('/modules/settings/verification',verifyBody)).status,409);
 assert.deepEqual((await records()).welcome,{roleIds:'broken'});
 await assert.rejects(updateWelcomeConfig(client,guildId,{welcomeMessage:'no overwrite'}));
 assert.equal((await request('/bot/welcome',welcomeBody)).status,409);
 assert.deepEqual((await records()).welcome,{roleIds:'broken'});
 await pool.query(`UPDATE guilds SET config='{"verification":{"enabled":"bad"}}' WHERE id=$1`,[guildId]);
 await pool.query(`UPDATE welcome_configs SET config='{}' WHERE guild_id=$1`,[guildId]);
 await assert.rejects(updateWelcomeConfig(client,guildId,{roleIds:[roleId]}));assert.equal((await request('/bot/welcome',welcomeBody)).status,409);
 assert.deepEqual((await records()).guild,{verification:{enabled:'bad'}});assert.deepEqual((await records()).welcome,{});
});


test('first-time concurrent creation serializes and rejected placeholder insert rolls back', {skip:!enabled},async t=>{
 const {client,pool,records}=await fixture(t);
 const [a,b]=await Promise.all([
  outcome(updateWelcomeConfig(client,guildId,{roleIds:[roleId]})),
  outcome(patchGuildConfig(client,guildId,{verification:{enabled:true}}))
 ]);
 assert.equal(Number(a.ok)+Number(b.ok),1);
 const data=await records();assertOnboardingCompatible(data.guild,data.welcome);
 await pool.query('DELETE FROM welcome_configs WHERE guild_id=$1',[guildId]);
 await pool.query(`UPDATE guilds SET config='{"verification":{"enabled":true}}' WHERE id=$1`,[guildId]);
 await assert.rejects(updateWelcomeConfig(client,guildId,{roleIds:[roleId]}));
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].n,0);
});
