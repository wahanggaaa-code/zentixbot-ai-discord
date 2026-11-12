import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {JSDOM} from 'jsdom';import fs from 'node:fs';
import {validateDocument,selectExcerpts,askKnowledge} from '../src/services/ai/knowledge.js';import {createAIApi} from '../src/dashboard/aiApi.js';
const guild='123456789012345678',owner='234567890123456789',other='345678901234567890';const doc={id:'abcdef123456abcdef123456',name:'aturan.md',content:'Aturan komunitas: hormati anggota dan dilarang spam.',createdAt:'2026-11-12'};
test('document validation and retrieval avoid unsupported file types and irrelevant excerpts',()=>{
 assert.equal(validateDocument('aturan.md',doc.content).name,'aturan.md');for(const x of [['x.pdf','secret'],['x.txt',''],['x.md','a'.repeat(12001)],['x.txt','a\0b']])assert.throws(()=>validateDocument(...x));
 assert.equal(selectExcerpts([doc],'aturan komunitas').length,1);assert.equal(selectExcerpts([doc],'astronomi planet').length,0);
});
test('knowledge sends selected excerpt only with explicit consent',async()=>{
 let sent;const client={homeGuildId:guild},store={read:async()=>[doc]},foundation={generate:async x=>{sent=x;return {text:'[1] Hormati anggota.',usedFallback:false}}};const q={client,guildId:guild,userId:owner,question:'Apa aturan komunitas?',consent:true,store,foundation};
 await assert.rejects(askKnowledge({...q,consent:false}),{status:403});assert.equal(sent,undefined);const result=await askKnowledge(q);assert.match(sent.prompt,/hormati anggota/);assert.equal(result.sources[0].name,'aturan.md');await assert.rejects(askKnowledge({...q,question:'astronomi planet'}),{status:404});
});
test('knowledge API owner and CSRF gates uploads, deletion and queries',async t=>{
 let docs=[doc],count=0;const knowledgeStore={read:async()=>docs,add:async(g,name,content)=>{count++;return {id:doc.id,name}},remove:async()=>{count++;docs=[]}},foundation={generate:async()=>{count++;return {text:'jawaban'}}};const client={homeGuildId:guild};
 const auth=(req,res,next)=>{if(req.get('auth')!=='yes')return res.sendStatus(401);req.session={user:{id:req.get('who')}};req.guild={id:guild};next()},csrf=(req,res,next)=>req.get('csrf')==='yes'?next():res.sendStatus(403);
 const app=express();app.use('/ai',createAIApi(client,{auth,csrf,env:{OWNER_IDS:owner},foundation,knowledgeStore}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const req=(p,method='GET',body,extra={})=>fetch(`http://127.0.0.1:${server.address().port}/ai${p}`,{method,headers:{auth:'yes',who:owner,csrf:'yes','content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await req('/knowledge','GET',null,{who:other})).status,403);const list=await (await req('/knowledge')).json();assert.ok(!JSON.stringify(list).includes(doc.content));
 assert.equal((await req('/knowledge','POST',{name:'x.md',content:'text',confirmed:true},{csrf:'no'})).status,403);assert.equal((await req('/knowledge/ask','POST',{question:'aturan komunitas',confirmed:false})).status,400);assert.equal(count,0);
 assert.equal((await req('/knowledge/ask','POST',{question:'aturan komunitas',confirmed:true})).status,200);assert.equal((await req('/knowledge/'+doc.id,'DELETE',{confirmed:true})).status,200);assert.equal(count,2);
});
test('knowledge UI safely renders document names and AI response',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const dom=new JSDOM(html,{url:'http://localhost/dashboard/#ai/knowledge',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.scrollTo=()=>{};w.confirm=()=>true;
 w.fetch=async(u,o={})=>({ok:true,json:async()=>String(u).endsWith('/me')?{user:{username:'Owner'},guild:{name:'Guild'},csrf:'x'}:o.method==='POST'?{text:'<img src=x>',sources:[{index:1,name:'x.md'}]}:{documents:[{...doc,name:'<img src=x>',characters:10}]}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-welcome.js','ai-activities.js','ai-chat.js','ai-knowledge.js','ai-tools-live.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,35));assert.equal(w.document.querySelector('#knowledgeList img'),null);w.document.querySelector('[data-ai-tab="test"]').click();const f=w.document.querySelector('#knowledgeAsk');f.elements.question.value='aturan';f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,15));assert.match(w.document.querySelector('#knowledgeAnswer').textContent,/<img/);assert.equal(w.document.querySelector('#knowledgeAnswer img'),null);
});

test('knowledge documents use row-locked persistence and support deletion',async()=>{
 const {createKnowledgeStore}=await import('../src/services/ai/knowledge.js');const values=new Map(),commands=[];
 const q=async(sql,args=[])=>{commands.push(sql);if(sql.startsWith('INSERT INTO')){if(!values.has(args[0]))values.set(args[0],[]);return {rows:[]}}if(sql.startsWith('SELECT value'))return {rows:values.has(args[0])?[{value:structuredClone(values.get(args[0]))}]:[]};if(sql.startsWith('UPDATE'))values.set(args[0],JSON.parse(args[1]));return {rows:[]}};
 const pool={query:q,connect:async()=>({query:q,release(){}})},client={db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool}}};const store=createKnowledgeStore(client);
 const entry=await store.add(guild,'rules.txt','Important rules');assert.equal((await store.read(guild)).length,1);assert.ok(commands.some(x=>x.includes('FOR UPDATE')));await store.remove(guild,entry.id);assert.equal((await store.read(guild)).length,0);await assert.rejects(store.remove(guild,entry.id),{status:404});
});
