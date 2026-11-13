import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {PermissionFlagsBits} from 'discord.js';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {createJoinToCreateApi} from '../src/dashboard/joinToCreateApi.js';
import {createDashboardRouter} from '../src/dashboard/router.js';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
const guildId='123456789012345678',user='234567890123456789',channel='456789012345678901';
const mid=n=>String(100000000000000000n+BigInt(n));
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();const schema='jtc_web_'+randomBytes(6).toString('hex');await admin.query(`CREATE SCHEMA "${schema}"`);await admin.query(`CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY,value jsonb,expires_at timestamptz);CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY,value jsonb,expires_at timestamptz)`);
 const pgpool=new pg.Pool({...base,options:`-c search_path=${schema}`});t.after(async()=>{await pgpool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});const backend=new PostgreSQLDatabase();backend.pool=pgpool;backend.isConnected=true;
 const guild={id:guildId,name:'Server',ownerId:'999999999999999999',members:{fetch:async()=>({id:user,permissions:{has:p=>p===PermissionFlagsBits.Administrator}})}};const client={homeGuildId:guildId,isReady:()=>true,guilds:{cache:new Map([[guildId,guild]])},db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable())}};
 const auth=(q,r,n)=>{if(q.get('x-auth')!=='yes')return r.sendStatus(401);q.guild=guild;n()};const app=express();app.use('/test',createJoinToCreateApi(client,{auth}));const mockFetch=async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'mock',expires_in:3600}:{id:user,username:'tester'}});app.use('/dashboard',createDashboardRouter(client,{fetchImpl:mockFetch,env:{CLIENT_ID:'345678901234567890',DISCORD_CLIENT_SECRET:'fake',DASHBOARD_URL:'http://localhost:9999'}}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const root=`http://127.0.0.1:${server.address().port}`;const key=`guild:${guildId}:jointocreate`;
 const put=async(value,expiry=null)=>pgpool.query('INSERT INTO temp_data(key,value,expires_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=$2,expires_at=$3',[key,JSON.stringify(value),expiry]);const req=(q='',headers={'x-auth':'yes'})=>fetch(root+'/test/join-to-create'+q,{headers});return {pgpool,put,req,root,guild,backend,key};
}
test('inventory scopes exact keys, paginates and does not disclose owner or arbitrary data',{skip:!enabled},async t=>{
 const {pgpool,put,req,root}=await setup(t);const temporaryChannels={};for(let i=1;i<=55;i++)temporaryChannels[mid(i)]={ownerId:user,triggerChannelId:channel,createdAt:1700000000000,secret:'hidden'};
 await put({enabled:true,triggerChannels:[channel],channelOptions:{[channel]:{nameTemplate:'<img src=x>',userLimit:0}},temporaryChannels,privateNote:'private-secret'});await pgpool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)',[`guild:999999999999999999:jointocreate`,JSON.stringify({secret:'other-guild'})]);
 const r=await req();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const raw=await r.text();assert.doesNotMatch(raw,/234567890123456789|private-secret|other-guild|hidden|ownerId/);const d=JSON.parse(raw);assert.equal(d.totalTemporaryChannels,55);assert.equal(d.temporaryChannels.length,50);assert.equal(d.next,mid(50));assert.equal(d.triggers[0].nameTemplate,'<img src=x>');const second=await (await req('?after='+d.next)).json();assert.equal(second.temporaryChannels.length,5);assert.equal(second.next,null);
 for(const q of ['?after=bad','?x=1','?after='+mid(1)+'&after='+mid(2)])assert.equal((await req(q)).status,400);const no=await req('',{'x-auth':'no'});assert.equal(no.status,401);assert.equal(no.headers.get('cache-control'),'no-store');assert.equal((await fetch(root+'/test/join-to-create',{method:'PATCH'})).status,404);
});
test('missing, expired, legacy, malformed and oversized data are distinguished',{skip:!enabled},async t=>{
 const {pgpool,put,req,key}=await setup(t);assert.equal((await (await req()).json()).state,'missing');await pgpool.query('INSERT INTO cache_data(key,value) VALUES($1,$2)',[key,'{}']);assert.equal((await (await req()).json()).otherData,true);
 await put({enabled:true},new Date(Date.now()-60000));assert.equal((await (await req()).json()).state,'expired');await put({enabled:false},new Date(Date.now()+60000));const good=await (await req()).json();assert.equal(good.state,'stored');assert.equal(good.hasExpiry,true);assert.equal(good.userLimit,0);
 for(const bad of [null,[],{ok:true,value:{}},{enabled:'yes'},{temporaryChannels:{bad:{}}},{triggerChannels:[channel,channel]},{channelNameTemplate:'x'.repeat(530000)}]){await put(bad);const res=await req();assert.equal(res.status,409);assert.equal(res.headers.get('cache-control'),'no-store');}
});
test('database failures fail closed and actual dashboard revalidates administrator access',{skip:!enabled},async t=>{
 const {req,backend,root,guild,pgpool}=await setup(t);backend.isConnected=false;assert.equal((await req()).status,503);backend.isConnected=true;const request=(path,opts={})=>fetch(root+path,{redirect:'manual',...opts}),path='/dashboard/api/bot/join-to-create';assert.equal((await request(path)).status,401);const start=await request('/dashboard/login'),cookie=start.headers.get('set-cookie').split(';')[0],state=new URL(start.headers.get('location')).searchParams.get('state');const cb=await request(`/dashboard/callback?code=mock&state=${state}`,{headers:{cookie}});const session=cb.headers.getSetCookie().find(x=>x.startsWith('zx_session=')).split(';')[0];assert.equal((await request(path,{headers:{cookie:session}})).status,200);guild.members.fetch=async()=>({permissions:{has:()=>false}});const forbidden=await request(path,{headers:{cookie:session}});assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('cache-control'),'no-store');await pgpool.query('DROP TABLE temp_data');const failed=await req();assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/relation|temp_data/i);
});
