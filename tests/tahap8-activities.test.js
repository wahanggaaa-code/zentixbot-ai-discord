import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {ChannelType} from 'discord.js';
import {DEFAULT_ACTIVITY,validateActivity,validateQuiz,quizPayload,createActivityStore,startActivity} from '../src/services/ai/activities.js';
import {createAIApi} from '../src/dashboard/aiApi.js';
const gid='123456789012345678',owner='234567890123456789',other='345678901234567890',channelId='456789012345678901',msg='567890123456789012';
const cfg={...DEFAULT_ACTIVITY,enabled:true,channelId,duration:60};
const quiz={question:'Planet merah?',options:['Venus','Mars','Bumi','Jupiter'],answer:1};
function fixture(){let sent=[];const channel={id:channelId,name:'quiz',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),send:async p=>{sent.push(p);return {id:msg,edit:async()=>{}}}};const guild={id:gid,channels:{cache:new Map([[channelId,channel]])},members:{me:{}}};return {client:{homeGuildId:gid},guild,sent};}
function memoryDb(){let values=new Map();const query=async(sql,args=[])=>{if(sql.startsWith('INSERT INTO')){if(!values.has(args[0]))values.set(args[0],args[1]?JSON.parse(args[1]):{});else if(sql.includes('DO UPDATE'))values.set(args[0],JSON.parse(args[1]));return {rows:[]}}if(sql.startsWith('SELECT value'))return {rows:values.has(args[0])?[{value:structuredClone(values.get(args[0]))}]:[]};if(sql.startsWith('UPDATE'))values.set(args[0],JSON.parse(args[1]));return {rows:[]}};const pool={query,connect:async()=>({query,release(){}})};return {getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool},values};}
test('activity validates settings, questions and avoids leaking answers in buttons',()=>{
 const f=fixture();assert.equal(DEFAULT_ACTIVITY.enabled,false);assert.deepEqual(validateActivity(cfg,f.guild),cfg);
 for(const p of [{duration:1},{channelId:null},{language:'xx'},{enabled:'true'},{channelId:'999999999999999999'}])assert.throws(()=>validateActivity({...cfg,...p},f.guild));
 assert.deepEqual(validateQuiz(quiz),quiz);for(const x of [{...quiz,answer:4},{...quiz,options:['a','a','b','c']},{...quiz,question:'<@123> spam'},{...quiz,question:'https://bad.test'}])assert.equal(validateQuiz(x),null);
 const payload=quizPayload(quiz,'abcdabcdabcdabcdabcd');assert.doesNotMatch(JSON.stringify(payload),/"answer"/);assert.equal(payload.components[0].components.length,4);
});
test('round reserves and uses generic AI prompt; first correct answer closes it',async()=>{
 const f=fixture();f.client.db=memoryDb();const store=createActivityStore(f.client);await store.save(gid,cfg);let prompt;
 const result=await startActivity({client:f.client,guild:f.guild,actorId:owner,store,foundation:{generate:async x=>{prompt=x.prompt;return {text:JSON.stringify(quiz)}}}});
 assert.equal(result.source,'ai');assert.equal(f.sent.length,1);assert.ok(!prompt.includes(gid));const id=f.sent[0].components[0].components[0].data.custom_id.split(':')[1];
 assert.equal((await store.answer(gid,id,msg,owner,0,Date.now())).status,'wrong');assert.equal((await store.answer(gid,id,msg,owner,1,Date.now())).status,'answered');assert.equal((await store.answer(gid,id,msg,other,1,Date.now())).status,'correct');assert.equal((await store.answer(gid,id,msg,'678901234567890123',1,Date.now())).status,'closed');
 assert.match(JSON.stringify(quizPayload(quiz,id,{ended:'Selesai.'})),/Mars/);
});
test('duplicate round is blocked, invalid output falls back and DB errors fail closed',async()=>{
 const f=fixture();f.client.db=memoryDb();const store=createActivityStore(f.client);await store.save(gid,cfg);const foundation={generate:async()=>({text:'not json'})};
 assert.equal((await startActivity({client:f.client,guild:f.guild,actorId:owner,store,foundation})).source,'fallback');
 await assert.rejects(startActivity({client:f.client,guild:f.guild,actorId:owner,store,foundation}),{status:409});assert.equal(f.sent.length,1);
 await assert.rejects(createActivityStore({db:{getStatus:()=>({isDegraded:true})}}).read(gid),{status:503});
});
test('activity API requires owner, csrf and confirmation',async t=>{
 const f=fixture();let stored={...cfg},started=0;const activityStore={read:async()=>stored,save:async(_,v)=>{stored=v},reserve:async()=>{started++},open:async()=>{},attach:async()=>{},cancel:async()=>{},expire:async()=>null};const foundation={generate:async()=>({text:JSON.stringify(quiz)})};
 const auth=(req,res,next)=>{if(req.get('auth')!=='yes')return res.sendStatus(401);req.session={user:{id:req.get('who')}};req.guild=f.guild;next()},csrf=(req,res,next)=>req.get('csrf')==='yes'?next():res.sendStatus(403);
 const app=express();app.use('/ai',createAIApi(f.client,{auth,csrf,env:{OWNER_IDS:owner},foundation,activityStore}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const req=(p,method='GET',body,extra={})=>fetch(`http://127.0.0.1:${server.address().port}/ai${p}`,{method,headers:{auth:'yes',who:owner,csrf:'yes','content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await req('/activities','GET',null,{who:other})).status,403);assert.equal((await req('/activities','PATCH',cfg,{csrf:'no'})).status,403);assert.equal((await req('/activities','PATCH',cfg)).status,200);assert.equal((await req('/activities/start','POST',{confirmed:false})).status,400);assert.equal(started,0);const r=await req('/activities/start','POST',{confirmed:true});assert.equal(r.status,200);const body=await r.json();assert.equal(body.source,'ai');assert.ok(!JSON.stringify(body).includes('answer'));assert.equal(started,1);
});
test('activity UI connects and remaining preview is explicitly simulation',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const dom=new JSDOM(html,{url:'http://localhost/dashboard/#ai/activities',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.scrollTo=()=>{};w.confirm=()=>true;let saved,started=false;
 w.fetch=async(u,o={})=>({ok:true,json:async()=>{if(String(u).endsWith('/me'))return {user:{username:'Owner'},guild:{name:'Guild'},csrf:'x'};if(o.method==='PATCH'){saved=JSON.parse(o.body);return {ok:true}}if(o.method==='POST'){started=true;return {source:'ai'}}return {settings:cfg,channels:[{id:channelId,name:'quiz'}]}}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-welcome.js','ai-activities.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,40));const form=w.document.querySelector('#aiActivityForm');assert.ok(form);form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));assert.equal(saved.channelId,channelId);w.document.querySelector('#aiActivityStart').click();await new Promise(r=>setTimeout(r,10));assert.equal(started,true);w.document.querySelector('[data-ai-tab="preview"]').click();assert.match(w.document.querySelector('.f-demo-warning').textContent,/SIMULASI/);
});

test('quiz Discord handler records answer for matching message and guards foreign guild',async()=>{
 const {default:handler}=await import('../src/interactions/buttons/ai/quiz.js');const f=fixture();f.client.db=memoryDb();const store=createActivityStore(f.client);await store.save(gid,cfg);await startActivity({client:f.client,guild:f.guild,actorId:owner,store,foundation:{generate:async()=>({text:JSON.stringify(quiz)})}});
 const id=f.sent[0].components[0].components[0].data.custom_id.split(':')[1];let answer,edited=0;
 const interaction={guildId:gid,guild:f.guild,user:{id:owner,bot:false},message:{id:msg,edit:async()=>{edited++}},deferReply:async()=>{},editReply:async x=>{answer=x},reply:async x=>{answer=x}};
 await handler.execute(interaction,f.client,[id,'1']);assert.match(answer.content,/Benar/);assert.equal(edited,1);
 await handler.execute({...interaction,guildId:other},f.client,[id,'1']);assert.match(answer.content,/tidak valid/);
});

test('scheduled activities respect weekday, Indonesian time zones and claim once',async()=>{
 const {scheduleMatches,runScheduledActivity}=await import('../src/services/ai/activities.js');const f=fixture();f.client.guilds={cache:new Map([[gid,f.guild]])};f.client.user={id:owner};
 const time=new Date('2026-11-12T11:00:00Z');const scheduled={...cfg,scheduleEnabled:true,scheduleTime:'18:00',scheduleDays:'weekdays',timeZone:'WIB',kind:'emoji'};
 assert.equal(scheduleMatches(scheduled,time),'2026-11-12');assert.equal(scheduleMatches({...scheduled,timeZone:'WITA'},time),null);assert.equal(scheduleMatches({...scheduled,scheduleDays:'weekend'},time),null);
 let claimed=false,started=0;const store={read:async()=>scheduled,claimSchedule:async(_,day)=>{if(claimed)return false;assert.equal(day,'2026-11-12');claimed=true;return true}};const start=async()=>{started++};
 assert.equal(await runScheduledActivity(f.client,{store,now:time,start}),true);assert.equal(await runScheduledActivity(f.client,{store,now:time,start}),false);assert.equal(started,1);
});

test('scheduled activity claim is persisted with a lock',async()=>{
 const f=fixture();f.client.db=memoryDb();const store=createActivityStore(f.client);assert.equal(await store.claimSchedule(gid,'2026-11-12'),true);assert.equal(await store.claimSchedule(gid,'2026-11-12'),false);assert.equal(await store.claimSchedule(gid,'2026-11-13'),true);
});
