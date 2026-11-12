import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {ChannelType,PermissionFlagsBits} from 'discord.js';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import {DEFAULT_AI_WELCOME,validateAIWelcome,welcomePrompt,safeGeneratedTemplate,deliverJoinWelcome} from '../src/services/ai/welcome.js';
import {createAIApi} from '../src/dashboard/aiApi.js';
const guildId='123456789012345678',userId='234567890123456789',botId='345678901234567890',channelId='456789012345678901',ownerId='567890123456789012';
const cfg={...DEFAULT_AI_WELCOME,enabled:true,channelId,toDm:true};
function fixture(){
 let channelSent=[],dmSent=[],calls=[],brokenDm=false,brokenChannel=false,permitted=true;
 const channel={id:channelId,name:'welcome',type:ChannelType.GuildText,isTextBased:()=>true,permissionsFor:()=>({has:p=>permitted}),send:async p=>{if(brokenChannel)throw Error('no channel');channelSent.push(p)}};
 const guild={id:guildId,name:'SecretGuildName',memberCount:12,channels:{cache:new Map([[channelId,channel]])},members:{me:{}}};
 const user={id:userId,username:'PrivateUser',tag:'PrivateUser',toString:()=>`<@${userId}>`,displayAvatarURL:()=> 'https://example.com/avatar.png'};
 const client={homeGuildId:guildId,user:{id:botId}};const member={guild,user,client,send:async p=>{if(brokenDm)throw Error('DM disabled');dmSent.push(p)}};
 const store={read:async()=>({...cfg})};const foundation={generate:async args=>{calls.push(args);return {text:'Halo {user}, selamat datang di {server}!'}}};
 return {guild,member,client,channelSent,dmSent,calls,store,foundation,setBrokenDm:v=>brokenDm=v,setBrokenChannel:v=>brokenChannel=v,setPermitted:v=>permitted=v};
}
test('AI welcome validates settings and blocks dangerous malformed generated templates',()=>{
 const f=fixture();assert.equal(DEFAULT_AI_WELCOME.enabled,false);assert.deepEqual(validateAIWelcome(cfg,f.guild),cfg);
 for(const patch of [{channelId:'bad'},{channelId:'999999999999999999'},{toChannel:false,toDm:false},{tone:'attack'},{language:'xx'},{fallback:''},{other:true}])assert.throws(()=>validateAIWelcome({...cfg,...patch},f.guild));
 assert.match(welcomePrompt(cfg),/{user}/);for(const text of ['No placeholders','{user} {server} https://bad.test','{user} {server} <@123>','{user} {server} {unknown}','{user} {server} @everyone'])assert.equal(safeGeneratedTemplate(text),null);
});
test('AI welcome sends generic prompt, fills names locally and does not duplicate legacy',async()=>{
 const f=fixture();const legacy={enabled:true,channelId,welcomeMessage:'Old legacy message',welcomeEmbed:{}};
 const result=await deliverJoinWelcome(f.member,legacy,{store:f.store,foundation:f.foundation});
 assert.equal(result.source,'ai');assert.equal(result.sent,2);assert.equal(f.channelSent.length,1);assert.equal(f.dmSent.length,1);
 assert.match(f.channelSent[0].content,/SecretGuildName/);assert.match(f.channelSent[0].content,new RegExp(userId));assert.deepEqual(f.channelSent[0].allowedMentions,{parse:[]});
 assert.equal(f.calls[0].userId,botId);assert.equal(f.calls[0].consent,true);assert.ok(!JSON.stringify(f.calls[0].prompt).includes(userId));assert.ok(!f.calls[0].prompt.includes('SecretGuildName'));assert.ok(!f.calls[0].prompt.includes('PrivateUser'));
});
test('fallback, failed DM, disabled mode, permissions and foreign guild',async()=>{
 const f=fixture();f.setBrokenDm(true);const bad={generate:async()=>{throw Error('unavailable')}};
 let r=await deliverJoinWelcome(f.member,{enabled:true,channelId,welcomeMessage:'Legacy'}, {store:f.store,foundation:bad});assert.equal(r.source,'fallback');assert.equal(r.sent,1);assert.equal(r.failed,1);assert.match(f.channelSent[0].content,/Selamat datang/);
 r=await deliverJoinWelcome(f.member,{enabled:true,channelId,welcomeMessage:'Legacy',welcomeEmbed:{}},{store:{read:async()=>({...DEFAULT_AI_WELCOME})},foundation:f.foundation});assert.equal(r.source,'legacy');assert.equal(f.channelSent.length,2);
 r=await deliverJoinWelcome(f.member,{enabled:true,channelId,welcomeMessage:'Legacy',welcomeEmbed:{}},{store:{read:async()=>{throw Error('offline')}},foundation:f.foundation});assert.equal(r.source,'legacy');
 f.setPermitted(false);r=await deliverJoinWelcome(f.member,{}, {store:{read:async()=>({...cfg,toDm:false})},foundation:f.foundation});assert.equal(r.source,'unavailable');assert.equal(f.calls.length,0);
 f.member.guild={...f.guild,id:'999999999999999999'};r=await deliverJoinWelcome(f.member,{}, {store:f.store,foundation:f.foundation});assert.equal(r.source,'blocked');
});
test('bad AI output falls back and channel failure does not stop DM',async()=>{
 const f=fixture();f.setBrokenChannel(true);const r=await deliverJoinWelcome(f.member,{}, {store:f.store,foundation:{generate:async()=>({text:'{user} {server} https://bad.example'})}});assert.equal(r.source,'fallback');assert.equal(r.sent,1);assert.equal(r.failed,1);assert.equal(f.dmSent.length,1);
});
test('welcome API only owner can read/save/preview, preview uses sample and fixed inputs',async t=>{
 const f=fixture();let saved;const welcomeStore={read:async()=>({...cfg}),save:async(g,s)=>{saved=s}};const foundation={store:{},credentials:()=>({}),generate:async args=>{f.calls.push(args);return {text:'Hello {user} to {server}!'}}};
 const app=express(),auth=(req,res,next)=>{if(req.get('auth')!=='yes')return res.sendStatus(401);req.session={user:{id:req.get('who')}};req.guild=f.guild;next()},csrf=(req,res,next)=>req.get('csrf')==='yes'?next():res.sendStatus(403);
 app.use('/ai',createAIApi(f.client,{auth,csrf,env:{OWNER_IDS:ownerId},foundation,welcomeStore}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const req=(path,method='GET',body,extra={})=>fetch(`http://127.0.0.1:${server.address().port}/ai${path}`,{method,headers:{auth:'yes',who:ownerId,csrf:'yes','content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await req('/welcome','GET',null,{who:userId})).status,403);assert.equal((await req('/welcome','GET',null,{auth:'no'})).status,401);assert.equal((await req('/welcome','PATCH',cfg,{csrf:'no'})).status,403);
 assert.equal((await req('/welcome','PATCH',{...cfg,channelId:'999999999999999999'})).status,400);assert.equal((await req('/welcome','PATCH',cfg)).status,200);assert.deepEqual(saved,cfg);
 assert.equal((await req('/welcome/preview','POST',{confirmed:true,prompt:'secret'})).status,400);const res=await req('/welcome/preview','POST',{confirmed:true});const data=await res.json();assert.equal(data.source,'ai');assert.match(data.preview,/Server Contoh/);assert.equal(f.channelSent.length,0);assert.equal(f.calls[0].userId,ownerId);assert.ok(!f.calls[0].prompt.includes('SecretGuildName'));
});
test('AI Welcome UI binds and renders response as text; goodbye remains simulation',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const dom=new JSDOM(html,{url:'http://localhost/dashboard/#ai/greeting',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.scrollTo=()=>{};w.confirm=()=>true;let saved;
 w.fetch=async(u,o={})=>({ok:true,json:async()=>{if(String(u).endsWith('/me'))return {user:{username:'Owner'},guild:{name:'Guild'},csrf:'csrf'};if(o.method==='PATCH'){saved=JSON.parse(o.body);return {ok:true}}if(o.method==='POST')return {source:'ai',preview:'<img src=x onerror=alert(1)>'};return {settings:cfg,channels:[{id:channelId,name:'welcome'}]}}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-welcome.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,35));const form=w.document.querySelector('#aiWelcomeForm');assert.ok(form);form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));assert.equal(saved.channelId,channelId);
 w.document.querySelector('#aiWelcomePreview').click();await new Promise(r=>setTimeout(r,10));assert.match(w.document.querySelector('#aiWelcomeResult').textContent,/<img/);assert.equal(w.document.querySelector('#aiWelcomeResult img'),null);
 w.document.querySelector('[data-ai-tab="goodbye"]').click();assert.match(w.document.querySelector('.f-demo-warning').textContent,/SIMULASI/);assert.equal(w.document.querySelector('#aiWelcomeForm'),null);
});

test('real join handler assigns autorole without waiting for AI network',async()=>{
 const {default:joinEvent}=await import('../src/events/guildMemberAdd.js');const f=fixture();const roleId='678901234567890123',role={id:roleId};f.guild.roles={cache:new Map([[roleId,role]])};let assigned=false,release;const wait=new Promise(r=>{release=r});
 f.member.roles={add:async r=>{assert.equal(r.id,roleId);assigned=true}};f.member.user.createdTimestamp=Date.now();
 f.client.guilds={cache:new Map([[guildId,f.guild]]),fetch:async()=>null};
 f.client.db={isAvailable:()=>true,getStatus:()=>({isDegraded:false}),get:async key=>key.includes('welcome')?{enabled:true,channelId,roleIds:[roleId]}:{},db:{isAvailable:()=>true,pool:{query:async()=>({rows:[{value:cfg}]})}}};
 f.client.aiFoundation={generate:async()=>{await wait;return {text:'Hi {user}, welcome to {server}'}}};
 const running=joinEvent.execute(f.member);try{await new Promise(r=>setTimeout(r,40));assert.equal(assigned,true);assert.equal(f.channelSent.length,0);}finally{release();await running;}
 assert.equal(f.channelSent.length,1);
});
