import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {ChannelType} from 'discord.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSQLiteStore} from '../src/services/storage/sqlite.js';
import {createSQLiteBotDatabase} from '../src/services/storage/sqliteBotDatabase.js';
import {createBotApiRouter} from '../src/dashboard/botApi.js';
import {createModulesApi} from '../src/dashboard/modulesApi.js';
const guildId='123456789012345678',channelId='234567890123456789',roleId='345678901234567890';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'zentix-dash-sqlite-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const sqlite=await openSQLiteStore({path:join(dir,'data.db')}),adapter=createSQLiteBotDatabase(sqlite);
 const role={id:roleId,name:'Member',managed:false},me={permissions:{has:()=>true},roles:{highest:{comparePositionTo:()=>1}}},channel={id:channelId,name:'general',type:ChannelType.GuildText};
 const guild={id:guildId,channels:{cache:new Map([[channelId,channel]])},roles:{cache:new Map([[roleId,role]])},members:{me}};
 const client={homeGuildId:guildId,db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:adapter}};
 const auth=(req,res,next)=>{if(req.get('auth')!=='yes')return res.sendStatus(401);req.guild=guild;next()},csrf=(req,res,next)=>req.get('csrf')==='yes'?next():res.sendStatus(403);
 const app=express();app.use('/bot',createBotApiRouter(client,{auth,csrf}));app.use('/modules',createModulesApi(client,{auth,csrf}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.close();sqlite.close()});
 const request=(url,method='GET',body,headers={})=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{auth:'yes',csrf:'yes','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {sqlite,adapter,request};
}
const welcome={enabled:true,channelId,welcomeMessage:'Halo {user}',welcomePing:false,welcomeImage:null,roleIds:[roleId],welcomeEmbed:{title:'Halo',footer:'',color:42}};
const verify={enabled:true,channelId,roleId,message:'Verify',buttonText:'Verify'};
test('SQLite dashboard saves bot welcome and module settings with auth and CSRF',async t=>{
 const {request,adapter}=await fixture(t);assert.equal((await request('/bot/welcome','GET',null,{auth:'no'})).status,401);assert.equal((await request('/bot/welcome','PATCH',welcome,{csrf:'no'})).status,403);assert.equal((await request('/bot/welcome','PATCH',welcome)).status,200);assert.deepEqual((await adapter.get(`guild:${guildId}:welcome`)).roleIds,[roleId]);
 assert.equal((await request('/modules/settings/verification','PATCH',verify)).status,409);assert.equal((await request('/bot/welcome','PATCH',{...welcome,roleIds:[]})).status,200);assert.equal((await request('/modules/settings/verification','PATCH',verify)).status,200);assert.equal((await request('/bot/welcome','PATCH',welcome)).status,409);assert.equal((await adapter.get(`guild:${guildId}:config`)).verification.enabled,true);
 const log={enabled:true,channels:{audit:channelId,applications:null,reports:null},enabledEvents:{'member.join':true}};assert.equal((await request('/modules/settings/logging','PATCH',log)).status,200);assert.equal((await adapter.get(`guild:${guildId}:config`)).logging.enabled,true);
});
test('competing verification and autorole updates cannot both pass',async t=>{
 const {sqlite,request,adapter}=await fixture(t);for(let i=0;i<8;i++){
  sqlite.transaction(tx=>{tx.botSet(`guild:${guildId}:config`,{verification:{enabled:false}});tx.botSet(`guild:${guildId}:welcome`,{roleIds:[]})});
  const [a,b]=await Promise.all([request('/bot/welcome','PATCH',welcome),request('/modules/settings/verification','PATCH',verify)]);assert.deepEqual([a.status,b.status].sort(),[200,409]);const cfg=await adapter.get(`guild:${guildId}:config`),w=await adapter.get(`guild:${guildId}:welcome`);assert.equal(Boolean(cfg.verification?.enabled&&w.roleIds?.length),false);
 }
});
test('legacy wrapper format is not silently rewritten',async t=>{
 const {sqlite,request}=await fixture(t),old={ok:true,value:{custom:1}};sqlite.transaction(tx=>tx.botSet(`guild:${guildId}:welcome`,old));assert.equal((await request('/bot/welcome','PATCH',welcome)).status,503);assert.deepEqual(sqlite.botGet(`guild:${guildId}:welcome`),old);
 sqlite.transaction(tx=>tx.botSet(`guild:${guildId}:config`,old));const log={enabled:true,channels:{audit:channelId,applications:null,reports:null},enabledEvents:{}};assert.equal((await request('/modules/settings/logging','PATCH',log)).status,409);assert.deepEqual(sqlite.botGet(`guild:${guildId}:config`),old);
});
test('SQLite operations read moderation cases and only actual guild tickets',async t=>{
 const {sqlite,adapter}=await fixture(t);const {createOperationsApi}=await import('../src/dashboard/operationsApi.js');const g={id:guildId,channels:{cache:new Map()},members:{me:{}}},client={homeGuildId:guildId,user:{id:roleId},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:adapter}};
 const auth=(req,res,next)=>{req.guild=g;next()},csrf=(req,res,next)=>next(),app=express();app.use('/operations',createOperationsApi(client,{auth,csrf}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 await adapter.set(`moderation_cases_list_${guildId}`,[{caseId:1},{caseId:2}]);await adapter.set(`guild:${guildId}:ticket:counter`,100);await adapter.set(`guild:${guildId}:ticket:not-a-channel`,{status:'open'});await adapter.set(`guild:${guildId}:ticket:${channelId}`,{userId:roleId,status:'open',createdAt:'now'});
 const get=path=>fetch(`http://127.0.0.1:${server.address().port}/operations${path}`);assert.deepEqual((await (await get('/cases')).json()).cases.map(x=>x.caseId),[2,1]);const tickets=(await (await get('/tickets')).json()).tickets;assert.equal(tickets.length,1);assert.equal(tickets[0].channelId,channelId);assert.equal((await (await get(`/tickets/${channelId}`)).json()).ticket.userId,roleId);assert.equal((await get(`/tickets/${roleId}`)).status,404);
 sqlite.transaction(tx=>tx.botSet(`moderation_cases_list_${guildId}`,[{caseId:3}],Date.now()-1));assert.deepEqual((await (await get('/cases')).json()).cases,[]);
});
test('SQLite leaderboard privacy and member edits use guarded atomic transactions',async t=>{
 const {sqlite,adapter}=await fixture(t),{createOperationsApi}=await import('../src/dashboard/operationsApi.js'),{withEconomyTransaction}=await import('../src/services/economy/transaction.js');
 const member={id:roleId,user:{tag:'Tester'}},g={id:guildId,name:'Test Guild',members:{fetch:async()=>member}},client={homeGuildId:guildId,isReady:()=>true,guilds:{cache:new Map([[guildId,g]])},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:adapter}};
 const auth=(req,res,next)=>{req.guild=g;req.member={id:channelId};next()},csrf=(req,res,next)=>next(),app=express();app.use('/operations',createOperationsApi(client,{auth,csrf}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const req=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}/operations${path}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
 await adapter.set(`guild:${guildId}:config`,{publicLeaderboard:false});await adapter.set(`guild:${guildId}:leveling:users:${roleId}`,{level:3,xp:7,totalXp:250,lastMessage:44});await withEconomyTransaction(client,guildId,[roleId],m=>{m.get(roleId).wallet=100;m.get(roleId).bank=20});
 assert.equal((await req('/public/leaderboard')).status,404);await adapter.set(`guild:${guildId}:config`,{publicLeaderboard:true});const pub=await (await req('/public/leaderboard')).json();assert.equal(pub.leaderboard[0].totalXp,250);assert.equal(pub.leaderboard[0].userId,roleId);
 let profile=await (await req(`/members/${roleId}`)).json();assert.equal(profile.economy.wallet,100);assert.equal(profile.level.totalXp,250);
 const patch=(value,expected)=>req(`/members/${roleId}`,{type:'wallet',value,expected,confirmed:true});const [a,b]=await Promise.all([patch(200,100),patch(300,100)]);assert.deepEqual([a.status,b.status].sort(),[200,409]);const current=sqlite.getAccount(guildId,roleId);assert.ok([200,300].includes(current.wallet));assert.equal(current.bank,20);
 assert.equal((await req(`/members/${roleId}`,{type:'level',value:5,expected:3,confirmed:true})).status,200);profile=await (await req(`/members/${roleId}`)).json();assert.equal(profile.level.level,5);assert.equal(profile.level.xp,0);assert.equal((await adapter.get(`guild:${guildId}:leveling:users:${roleId}`)).lastMessage,44);
});
test('SQLite leaderboard prefers canonical level keys over legacy aliases',async t=>{
 const {sqlite}=await fixture(t),legacy=`${guildId}:leveling:users:${roleId}`,key=`guild:${guildId}:leveling:users:${roleId}`;sqlite.transaction(tx=>{tx.botSet(legacy,{level:1,totalXp:10});tx.botSet(key,{level:5,totalXp:500})});const rows=sqlite.botLevels(guildId);assert.equal(rows.length,1);assert.equal(rows[0].data.totalXp,500);
});
