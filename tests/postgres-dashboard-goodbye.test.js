import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {updateWelcomeConfig} from '../src/utils/database.js';
import {createGoodbyeApi} from '../src/dashboard/goodbyeApi.js';
import {createDashboardRouter} from '../src/dashboard/router.js';
import memberLeave from '../src/events/guildMemberRemove.js';

const guildId='123456789012345678',channelId='234567890123456789',userId='345678901234567890',clientId='456789012345678901';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();const schema=`goodbye_web_${randomBytes(6).toString('hex')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',created_at timestamp DEFAULT now());CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY REFERENCES "${schema}".guilds(id) ON DELETE CASCADE,config jsonb NOT NULL DEFAULT '{}',updated_at timestamp DEFAULT now())`);
 await admin.query(`CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY,value jsonb,expires_at timestamp)`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:20});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;
 const channel={id:channelId,name:'leaves',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true})};const member={permissions:{has:p=>p===PermissionFlagsBits.Administrator}};
 const guild={id:guildId,name:'Home',ownerId:'999999999999999999',channels:{cache:new Map([[channelId,channel]])},members:{me:{},fetch:async()=>member}};
 const client={homeGuildId:guildId,isReady:()=>true,guilds:{cache:new Map([[guildId,guild]])},db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable()),get:(...x)=>backend.get(...x),set:(...x)=>backend.set(...x)}};
 const auth=(req,res,next)=>{if(req.get('x-auth')!=='yes')return res.sendStatus(401);req.guild=guild;next()},csrf=(req,res,next)=>req.get('x-csrf')==='yes'?next():res.sendStatus(403);
 const app=express();app.use('/test',createGoodbyeApi(client,{auth,csrf}));
 const mockFetch=async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'mock',expires_in:3600}:{id:userId,username:'tester'}});
 app.use('/dashboard',createDashboardRouter(client,{fetchImpl:mockFetch,env:{CLIENT_ID:clientId,DISCORD_CLIENT_SECRET:'fake',DASHBOARD_URL:'http://localhost:9999'}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const req=(path,method='GET',body,headers={})=>fetch(baseUrl+'/test'+path,{method,headers:{'x-auth':'yes','x-csrf':'yes','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const payload=revision=>({revision,enabled:true,channelId,message:'Goodbye {user}',ping:false,image:null,title:'Goodbye',footer:'From {server}',color:0xed4245});
 return {pool,client,guild,channel,backend,req,payload,baseUrl};
}

test('authenticated goodbye settings save and preserve welcome and unknown fields', {skip:!enabled},async t=>{
 const {client,pool,req,payload}=await setup(t);await updateWelcomeConfig(client,guildId,{welcomeMessage:'Welcome stays',custom:{x:1},leaveEmbed:{title:'Old',footer:'Old',color:42,extra:'keep'}});
 assert.equal((await req('/goodbye','GET',undefined,{'x-auth':'no'})).status,401);
 const get=await req('/goodbye');assert.equal(get.status,200);const before=await get.json();assert.equal(before.goodbye.title,'Old');assert.equal(before.channels[0].id,channelId);
 assert.equal((await req('/goodbye','PATCH',payload(before.revision),{'x-csrf':'no'})).status,403);
 const saved=await req('/goodbye','PATCH',payload(before.revision));assert.equal(saved.status,200);const after=await saved.json();assert.notEqual(after.revision,before.revision);
 const stored=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;
 assert.equal(stored.welcomeMessage,'Welcome stays');assert.deepEqual(stored.custom,{x:1});assert.equal(stored.goodbyeEnabled,true);assert.equal(stored.goodbyeChannelId,channelId);assert.equal(stored.leaveMessage,'Goodbye {user}');assert.equal(stored.leaveEmbed.extra,'keep');
});

test('parallel edits and concurrent bot welcome edits reject stale revisions', {skip:!enabled},async t=>{
 const {client,pool,req,payload}=await setup(t);const initial=await (await req('/goodbye')).json();assert.equal(initial.revision,'missing');
 const attempts=await Promise.all(Array.from({length:15},(_,i)=>req('/goodbye','PATCH',{...payload(initial.revision),message:`message ${i}`})));
 assert.equal(attempts.filter(x=>x.status===200).length,1);assert.equal(attempts.filter(x=>x.status===409).length,14);
 const current=await (await req('/goodbye')).json();await updateWelcomeConfig(client,guildId,{welcomeMessage:'Updated elsewhere'});
 const stale=await req('/goodbye','PATCH',{...payload(current.revision),message:'stale'});assert.equal(stale.status,409);
 const raw=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;assert.equal(raw.welcomeMessage,'Updated elsewhere');assert.match(raw.leaveMessage,/^message \d+$/);
});

test('input, permissions, malformed data, conflicts and storage failures fail closed', {skip:!enabled},async t=>{
 const {pool,req,payload,channel,backend}=await setup(t);const v=(await (await req('/goodbye')).json()).revision;
 for(const bad of [{enabled:'true'},{channelId:'999999999999999999'},{message:''},{image:'http://example.com/a.png'},{image:'https://user:pass@example.com/a.png'},{color:16777216},{title:''},{unexpected:1},{revision:'bogus'}])assert.equal((await req('/goodbye','PATCH',{...payload(v),...bad})).status,400,JSON.stringify(bad));
 channel.permissionsFor=()=>({has:()=>false});assert.equal((await req('/goodbye','PATCH',payload(v))).status,403);channel.permissionsFor=()=>({has:()=>true});
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM guilds')).rows[0].n,0);
 await pool.query(`INSERT INTO guilds(id,config) VALUES($1,'{}')`,[guildId]);
 await pool.query(`INSERT INTO welcome_configs(guild_id,config) VALUES($1,'{"goodbyeEnabled":"bad"}')`,[guildId]);
 assert.equal((await req('/goodbye')).status,409);assert.equal((await req('/goodbye','PATCH',payload(v))).status,409);
 assert.equal((await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config.goodbyeEnabled,'bad');
 await pool.query(`UPDATE welcome_configs SET config='{"roleIds":"broken"}' WHERE guild_id=$1`,[guildId]);const invalid=await (await req('/goodbye')).json();assert.equal((await req('/goodbye','PATCH',payload(invalid.revision))).status,409);
 backend.isConnected=false;assert.equal((await req('/goodbye')).status,503);backend.isConnected=true;
});

test('real dashboard OAuth, CSRF, origin and authorization protect the new endpoints', {skip:!enabled},async t=>{
 const {baseUrl,payload,guild}=await setup(t);const request=(path,opts={})=>fetch(baseUrl+path,{redirect:'manual',...opts});
 assert.equal((await request('/dashboard/api/bot/goodbye')).status,401);
 const start=await request('/dashboard/login'),stateCookie=start.headers.get('set-cookie').split(';')[0],state=new URL(start.headers.get('location')).searchParams.get('state');
 const cb=await request(`/dashboard/callback?code=mock&state=${state}`,{headers:{cookie:stateCookie}});const session=cb.headers.getSetCookie().find(x=>x.startsWith('zx_session=')).split(';')[0];
 const me=await (await request('/dashboard/api/me',{headers:{cookie:session}})).json();const get=await request('/dashboard/api/bot/goodbye',{headers:{cookie:session}});assert.equal(get.status,200);const revision=(await get.json()).revision;
 const patch=(origin,csrf)=>request('/dashboard/api/bot/goodbye',{method:'PATCH',headers:{cookie:session,origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify(payload(revision))});
 assert.equal((await patch('http://evil.example',me.csrf)).status,403);assert.equal((await patch('http://localhost:9999','invalid')).status,403);assert.equal((await patch('http://localhost:9999',me.csrf)).status,200);
 guild.members.fetch=async()=>({permissions:{has:()=>false}});assert.equal((await request('/dashboard/api/bot/goodbye',{headers:{cookie:session}})).status,403);assert.equal((await patch('http://localhost:9999',me.csrf)).status,403);
});

test('first web goodbye save racing bot welcome initialization cannot erase either change', {skip:!enabled},async t=>{
 const {pool,client,req,payload}=await setup(t);
 for(let i=0;i<8;i++){
  await pool.query('DELETE FROM guilds WHERE id=$1',[guildId]);
  const start=await (await req('/goodbye')).json();assert.equal(start.revision,'missing');
  const [response]=await Promise.all([req('/goodbye','PATCH',payload(start.revision)),updateWelcomeConfig(client,guildId,{welcomeMessage:'bot wrote'})]);
  assert.ok([200,409].includes(response.status));
  const stored=(await pool.query('SELECT config FROM welcome_configs WHERE guild_id=$1',[guildId])).rows[0].config;
  assert.equal(stored.welcomeMessage,'bot wrote');if(response.status===200)assert.equal(stored.leaveMessage,'Goodbye {user}');
 }
});

test('saved web settings are read by the member-leave handler with mocked Discord', {skip:!enabled},async t=>{
 const {client,guild,channel,req,payload}=await setup(t);const first=await (await req('/goodbye')).json();
 const saved=await req('/goodbye','PATCH',{...payload(first.revision),message:'Bye {username} from {server}',ping:true});assert.equal(saved.status,200);
 const messages=[];channel.isTextBased=()=>true;channel.send=async x=>messages.push(x);guild.memberCount=42;
 client.user={id:'567890123456789012'};const realGet=client.db.get;
 client.db.get=async(key,fallback)=>key===`guild:${guildId}:welcome`?realGet(key,fallback):fallback;
 client.db.delete=async()=>true;client.db.keys=async()=>[];
 const user={id:userId,tag:'Tester#0001',username:'Tester',displayAvatarURL:()=> 'https://example.test/avatar.png',toString:()=>`<@${userId}>`};
 await memberLeave.execute({guild,user,client,joinedTimestamp:Date.now()});
 assert.equal(messages.length,1);assert.equal(messages[0].content,`<@${userId}>`);assert.deepEqual(messages[0].allowedMentions,{users:[userId]});
 assert.equal(messages[0].embeds[0].data.description,'Bye Tester from Home');assert.equal(messages[0].embeds[0].data.title,'Goodbye');
});


test('goodbye patch preserves unrelated large JSONB numeric values exactly', {skip:!enabled},async t=>{
 const {pool,req,payload}=await setup(t);await pool.query(`INSERT INTO guilds(id) VALUES($1)`,[guildId]);await pool.query(`INSERT INTO welcome_configs(guild_id,config) VALUES($1,'{"large":900719925474099312345,"leaveEmbed":{"extra":900719925474099312345}}')`,[guildId]);
 const initial=await (await req('/goodbye')).json();assert.equal((await req('/goodbye','PATCH',payload(initial.revision))).status,200);const row=(await pool.query(`SELECT config->>'large' AS n,config->'leaveEmbed'->>'extra' AS e FROM welcome_configs WHERE guild_id=$1`,[guildId])).rows[0];assert.equal(row.n,'900719925474099312345');assert.equal(row.e,'900719925474099312345');
});
