import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createModulesApi } from '../src/dashboard/modulesApi.js';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
const id='111111111111111111',channelId='222222222222222222', roleId='333333333333333333',botId='444444444444444444', messageId='555555555555555555';
function setupFixture(){
 let cfg={verification:{enabled:false},logging:{enabled:false,channels:{audit:null,applications:null,reports:null},enabledEvents:{},ignore:{users:[],channels:[]}}}, welcome={}, fail=false, sends=0, edits=0, messages=new Map();
 const query=async(sql,args=[])=>{if(fail)throw Error('db unavailable');if(sql.startsWith('SELECT config FROM guilds'))return {rows:[{config:structuredClone(cfg)}]};if(sql.startsWith('SELECT config FROM welcome_configs'))return {rows:[{config:structuredClone(welcome)}]};if(sql.startsWith('UPDATE guilds'))cfg=JSON.parse(args[1]);return {rows:[]}};
 const pool={query,connect:async()=>({query,release(){}})};
 const channel={id:channelId,name:'verify',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),messages:{fetch:async arg=>{if(typeof arg==='object')return messages;const x=messages.get(arg);if(!x){let e=new Error('missing');e.code=10008;throw e}return x;}},send:async payload=>{sends++;const msg={id:messageId,author:{id:botId},components:payload.components,edit:async()=>{edits++}};messages.set(messageId,msg);return msg;}};
 const role={id:roleId,name:'Members',managed:false}, me={permissions:{has:p=>p===PermissionFlagsBits.ManageRoles},roles:{highest:{comparePositionTo:()=>1}}};
 const guild={id,channels:{cache:new Map([[channelId,channel]])},roles:{cache:new Map([[roleId,role]])},members:{me}};
 const client={user:{id:botId},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool}}};
 return {client,guild,getCfg:()=>cfg,setCfg:v=>cfg=v,setWelcome:v=>welcome=v,setFail:v=>fail=v,sends:()=>sends,edits:()=>edits};
}
async function start(t,fx){const app=express();const auth=(req,res,next)=>{if(req.get('x-auth')!=='yes')return res.sendStatus(401);req.guild=fx.guild;next()};const csrf=(req,res,next)=>req.get('x-csrf')==='yes'?next():res.sendStatus(403);app.use('/api',createModulesApi(fx.client,{auth,csrf}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api`;
 return (path,method='GET',body,headers={})=>fetch(base+path,{method,headers:{'x-auth':'yes','x-csrf':'yes','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const verify={enabled:true,channelId,roleId,message:'Welcome',buttonText:'Verify'};
test('verification conflicts, save, panel create then update, and auth',async t=>{
 const fx=setupFixture(),req=await start(t,fx);
 assert.equal((await req('/settings/verification','GET',undefined,{'x-auth':'no'})).status,401);
 assert.equal((await req('/settings/verification','PATCH',verify,{'x-csrf':'no'})).status,403);
 fx.setWelcome({roleIds:[roleId]});assert.equal((await req('/settings/verification','PATCH',verify)).status,409);fx.setWelcome({});
 assert.equal((await req('/settings/verification','PATCH',verify)).status,200);assert.equal(fx.getCfg().verification.roleId,roleId);
 assert.equal((await req('/panel/verification','POST',{confirmed:false})).status,400);
 assert.equal((await req('/panel/verification','POST',{confirmed:true})).status,200);assert.equal(fx.sends(),1);assert.equal(fx.getCfg().verification.messageId,messageId);
 assert.equal((await req('/panel/verification','POST',{confirmed:true})).status,200);assert.equal(fx.sends(),1);assert.equal(fx.edits(),1);
 assert.equal((await req('/settings/verification','PATCH',{...verify,channelId:null,enabled:false})).status,409);
 fx.setFail(true);assert.equal((await req('/settings/verification')).status,503);
});
test('logging uses allowed events and leveling retains required runtime defaults',async t=>{
 const fx=setupFixture(),req=await start(t,fx);
 const logging={enabled:true,channels:{audit:channelId,applications:null,reports:null},enabledEvents:{'member.*':false,'message.edit':true}};
 assert.equal((await req('/settings/logging','PATCH',{...logging,enabledEvents:{'invalid.key':true}})).status,400);
 assert.equal((await req('/settings/logging','PATCH',logging)).status,200);assert.equal(fx.getCfg().logging.enabledEvents['member.*'],false);
 const level={enabled:true,min:15,max:25,cooldown:20,channelId:null,announce:true,publicLeaderboard:false};
 assert.equal((await req('/settings/leveling','PATCH',{...level,min:26})).status,400);
 assert.equal((await req('/settings/leveling','PATCH',level)).status,200);assert.match(fx.getCfg().leveling.levelUpMessage,/{level}/);assert.deepEqual(fx.getCfg().leveling.ignoredChannels,[]);
});
test('integrated pages load and other tabs remain simulation',async()=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const d=new JSDOM(html,{url:'http://localhost/dashboard/#features/logging',runScripts:'outside-only'}),w=d.window;w.scrollTo=()=>{};
 w.fetch=async u=>({ok:true,json:async()=>String(u).endsWith('/me')?{user:{username:'Test'},guild:{name:'Server'},csrf:'x'}:{settings:{enabled:false,channels:{},enabledEvents:{}},events:['member.join'],groups:['member'],channels:[],categories:[],roles:[]}});
 for(const x of ['session.js','live.js','modules-live.js','features.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));await new Promise(r=>setTimeout(r,30));assert.ok(w.document.querySelector('#moduleForm'));assert.match(w.document.querySelector('#moduleForm').textContent,/member.join/);w.close();
});

test('browser operation views escape Discord-sourced text',async()=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const d=new JSDOM(html,{url:'http://localhost/dashboard/#features/moderation',runScripts:'outside-only'}),w=d.window;w.scrollTo=()=>{};
 w.fetch=async u=>({ok:true,json:async()=>String(u).endsWith('/me')?{user:{username:'Test'},guild:{name:'Server'},csrf:'x'}:{cases:[{caseId:1,action:'<img src=x onerror=alert(1)>',target:'someone',reason:'test'}]}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));await new Promise(r=>setTimeout(r,25));assert.equal(w.document.querySelector('#opsLive img'),null);assert.match(w.document.querySelector('#opsLive').textContent,/<img/);w.close();
});

test('music and member management UI renders and attaches handlers',async()=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const files=['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-studio.js','app.js'];
 const d=new JSDOM(html,{url:'http://localhost/dashboard/#features/music',runScripts:'outside-only'}),w=d.window;w.scrollTo=()=>{};
 w.fetch=async u=>({ok:true,json:async()=>String(u).endsWith('/me')?{user:{username:'Test'},guild:{name:'Server'},csrf:'x'}:String(u).endsWith('/music')?{available:true,active:false,queue:[],voiceChannels:[{id:channelId,name:'voice'}],textChannels:[{id:channelId,name:'general'}]}:String(u).endsWith('/settings/economy')?{settings:{premiumRoleId:null},roles:[]}:String(u).includes('/members/')?{member:{name:'Member'},economy:{wallet:15,bank:5},level:{level:2,totalXp:300}}:{settings:{enabled:true,xpPerMessage:{min:15,max:25}},channels:[],categories:[],roles:[],events:[],groups:[]}});
 files.forEach(x=>w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8')));await new Promise(r=>setTimeout(r,25));assert.ok(w.document.querySelector('#searchMusic'));assert.ok(w.document.querySelector('[name=voiceChannelId]'));
 w.location.hash='#features/economy';await new Promise(r=>setTimeout(r,25));w.document.querySelector('[data-tab="economy"]').click();await new Promise(r=>setTimeout(r,25));const f=w.document.querySelector('#memberSearch');assert.ok(f);f.elements.id.value=roleId;f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,25));assert.ok(w.document.querySelector('[data-edit="wallet"]'));assert.ok(w.document.querySelector('[data-edit="bank"]'));assert.ok(w.document.querySelector('[data-edit="level"]'));w.close();
});

test('advanced leveling settings are validated and persist without erasing other data',async t=>{
 const fx=setupFixture(),req=await start(t,fx);
 const base={enabled:true,min:15,max:25,cooldown:20,channelId:null,announce:true,publicLeaderboard:false};
 const advanced={...base,levelUpMessage:'Congrats {user} level {level}',ignoredChannels:[channelId],ignoredRoles:[roleId],roleRewards:{'10':roleId}};
 assert.equal((await req('/settings/leveling','PATCH',advanced)).status,200);
 assert.deepEqual(fx.getCfg().leveling.roleRewards,{'10':roleId});
 assert.deepEqual(fx.getCfg().leveling.ignoredChannels,[channelId]);
 assert.equal(fx.getCfg().leveling.levelUpMessage,advanced.levelUpMessage);
 for(const patch of [{ignoredChannels:['999999999999999999']},{ignoredRoles:['999999999999999999']},{roleRewards:{'501':roleId}},{roleRewards:{'10':'999999999999999999'}},{levelUpMessage:''},{ignoredRoles:[roleId,roleId]}]){
   assert.equal((await req('/settings/leveling','PATCH',{...advanced,...patch})).status,400);
 }
 assert.equal((await req('/settings/leveling','PATCH',base)).status,200);
 assert.deepEqual(fx.getCfg().leveling.roleRewards,{'10':roleId});
 assert.equal((await req('/settings/leveling','PATCH',advanced,{'x-csrf':'no'})).status,403);
});

test('leveling browser submits advanced controls to real settings endpoint',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');
 const d=new JSDOM(html,{url:'http://localhost/dashboard/#features/economy',runScripts:'outside-only'}),w=d.window; t.after(()=>w.close()); w.scrollTo=()=>{};let submitted;
 w.fetch=async (url,opts={})=>{if(opts.method==='PATCH')submitted=JSON.parse(opts.body);return {ok:true,json:async()=>String(url).endsWith('/me')?{user:{username:'Tester'},guild:{name:'Server'},csrf:'x'}:{settings:{enabled:true,levelUpMessage:'Test {level}',ignoredChannels:[channelId],ignoredRoles:[roleId],roleRewards:{'10':roleId}},channels:[{id:channelId,name:'chat'}],roles:[{id:roleId,name:'Role'}],categories:[],events:[],groups:[]}}};
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,40));const form=w.document.querySelector('#moduleForm');assert.ok(form);assert.match(form.elements.roleRewards.value,/10:/);form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,20));assert.equal(submitted.levelUpMessage,'Test {level}');assert.deepEqual(Array.from(submitted.ignoredChannels),[channelId]);assert.equal(submitted.roleRewards['10'],roleId);w.close();
});
