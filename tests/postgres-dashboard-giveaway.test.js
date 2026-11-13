import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {PermissionFlagsBits} from 'discord.js';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {createGiveawayApi} from '../src/dashboard/giveawayApi.js';
import {createDashboardRouter} from '../src/dashboard/router.js';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
const guildId='123456789012345678',other='123456789012345679',user='234567890123456789',appId='345678901234567890',channel='456789012345678901';
const mid=n=>String(100000000000000000n+BigInt(n));
function giveaway(n,overrides={}){return {messageId:mid(n),guildId,channelId:channel,hostId:user,prize:'Test prize',endsAt:1900000000000,endTime:1900000000000,ended:false,isEnded:false,winnerCount:2,participants:[user,other],...overrides}}
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();const schema='gw_web_'+randomBytes(6).toString('hex');await admin.query(`CREATE SCHEMA "${schema}"`);await admin.query(`CREATE TABLE "${schema}".giveaways(guild_id varchar(20),message_id varchar(20),data jsonb,ends_at timestamp,UNIQUE(guild_id,message_id));CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY,value jsonb);CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY,value jsonb)`);
 const pgpool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:20});t.after(async()=>{await pgpool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});const backend=new PostgreSQLDatabase();backend.pool=pgpool;backend.isConnected=true;
 const guild={id:guildId,name:'Server',ownerId:'999999999999999999',members:{fetch:async()=>({id:user,permissions:{has:p=>p===PermissionFlagsBits.Administrator}})}};const client={homeGuildId:guildId,isReady:()=>true,guilds:{cache:new Map([[guildId,guild]])},db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable())}};
 const auth=(q,r,n)=>{if(q.get('x-auth')!=='yes')return r.sendStatus(401);q.guild=guild;n()};const app=express();app.use('/test',createGiveawayApi(client,{auth,csrf:(q,r,n)=>n()}));const mockFetch=async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'mock',expires_in:3600}:{id:user,username:'tester'}});app.use('/dashboard',createDashboardRouter(client,{fetchImpl:mockFetch,env:{CLIENT_ID:appId,DISCORD_CLIENT_SECRET:'fake',DASHBOARD_URL:'http://localhost:9999'}}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const insert=async(gid,n,data)=>pgpool.query('INSERT INTO giveaways(guild_id,message_id,data) VALUES($1,$2,$3)',[gid,mid(n),JSON.stringify(data)]);
 const req=(path='',headers={'x-auth':'yes'})=>fetch(`${baseUrl}/test/giveaway/list${path}`,{headers});return {client,guild,pgpool,backend,baseUrl,insert,req};
}
test('inventory is guild scoped, paginated, bounded and never returns participant IDs',{skip:!enabled},async t=>{
 const {pgpool,insert,req}=await setup(t);for(let i=1;i<=55;i++)await insert(guildId,i,giveaway(i));await insert(other,90,giveaway(90,{guildId:other,prize:'OTHER_GUILD'}));
 const response=await req();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const raw=await response.text();assert.doesNotMatch(raw,/OTHER_GUILD|participants|winnerIds/);const page=JSON.parse(raw);assert.equal(page.giveaways.length,50);assert.equal(page.next,mid(50));assert.equal(page.giveaways[0].entries,2);assert.equal(page.giveaways[0].status,'active');assert.equal(page.legacyDetected,false);
 const next=await (await req('?after='+page.next)).json();assert.equal(next.giveaways.length,5);assert.equal(next.next,null);assert.equal(next.giveaways[0].messageId,mid(51));assert.equal((await req('?after=invalid')).status,400);assert.equal((await req('?after='+mid(1)+'&x=bad')).status,400);assert.equal((await req('?after='+mid(1)+'&after='+mid(2))).status,400);assert.equal((await req('',{'x-auth':'no'})).status,401);assert.equal((await pgpool.query('SELECT count(*)::int AS n FROM giveaways')).rows[0].n,56);
});
test('inconsistent and oversized rows are explicitly marked for review; exact legacy map is flagged',{skip:!enabled},async t=>{
 const {pgpool,insert,req}=await setup(t);await insert(guildId,1,giveaway(1,{ended:true,isEnded:false,endsAt:100,endTime:200,participants:'bad',prize:'<img src=x>',deliveryStatus:'pending',deliveryToken:'sensitive-token',secret:'do not expose'}));await insert(guildId,2,giveaway(2,{prize:'x'.repeat(270000)}));await pgpool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)',[`guild:${guildId}:giveaways`,JSON.stringify({legacy:true})]);const res=await req();const data=await res.json();assert.equal(data.legacyDetected,true);assert.equal(data.giveaways[0].status,'review');assert.equal(data.giveaways[0].review,true);assert.equal(data.giveaways[0].entries,null);assert.equal(data.giveaways[0].delivery,'pending');assert.ok(data.giveaways[0].warnings.length>=3);assert.equal(data.giveaways[1].review,true);assert.equal(data.giveaways[1].prize,undefined);assert.doesNotMatch(JSON.stringify(data),/do not expose|participants|sensitive-token/);
 await pgpool.query("UPDATE giveaways SET message_id='' WHERE message_id=$1",[mid(1)]);assert.equal((await req()).status,409);
});
test('unavailable database fails closed and API has no mutation methods',{skip:!enabled},async t=>{
 const {backend,req,baseUrl}=await setup(t);backend.isConnected=false;assert.equal((await req()).status,503);const update=await fetch(baseUrl+'/test/giveaway/list',{method:'PATCH',headers:{'x-auth':'yes','content-type':'application/json'},body:'{}'});assert.equal(update.status,404);
});
test('actual dashboard requires login and revalidates admin membership',{skip:!enabled},async t=>{
 const {guild,baseUrl}=await setup(t);const request=(path,opts={})=>fetch(baseUrl+path,{redirect:'manual',...opts}),path='/dashboard/api/bot/giveaway/list';assert.equal((await request(path)).status,401);const start=await request('/dashboard/login'),cookie=start.headers.get('set-cookie').split(';')[0],state=new URL(start.headers.get('location')).searchParams.get('state');const cb=await request(`/dashboard/callback?code=mock&state=${state}`,{headers:{cookie}});const session=cb.headers.getSetCookie().find(x=>x.startsWith('zx_session=')).split(';')[0];assert.equal((await request(path,{headers:{cookie:session}})).status,200);guild.members.fetch=async()=>({permissions:{has:()=>false}});assert.equal((await request(path,{headers:{cookie:session}})).status,403);
});
