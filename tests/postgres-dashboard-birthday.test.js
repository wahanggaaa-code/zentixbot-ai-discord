import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getGuildConfig,setGuildConfig} from '../src/services/config/guildConfig.js';
import {checkBirthdays} from '../src/services/birthdayService.js';
import {createBirthdayApi} from '../src/dashboard/birthdayApi.js';
import {createDashboardRouter} from '../src/dashboard/router.js';
const guildId='123456789012345678',channelId='234567890123456789',userId='345678901234567890',clientId='456789012345678901';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();const schema=`birthday_web_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY REFERENCES "${schema}".guilds(id) ON DELETE CASCADE,config jsonb NOT NULL DEFAULT '{}',updated_at timestamp DEFAULT now());CREATE TABLE "${schema}".birthdays(guild_id varchar(20),user_id varchar(20),month int,day int,PRIMARY KEY(guild_id,user_id));CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY,value jsonb,expires_at timestamp);CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY,value jsonb,expires_at timestamp)`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:20});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;
 const channel={id:channelId,name:'<birthday>',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true})};const member={permissions:{has:p=>p===PermissionFlagsBits.Administrator}};
 const guild={id:guildId,name:'Home',ownerId:'999999999999999999',channels:{cache:new Map([[channelId,channel]]),fetch:async id=>id===channelId?channel:null},members:{me:{},fetch:async()=>member}};
 const client={homeGuildId:guildId,isReady:()=>true,guilds:{cache:new Map([[guildId,guild]])},db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable()),get:(...x)=>backend.get(...x),set:(...x)=>backend.set(...x)}};
 const auth=(req,res,next)=>{if(req.get('x-auth')!=='yes')return res.sendStatus(401);req.guild=guild;next()},csrf=(req,res,next)=>req.get('x-csrf')==='yes'?next():res.sendStatus(403);
 const app=express();app.use('/test',createBirthdayApi(client,{auth,csrf}));const mockFetch=async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'mock',expires_in:3600}:{id:userId,username:'tester'}});app.use('/dashboard',createDashboardRouter(client,{fetchImpl:mockFetch,env:{CLIENT_ID:clientId,DISCORD_CLIENT_SECRET:'fake',DASHBOARD_URL:'http://localhost:9999'}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const req=(path,method='GET',body,headers={})=>fetch(baseUrl+'/test/birthday/'+path,{method,headers:{'x-auth':'yes','x-csrf':'yes','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {pool,client,guild,channel,backend,req,baseUrl};
}
test('birthday settings validate, preserve JSONB precisely and detect stale bot and web edits',{skip:!enabled},async t=>{
 const {pool,client,channel,req}=await setup(t);await pool.query(`INSERT INTO guilds(id,config) VALUES($1,'{"large":900719925474099312345,"nested":{"v":true}}')`,[guildId]);const botCopy=await getGuildConfig(client,guildId);
 assert.equal((await req('settings','GET',undefined,{'x-auth':'no'})).status,401);assert.equal((await req('settings','PATCH',{channelId,expectedChannelId:null},{'x-csrf':'no'})).status,403);
 const initial=await (await req('settings')).json();assert.equal(initial.channelId,null);
 const attempts=await Promise.all(Array.from({length:10},()=>req('settings','PATCH',{channelId,expectedChannelId:null})));assert.equal(attempts.filter(r=>r.status===200).length,1);assert.equal(attempts.filter(r=>r.status===409).length,9);
 assert.equal((await pool.query(`SELECT config->>'large' n,config->'nested' nested FROM guilds WHERE id=$1`,[guildId])).rows[0].n,'900719925474099312345');
 botCopy.birthdayChannelId=null;await assert.rejects(setGuildConfig(client,guildId,botCopy));
 await pool.query(`UPDATE guilds SET config=config-'large' WHERE id=$1`,[guildId]);const newer=await getGuildConfig(client,guildId);newer.birthdayChannelId=null;await setGuildConfig(client,guildId,newer);assert.equal((await req('settings','PATCH',{channelId:null,expectedChannelId:channelId})).status,409);
 assert.equal((await req('settings','PATCH',{channelId:'999999999999999999',expectedChannelId:null})).status,400);channel.permissionsFor=()=>({has:()=>false});assert.equal((await req('settings','PATCH',{channelId,expectedChannelId:null})).status,403);
});
test('read-only paginated list validates data and fails closed',{skip:!enabled},async t=>{
 const {pool,req,backend}=await setup(t);await pool.query('INSERT INTO guilds(id) VALUES($1)',[guildId]);for(let i=0;i<55;i++)await pool.query('INSERT INTO birthdays VALUES($1,$2,2,29)',[guildId,String(500000000000000000n+BigInt(i))]);
 assert.equal((await req('list','GET',undefined,{'x-auth':'no'})).status,401);const response=await req('list');assert.equal(response.headers.get('cache-control'),'no-store');const one=await response.json();assert.equal(one.birthdays.length,50);const two=await (await req('list?after='+one.next)).json();assert.equal(two.birthdays.length,5);assert.equal(two.next,null);assert.equal(new Set([...one.birthdays,...two.birthdays].map(x=>x.userId)).size,55);
 assert.equal((await req('list?after=bad')).status,400);assert.equal((await req('list?unknown=1')).status,400);await pool.query('UPDATE birthdays SET month=13 WHERE guild_id=$1',[guildId]);assert.equal((await req('list')).status,409);backend.isConnected=false;assert.equal((await req('list')).status,503);
});
test('dashboard requires OAuth admin, origin and CSRF for birthday routes',{skip:!enabled},async t=>{
 const {baseUrl,guild}=await setup(t);const request=(path,opts={})=>fetch(baseUrl+path,{redirect:'manual',...opts});assert.equal((await request('/dashboard/api/bot/birthday/list')).status,401);
 const start=await request('/dashboard/login'),stateCookie=start.headers.get('set-cookie').split(';')[0],state=new URL(start.headers.get('location')).searchParams.get('state');const cb=await request(`/dashboard/callback?code=mock&state=${state}`,{headers:{cookie:stateCookie}});const session=cb.headers.getSetCookie().find(x=>x.startsWith('zx_session=')).split(';')[0];const me=await (await request('/dashboard/api/me',{headers:{cookie:session}})).json();
 assert.equal((await request('/dashboard/api/bot/birthday/list',{headers:{cookie:session}})).status,200);
 const patch=(origin,csrf)=>request('/dashboard/api/bot/birthday/settings',{method:'PATCH',headers:{cookie:session,origin,'x-csrf-token':csrf,'content-type':'application/json'},body:JSON.stringify({channelId,expectedChannelId:null})});assert.equal((await patch('http://evil.example',me.csrf)).status,403);assert.equal((await patch('http://localhost:9999','bad')).status,403);assert.equal((await patch('http://localhost:9999',me.csrf)).status,200);guild.members.fetch=async()=>({permissions:{has:()=>false}});assert.equal((await request('/dashboard/api/bot/birthday/list',{headers:{cookie:session}})).status,403);assert.equal((await patch('http://localhost:9999',me.csrf)).status,403);
});
test('scheduler reads web-configured channel and current birthday with mocked Discord',{skip:!enabled},async t=>{
 const {pool,client,guild,channel,req}=await setup(t);assert.equal((await req('settings','PATCH',{channelId,expectedChannelId:null})).status,200);const today=new Date();await pool.query('INSERT INTO birthdays VALUES($1,$2,$3,$4)',[guildId,userId,today.getUTCMonth()+1,today.getUTCDate()]);const sent=[];channel.send=async m=>sent.push(m);guild.members.fetch=async()=>({toString:()=>`<@${userId}>`});await checkBirthdays(client);assert.equal(sent.length,1);assert.match(sent[0].embeds[0].description,new RegExp(userId));
});

test('malformed or conflicting configuration and database outages never overwrite settings',{skip:!enabled},async t=>{
 const {pool,req,backend}=await setup(t);await pool.query(`INSERT INTO guilds(id,config) VALUES($1,'{"birthdayChannelId":17}')`,[guildId]);assert.equal((await req('settings')).status,409);assert.equal((await req('settings','PATCH',{channelId,expectedChannelId:null})).status,409);
 await pool.query(`UPDATE guilds SET config='{"autoRole":"123","verification":{"enabled":true}}' WHERE id=$1`,[guildId]);assert.equal((await req('settings','PATCH',{channelId,expectedChannelId:null})).status,409);assert.equal((await pool.query(`SELECT config ? 'birthdayChannelId' AS changed FROM guilds WHERE id=$1`,[guildId])).rows[0].changed,false);
 backend.isConnected=false;assert.equal((await req('settings')).status,503);assert.equal((await req('settings','PATCH',{channelId,expectedChannelId:null})).status,503);
});
