import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { DEFAULT_AI, PROVIDERS, validateSettings, createAIFoundation, createAIStore } from '../src/services/ai/foundation.js';
import { createAIApi } from '../src/dashboard/aiApi.js';
const guild='123456789012345678',user='234567890123456789',other='345678901234567890';
const settings={...DEFAULT_AI,enabled:true,providerDataConsent:true,primaryModel:'model-main',backup:'gemini',backupModel:'model-backup',perUserDaily:2,guildDaily:3};
const env={AI_GROQ_API_KEY:'secret-main',AI_GEMINI_API_KEY:'secret-backup'};
function store(){let cfg={...settings},count=0;return {get count(){return count},read:async()=>({...cfg}),save:async(id,v)=>{cfg={...v}},reserve:async()=>{if(count>=cfg.guildDaily)throw Object.assign(Error('limit'),{status:429,code:'LIMIT_REACHED'});count++;return {day:'2026-11-12',guild:count,user:count}}}}
const good=message=>new Response(JSON.stringify({choices:[{message:{content:message},finish_reason:'stop'}]}),{status:200});
const client={homeGuildId:guild};
test('AI settings validation defaults closed and strict',()=>{
 assert.equal(DEFAULT_AI.enabled,false);assert.equal(validateSettings({...settings}).primaryModel,'model-main');
 for(const bad of [{providerDataConsent:false},{primary:'evil'},{backup:'groq'},{primaryModel:'http://evil?x=1'},{perUserDaily:4,guildDaily:3},{timeoutSeconds:0},{maxOutputTokens:4096},{unrecognized:true}])assert.throws(()=>validateSettings({...settings,...bad}));
});
test('provider fallback uses fixed HTTPS endpoints; limits, privacy and errors fail closed',async()=>{
 const s=store(),calls=[];const f=createAIFoundation({client,store:s,env,fetchImpl:async(url,opts)=>{calls.push({url,opts});return calls.length===1?new Response('',{status:429}):good('OK')}});
 await assert.rejects(f.generate({guildId:other,userId:user,prompt:'hello',consent:true}),{code:'FORBIDDEN'});
 await assert.rejects(f.generate({guildId:guild,userId:user,prompt:'hello'}),{code:'CONSENT_REQUIRED'});
 assert.equal(s.count,0);const r=await f.generate({guildId:guild,userId:user,prompt:'hello',consent:true});
 assert.equal(r.provider,'gemini');assert.equal(r.usedFallback,true);assert.equal(s.count,1);assert.equal(calls[0].url,PROVIDERS.groq.url);assert.equal(calls[1].url,PROVIDERS.gemini.url);assert.equal(calls[1].opts.redirect,'error');assert.equal(JSON.parse(calls[0].opts.body).max_tokens,256);assert.equal(JSON.parse(calls[0].opts.body).messages[0].content,'hello');
 assert.equal(JSON.stringify(f.credentials()).includes('secret'),false);
 const blocked=createAIFoundation({client,store:store(),env,fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:''},finish_reason:'content_filter'}]}))});await assert.rejects(blocked.generate({guildId:guild,userId:user,prompt:'hi',consent:true}),{code:'FILTERED'});
 const rejected=createAIFoundation({client,store:store(),env,fetchImpl:async()=>new Response('sensitive provider body',{status:400})});await assert.rejects(rejected.generate({guildId:guild,userId:user,prompt:'hi',consent:true}),e=>e.code==='REQUEST_REJECTED'&&!e.message.includes('sensitive'));
 const none=store(),n=createAIFoundation({client,store:none,env:{},fetchImpl:()=>{throw Error('should not call')}});await assert.rejects(n.generate({guildId:guild,userId:user,prompt:'hi',consent:true}),{code:'NO_CREDENTIALS'});assert.equal(none.count,0);
 const failed=store(),fail=createAIFoundation({client,store:failed,env,fetchImpl:async()=>{throw Error('secret detail')}});await assert.rejects(fail.generate({guildId:guild,userId:user,prompt:'hi',consent:true}),{code:'PROVIDERS_UNAVAILABLE'});assert.equal(failed.count,1);
});
test('quota storage uses transaction locks and rejects at limit',async()=>{
 const values=new Map();const commands=[];const q=async(sql,args=[])=>{commands.push(sql);if(sql.startsWith('SELECT to_char'))return {rows:[{day:'2026-11-12'}]};if(sql.startsWith('INSERT INTO cache_data')){if(!values.has(args[0]))values.set(args[0],JSON.parse(args[1]));return {rows:[]}}if(sql.startsWith('SELECT value'))return {rows:values.has(args[0])?[{value:values.get(args[0])}]:[]};if(sql.startsWith('UPDATE cache_data'))values.set(args[0],JSON.parse(args[1]));return {rows:[]}};
 const pool={connect:async()=>({query:q,release(){}}),query:q};const db={getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool}};const s=createAIStore({db});
 await s.reserve(guild,user,settings);await s.reserve(guild,user,settings);await assert.rejects(s.reserve(guild,user,settings),{code:'LIMIT_REACHED'});
 assert.equal([...values.values()].every(v=>v.count===2),true);assert.ok(commands.some(x=>x.includes('FOR UPDATE')));assert.equal(commands.at(-1),'ROLLBACK');
 await assert.rejects(createAIStore({db:{getStatus:()=>({isDegraded:true})}}).read(guild),{code:'STORAGE_UNAVAILABLE'});
});
test('AI dashboard is owner-only, CSRF protected and uses fixed test prompt',async t=>{
 let count=0;const s=store();const f=createAIFoundation({client,store:s,env,fetchImpl:async(url,o)=>{count++;assert.match(JSON.parse(o.body).messages[0].content,/Koneksi AI/);return good('<hello>')}});
 const app=express(),auth=(req,res,next)=>{if(req.get('auth')!=='yes')return res.sendStatus(401);req.session={user:{id:req.get('who')}};req.guild={id:guild};next()},csrf=(req,res,next)=>req.get('csrf')==='yes'?next():res.sendStatus(403);
 app.use('/ai',createAIApi(client,{auth,csrf,env:{OWNER_IDS:user},foundation:f}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const req=(path,method='GET',body,headers={})=>fetch(`http://127.0.0.1:${server.address().port}/ai${path}`,{method,headers:{auth:'yes',who:user,csrf:'yes','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await req('/settings','GET',null,{who:other})).status,403);assert.equal((await req('/settings','GET',null,{auth:'no'})).status,401);
 assert.equal((await req('/settings','PATCH',settings,{csrf:'no'})).status,403);assert.equal((await req('/settings','PATCH',settings)).status,200);
 assert.equal((await req('/test','POST',{confirmed:true,prompt:'private'})).status,400);assert.equal((await req('/test','POST',{confirmed:true},{who:other})).status,403);assert.equal(count,0);
 const resp=await req('/test','POST',{confirmed:true});assert.equal(resp.status,200);assert.equal((await resp.json()).text,'<hello>');assert.equal(count,1);
 const get=JSON.stringify(await (await req('/settings')).json());assert.ok(!get.includes('secret-main'));
});
test('AI provider page binds to settings and test safely renders provider text',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const d=new JSDOM(html,{url:'http://localhost/dashboard/#ai/providers',runScripts:'outside-only'}),w=d.window;t.after(()=>w.close());w.scrollTo=()=>{};w.confirm=()=>true;let posted;
 w.fetch=async(url,opts={})=>({ok:true,json:async()=>{if(String(url).endsWith('/me'))return {user:{username:'Owner'},guild:{name:'Guild'},csrf:'test'};if(opts.method==='POST')return {provider:'groq',model:'m',text:'<img src=x onerror=alert(1)>',usedFallback:false};if(opts.method==='PATCH'){posted=JSON.parse(opts.body);return {ok:true}}return {settings,credentials:{groq:true,gemini:true}}}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,40));const form=w.document.querySelector('#aiRealForm');assert.ok(form);form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));assert.equal(posted.primary,'groq');w.document.querySelector('#aiTest').click();await new Promise(r=>setTimeout(r,10));assert.match(w.document.querySelector('#aiTestResult').textContent,/<img/);assert.equal(w.document.querySelector('#aiTestResult img'),null);
});

test('disabled AI, quota exhaustion and concurrency stop requests before provider',async()=>{
 const s=store();await s.save(guild,{...settings,enabled:false});let calls=0;const f=createAIFoundation({client,store:s,env,fetchImpl:async()=>{calls++;return good('ok')}});
 await assert.rejects(f.generate({guildId:guild,userId:user,prompt:'hi',consent:true}),{code:'DISABLED'});assert.equal(calls,0);assert.equal(s.count,0);
 await s.save(guild,{...settings,guildDaily:3});for(let i=0;i<3;i++)await f.generate({guildId:guild,userId:user,prompt:'hi',consent:true});await assert.rejects(f.generate({guildId:guild,userId:user,prompt:'hi',consent:true}),{code:'LIMIT_REACHED'});assert.equal(calls,3);
 let release;const waiting=new Promise(r=>{release=r});const busy=createAIFoundation({client,store:{read:async()=>settings,reserve:async()=>({})},env,fetchImpl:async()=>{await waiting;return good('ok')}});const request=()=>busy.generate({guildId:guild,userId:user,prompt:'hi',consent:true});const pending=[request(),request(),request(),request()];await assert.rejects(request(),{code:'BUSY'});release();await Promise.all(pending);
});
