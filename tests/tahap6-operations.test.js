import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOperationsApi} from '../src/dashboard/operationsApi.js';
const id='111111111111111111', userId='222222222222222222', channelId='333333333333333333', botId='444444444444444444';
async function fixture(t){
 let stopped=0,paused=false;
 const player={current:{info:{title:'Safe <song>',author:'Artist'}},queue:[],playing:true,paused:false,voiceChannel:channelId,textChannel:channelId,pause:x=>{paused=x},stop:()=>{stopped++},setVolume() {}};
 const channel={id:channelId,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>new Map([['1',{id:'1',author:{tag:'user'},createdAt:new Date(0),content:'hello',attachments:new Map()}]])}};
 const guild={id,channels:{cache:new Map([[channelId,channel]])},members:{me:{},fetch:async()=>null}};
 const query=async(sql,args)=>{if(sql.includes('FROM ticket_data') && args.length===1)return {rows:[{channel_id:channelId,data:{userId,status:'open'}}]};if(sql.includes('FROM ticket_data'))return {rows:args[1]===channelId?[{data:{userId,status:'open'}}]:[]};if(sql.includes('FROM temp_data'))return {rows:[{value:[{caseId:1,action:'Warn'}]}]};return {rows:[]}};
 const client={user:{id:botId},channels:{cache:new Map()},riffy:{players:new Map([[id,player]]),nodeMap:new Map([['a',{connected:true}]])},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:{query}}}};
 const app=express(),auth=(req,res,next)=>{if(req.get('x-auth')!=='yes')return res.sendStatus(401);req.guild=guild;req.member={id:userId,user:{id:userId},voice:{channel:null}};next()},csrf=(req,res,next)=>req.get('x-csrf')==='yes'?next():res.sendStatus(403);
 app.use('/api',createOperationsApi(client,{auth,csrf}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api`;
 const req=(path,method='GET',body,headers={})=>fetch(base+path,{method,headers:{'x-auth':'yes','x-csrf':'yes','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {req,stopped:()=>stopped,paused:()=>paused};
}
test('ticket and transcript routes require auth and verify guild ticket',async t=>{const {req}=await fixture(t);assert.equal((await req('/tickets','GET',null,{'x-auth':'no'})).status,401);const list=await (await req('/tickets')).json();assert.equal(list.tickets[0].channelId,channelId);assert.equal((await req(`/tickets/${userId}/transcript`)).status,404);const x=await (await req(`/tickets/${channelId}/transcript`)).json();assert.equal(x.messages[0].content,'hello');assert.equal((await req(`/tickets/${channelId}/action`,'POST',{action:'close',confirmed:false})).status,400);});
test('admin can control active music without voice membership',async t=>{const {req,paused,stopped}=await fixture(t);const m=await (await req('/music')).json();assert.equal(m.current.title,'Safe <song>');assert.equal((await req('/music','POST',{action:'pause',confirmed:true},{'x-csrf':'no'})).status,403);assert.equal((await req('/music','POST',{action:'pause',confirmed:true})).status,200);assert.equal(paused(),true);assert.equal((await req('/music','POST',{action:'skip',confirmed:true})).status,200);assert.equal(stopped(),1);assert.equal((await req('/music/search','POST',{query:'http://127.0.0.1:8080/private'})).status,400);assert.equal((await req('/music/search','POST',{query:'file:///etc/passwd'})).status,400);});
test('moderation requires confirmation and rejects self or missing target',async t=>{const {req}=await fixture(t);assert.equal((await req('/moderation','POST',{action:'ban',userId,reason:'x',confirmed:false})).status,400);assert.equal((await req('/moderation','POST',{action:'ban',userId,reason:'x',confirmed:true})).status,400);assert.equal((await req('/cases','GET',null,{'x-auth':'no'})).status,401);assert.equal((await (await req('/cases')).json()).cases.length,1);});

test('member balance update preserves bank and rejects stale edits',async t=>{
 let economy={balance:'100',bank:'40',data:{}};let level={level:3,xp:'2',total_xp:'300'};
 const member={id:userId,user:{tag:'Member#0001'}};
 const guild={id,members:{fetch:async()=>member}};
 const query=async(sql,args=[])=>{
  if(sql.includes('SELECT balance,bank,data'))return {rows:[structuredClone(economy)]};
  if(sql.includes('SELECT xp,level,total_xp'))return {rows:[structuredClone(level)]};
  if(sql.includes('SELECT level FROM'))return {rows:[{level:level.level}]};
  if(sql.startsWith('UPDATE economy')){economy={balance:args[2],bank:args[3],data:JSON.parse(args[4])};return {rows:[]}}
  if(sql.startsWith('UPDATE user_levels')){level={level:args[2],xp:0,total_xp:args[3]};return {rows:[]}}
  return {rows:[]};
 };
 const db={query,connect:async()=>({query,release(){}})};
 const client={db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:db}}};
 const auth=(req,res,next)=>{req.guild=guild;req.member={id:'555555555555555555'};next()},csrf=(req,res,next)=>next();const app=express();app.use('/api',createOperationsApi(client,{auth,csrf}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const root=`http://127.0.0.1:${server.address().port}/api/members/${userId}`;const post=b=>fetch(root,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
 const read=await (await fetch(root)).json();assert.equal(read.economy.wallet,100);assert.equal(read.economy.bank,40);
 assert.equal((await post({type:'wallet',value:200,expected:99,confirmed:true})).status,409);
 assert.equal((await post({type:'wallet',value:200,expected:100,confirmed:true})).status,200);assert.equal(economy.data.wallet,200);assert.equal(economy.data.bank,40);
 assert.equal((await post({type:'bank',value:60,expected:40,confirmed:true})).status,200);assert.equal(economy.data.wallet,200);assert.equal(economy.data.bank,60);
 assert.equal((await post({type:'level',value:5,expected:3,confirmed:true})).status,200);assert.equal(level.level,5);assert.equal(level.xp,0);
});

test('public leaderboard is off unless server opted in',async t=>{
 let enabled=false;const query=async sql=>sql.includes('FROM guilds')?{rows:[{config:{publicLeaderboard:enabled}}]}:{rows:[{user_id:userId,level:3,total_xp:'500'}]};
 const client={homeGuildId:id,isReady:()=>true,guilds:{cache:new Map([[id,{id,name:'Server'}]])},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:{query}}}};
 const app=express();app.use('/api',createOperationsApi(client,{auth:(req,res)=>res.sendStatus(401),csrf:(req,res)=>res.sendStatus(403)}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const url=`http://127.0.0.1:${server.address().port}/api/public/leaderboard`;
 assert.equal((await fetch(url)).status,404);enabled=true;const data=await (await fetch(url)).json();assert.equal(data.leaderboard[0].userId,userId);assert.equal(data.leaderboard[0].totalXp,500);
});
