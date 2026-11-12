import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { createDashboardRouter } from '../src/dashboard/router.js';
import { buildWelcomePayload } from '../src/services/welcomePayload.js';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const id='123456789012345678', uid='234567890123456789', channelId='345678901234567890', roleId='456789012345678901';
function fixture() {
 let raw={enabled:true,channelId,welcomeMessage:'Hello {user}',roleIds:[],welcomePing:false,welcomeEmbed:{title:'Welcome',footer:'Footer',color:0x33cc00},custom:'untouched'};
 let config={verification:{enabled:false}}; let degraded=false, failRead=false, failWrite=false, sent=[];
 let permissions={has:p=>Array.isArray(p) ? true : p===PermissionFlagsBits.EmbedLinks || p===PermissionFlagsBits.ManageRoles};
 let channel={id:channelId,name:'welcome',type:ChannelType.GuildText,permissionsFor:()=>permissions,send:async payload=>sent.push(payload)};
 let role={id:roleId,name:'Members',managed:false}; let me={permissions,roles:{highest:{comparePositionTo:()=>1}}};
 let guild={id,name:'Test server',ownerId:'888888888888888888',memberCount:42,channels:{cache:new Map([[channelId,channel]])},roles:{cache:new Map([[roleId,role]])},members:{me,fetch:async()=>member}};
 let member={guild,user:{id:uid,tag:'Test#0001',username:'Test',displayAvatarURL:()=> 'https://cdn.discordapp.com/test.png',toString:()=>`<@${uid}>`},permissions:{has:p=>p===PermissionFlagsBits.Administrator}};
 const query=async(sql,args=[])=>{
   if(failRead && sql.startsWith('SELECT')) throw Error('db down');
   if(sql.startsWith('SELECT config FROM welcome_configs')) return {rows:[{config:structuredClone(raw)}]};
   if(sql.startsWith('SELECT config FROM guilds')) return {rows:[{config:structuredClone(config)}]};
   if(sql.startsWith('UPDATE welcome_configs')) {if(failWrite)throw Error('write failed');raw=JSON.parse(args[1]);}
   return {rows:[]};
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const client={homeGuildId:id,isReady:()=>true,uptime:120000,ws:{ping:35},guilds:{cache:new Map([[id,guild]])},db:{getStatus:()=>({isDegraded:degraded}),isAvailable:()=>!degraded,db:{isAvailable:()=>!degraded,pool}}};
 return {client,guild,member,channel,sent,getRaw:()=>raw,setConfig:v=>config=v,setDegraded:v=>degraded=v,setFailRead:v=>failRead=v,setFailWrite:v=>failWrite=v};
}
async function setup(t,fx) {
 const mockFetch=async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'fake',expires_in:3600}:{id:uid,username:'Test'}});
 const app=express();app.use('/dashboard',createDashboardRouter(fx.client,{fetchImpl:mockFetch,env:{CLIENT_ID:id,DISCORD_CLIENT_SECRET:'secret',DASHBOARD_URL:'http://localhost:9999'}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}`;
 const req=(p,opt={})=>fetch(base+p,{redirect:'manual',...opt});const begin=await req('/dashboard/login');const state=new URL(begin.headers.get('location')).searchParams.get('state');const stateCookie=begin.headers.get('set-cookie').split(';')[0];
 const cb=await req(`/dashboard/callback?code=x&state=${state}`,{headers:{cookie:stateCookie}});assert.equal(cb.status,302);
 const session=cb.headers.getSetCookie().find(x=>x.startsWith('zx_session=')).split(';')[0]; const me=await (await req('/dashboard/api/me',{headers:{cookie:session}})).json();
 const get=p=>req('/dashboard/api/bot/'+p,{headers:{cookie:session}});
 const write=(method,path,body,extra={})=>req('/dashboard/api/bot/'+path,{method,headers:{cookie:session,origin:'http://localhost:9999','content-type':'application/json','x-csrf-token':me.csrf,...extra},body:JSON.stringify(body)});
 return {get,write,req,session};
}
const patch={enabled:true,channelId,welcomeMessage:'Hi {user}',welcomePing:true,welcomeImage:null,roleIds:[],welcomeEmbed:{title:'Halo',footer:'Welcome',color:123}};
test('live overview and welcome read/write, permissions, CSRF and test send',async t=>{
 const fx=fixture(), {get,write,req}=await setup(t,fx);
 assert.equal((await req('/dashboard/api/bot/welcome')).status,401);
 const overview=await (await get('overview')).json(); assert.equal(overview.guild.memberCount,42);assert.equal(overview.ping,35);
 const welcome=await (await get('welcome')).json();assert.equal(welcome.welcome.welcomeMessage,'Hello {user}');assert.equal(welcome.channels[0].id,channelId);assert.equal(welcome.roles[0].id,roleId);
 assert.equal((await write('PATCH','welcome',patch,{origin:'https://evil.example'})).status,403);
 assert.equal((await write('PATCH','welcome',{...patch,channelId:'987654321098765432'})).status,400);
 assert.equal((await write('PATCH','welcome',{...patch,welcomeImage:'http://example.com/img.png'})).status,400);
 assert.equal((await write('PATCH','welcome',{...patch,roleIds:[roleId],extra:true})).status,400);
 fx.setConfig({verification:{enabled:true}});assert.equal((await write('PATCH','welcome',{...patch,roleIds:[roleId]})).status,409);
 fx.setConfig({verification:{enabled:false}});assert.equal((await write('PATCH','welcome',patch)).status,200);
 assert.equal(fx.getRaw().custom,'untouched');assert.equal(fx.getRaw().welcomeMessage,'Hi {user}');
 assert.equal((await write('POST','welcome/test',{})).status,400);
 assert.equal((await write('POST','welcome/test',{confirmed:true})).status,200);assert.equal(fx.sent.length,1);assert.deepEqual(fx.sent[0].allowedMentions,{parse:[],users:[]});assert.match(fx.sent[0].embeds[0].data.description,/Hi/);
 fx.setDegraded(true);assert.equal((await get('welcome')).status,503);assert.equal((await write('PATCH','welcome',patch)).status,503);fx.setDegraded(false);
 fx.setFailRead(true);assert.equal((await get('welcome')).status,503);fx.setFailRead(false);fx.setFailWrite(true);assert.equal((await write('PATCH','welcome',patch)).status,503);
});
test('real welcome payload uses stored embed, prevents unwanted mentions, and supports fallback',()=>{
 const {member}=fixture();const cfg={...patch,welcomeMessage:'Welcome {user} to {server}'};
 const p=buildWelcomePayload({member,config:cfg});assert.equal(p.embeds[0].data.title,'Halo');assert.equal(p.embeds[0].data.color,123);assert.deepEqual(p.allowedMentions.users,[uid]);
 const fallback=buildWelcomePayload({member,config:{...cfg,welcomePing:false},canEmbed:false});assert.match(fallback.content,/Welcome/);assert.deepEqual(fallback.allowedMentions.users,[]);
});

test('browser live overview hides sample hosting data and renders bot data',async()=>{
 const files=['session.js','live.js','features.js','ai-studio.js','app.js'].map(x=>fs.readFileSync('dashboard-preview/'+x,'utf8'));
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');
 const dom=new JSDOM(html,{url:'http://localhost/dashboard/',runScripts:'outside-only'});const w=dom.window;w.scrollTo=()=>{};
 w.fetch=async url=>({ok:!String(url).endsWith('/hosting'),json:async()=>String(url).endsWith('/hosting')?{error:'Belum tersedia'}:String(url).endsWith('/me')?{user:{id:uid,username:'Test'},guild:{id,name:'Server'},csrf:'csrf'}: {guild:{memberCount:42},online:true,ping:35,uptime:120000,database:'connected'}});
 for(const code of files)w.eval(code);await new Promise(r=>setTimeout(r,20));
 assert.match(w.document.querySelector('.metrics').textContent,/42/);assert.match(w.document.querySelector('.resource-section').textContent,/belum tersedia/i);assert.doesNotMatch(w.document.querySelector('.resource-section').textContent,/384|142|24%/);
 w.close();
});

test('welcome UI loads stored values safely and submits real validated fields',async()=>{
 const files=['session.js','live.js','features.js','ai-studio.js','app.js'].map(x=>fs.readFileSync('dashboard-preview/'+x,'utf8'));
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');
 const dom=new JSDOM(html,{url:'http://localhost/dashboard/#features/welcome',runScripts:'outside-only'});const w=dom.window;w.scrollTo=()=>{};let saved;
 w.fetch=async(url,opts={})=>{const p=String(url);if(p.endsWith('/me'))return {ok:true,json:async()=>({user:{id:uid,username:'Test'},guild:{id,name:'Server'},csrf:'csrf'})};
 if(p.endsWith('/welcome')&&opts.method==='PATCH'){saved={body:JSON.parse(opts.body),csrf:opts.headers['x-csrf-token']};return {ok:true,json:async()=>({ok:true})};}
 return {ok:true,json:async()=>({welcome:{...patch,welcomeMessage:'<img src=x onerror=alert(1)>',roleIds:[]},channels:[{id:channelId,name:'safe'}],roles:[],verificationActive:false})};};
 files.forEach(x=>w.eval(x));await new Promise(r=>setTimeout(r,25));
 const form=w.document.getElementById('realWelcome');assert.ok(form);assert.equal(form.elements.welcomeMessage.value,'<img src=x onerror=alert(1)>');assert.equal(form.querySelector('img'),null);
 form.elements.welcomeMessage.value='New message';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,15));
 assert.equal(saved.body.welcomeMessage,'New message');assert.equal(saved.body.channelId,channelId);assert.equal(saved.csrf,'csrf');
 w.close();
});

test('new endpoints retain Discord admin checks and CSRF',async t=>{
 const fx=fixture(), {get,write,req,session}=await setup(t,fx);
 for(const p of ['settings/verification','tickets','cases','music','leaderboard','hosting']) assert.equal((await req('/dashboard/api/bot/'+p)).status,401,p);
 assert.equal((await write('POST','music',{action:'pause',confirmed:true},{'x-csrf-token':'wrong'})).status,403);
 fx.member.permissions.has=()=>false;
 for(const p of ['welcome','settings/verification','tickets','cases','music','leaderboard','hosting']) assert.equal((await get(p)).status,403,p);
});
