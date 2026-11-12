import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {JSDOM} from 'jsdom';import fs from 'node:fs';import {EventEmitter} from 'node:events';import {Readable} from 'node:stream';
import {research} from '../src/services/ai/research.js';import {publicUrl,publicAddresses,fetchPublicText,summarizeLink} from '../src/services/ai/linkSummary.js';import {createAIApi} from '../src/dashboard/aiApi.js';
const gid='123456789012345678',uid='234567890123456789',other='345678901234567890';
test('research requires consent, uses only snippets, and returns candidate sources',async()=>{
 let searched=0,prompt;const client={homeGuildId:gid},searchService={search:async()=>{searched++;return {results:[{title:'Source A',url:'https://example.com/a',description:'Example snippet'}]}}},foundation={generate:async x=>{prompt=x.prompt;return {text:'Tinjau [1]'}}};const args={client,guildId:gid,userId:uid,query:'Pertanyaan?',consent:true,searchService,foundation};
 await assert.rejects(research({...args,consent:false}),{status:403});assert.equal(searched,0);const r=await research(args);assert.match(prompt,/Example snippet/);assert.match(prompt,/tidak tepercaya/);assert.equal(r.sources[0].url,'https://example.com/a');
 await assert.rejects(research({...args,searchService:{search:async()=>({results:[]})}}),{status:404});
});
test('link reader rejects private, reserved, IP literal, port and mixed DNS before network',async()=>{
 for(const x of ['http://example.com','https://127.0.0.1','https://[::1]','https://name:pass@example.com','https://example.com:8443','https://example.local'])assert.throws(()=>publicUrl(x));
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','100.64.0.1','::1','fd00::1','::ffff:127.0.0.1'])assert.throws(()=>publicAddresses([{address:ip,family:ip.includes(':')?6:4}]));
 assert.throws(()=>publicAddresses([{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));let called=false;
 await assert.rejects(fetchPublicText('https://example.com',{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{called=true}}),{status:403});assert.equal(called,false);
});
test('link reader pins public DNS, rejects redirect, caps input, and strips scripts',async()=>{
 const lookup=async()=>[{address:'8.8.8.8',family:4}];let resolved;
 function requestFactory(status,body,headers={'content-type':'text/html'}){return (url,opts,cb)=>{opts.lookup('example.com',{},(_,address,family)=>{resolved=[address,family]});const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=Readable.from([Buffer.from(body)]);res.statusCode=status;res.headers=headers;cb(res)});return req;};}
 const r=await fetchPublicText('https://example.com/a',{lookup,request:requestFactory(200,'<head><title>hidden</title></head><p>teks benar</p><script>rahasia</script>')});assert.deepEqual(resolved,['8.8.8.8',4]);assert.match(r.text,/teks benar/);assert.doesNotMatch(r.text,/rahasia|hidden/);
 await assert.rejects(fetchPublicText('https://example.com/a',{lookup,request:requestFactory(302,'redirect')}),{status:502});await assert.rejects(fetchPublicText('https://example.com/a',{lookup,request:requestFactory(200,'x'.repeat(131073))}),{status:413});
});
test('link summary only processes confirmed excerpts, not raw URL credentials',async()=>{
 let calls=0;const args={client:{homeGuildId:gid},guildId:gid,userId:uid,url:'https://example.com/page',consent:true,fetchPage:async()=>{calls++;return {text:'Contoh isi',truncated:true}},foundation:{generate:async x=>({text:x.prompt})}};
 await assert.rejects(summarizeLink({...args,consent:false}),{status:403});assert.equal(calls,0);const r=await summarizeLink(args);assert.match(r.text,/Contoh isi/);assert.equal(r.truncated,true);
});
test('research endpoint requires owner, CSRF and confirmation',async t=>{
 const client={homeGuildId:gid},foundation={generate:async()=>({text:'hasil'})},searchService={search:async()=>({results:[{title:'src',description:'isi',url:'https://example.com'}]})};const auth=(req,res,next)=>{req.guild={id:gid};req.session={user:{id:req.get('who')}};next()},csrf=(req,res,next)=>req.get('csrf')==='yes'?next():res.sendStatus(403);const app=express();app.use('/ai',createAIApi(client,{auth,csrf,env:{OWNER_IDS:uid},foundation,searchService}));const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>s.close());
 const send=(who,token,confirmed)=>fetch(`http://127.0.0.1:${s.address().port}/ai/research`,{method:'POST',headers:{who,csrf:token,'content-type':'application/json'},body:JSON.stringify({query:'klaim',confirmed})});assert.equal((await send(other,'yes',true)).status,403);assert.equal((await send(uid,'no',true)).status,403);assert.equal((await send(uid,'yes',false)).status,400);assert.equal((await send(uid,'yes',true)).status,200);
});
test('research dashboard renders source links safely',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,''),d=new JSDOM(html,{url:'http://localhost/dashboard/#ai/tools',runScripts:'outside-only'}),w=d.window;t.after(()=>d.window.close());w.scrollTo=()=>{};w.confirm=()=>true;let path;
 w.fetch=async(u,o={})=>({ok:true,json:async()=>{if(String(u).endsWith('/me'))return {user:{username:'Owner'},guild:{name:'Guild'},csrf:'x'};path=String(u);return {text:'<img src=x>',sources:[{index:1,title:'<b>source</b>',url:'https://example.com/a'},{index:2,title:'bad',url:'javascript:alert(1)'}]}}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-welcome.js','ai-activities.js','ai-chat.js','ai-knowledge.js','ai-tools-live.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));await new Promise(r=>setTimeout(r,60));const f=w.document.querySelector('#aiToolsForm');f.elements.mode.value='link';f.elements.mode.dispatchEvent(new w.Event('change'));assert.match(w.document.querySelector('#aiToolsInputLabel').textContent,/URL/);f.elements.mode.value='research';f.elements.mode.dispatchEvent(new w.Event('change'));assert.match(w.document.querySelector('#aiToolsInputHelp').textContent,/300/);f.elements.text.value='klaim';f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,20));assert.ok(path.endsWith('/research'));assert.equal(w.document.querySelector('#aiToolsResult img'),null);assert.equal(w.document.querySelectorAll('#aiToolsSources a').length,1);assert.match(w.document.querySelector('#aiToolsSources a').textContent,/<b>/);
});

test('SSRF checks reject IPv4 mapped, translation, tunnel and DNS rebinding; lookup is pinned',async()=>{
 for(const ip of ['::ffff:10.0.0.1','::ffff:169.254.169.254','64:ff9b::a00:1','2002:7f00:1::','2001:0000::1','198.18.0.1','192.0.2.1'])assert.throws(()=>publicAddresses([{address:ip,family:ip.includes(':')?6:4}]));
 let resolutions=0;const lookup=async()=>{resolutions++;return [{address:'8.8.8.8',family:4}]};const request=(url,opts,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{opts.lookup('example.com',{all:true},(_,addresses)=>{assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);assert.equal(resolutions,1)});const res=Readable.from([Buffer.from('safe')]);res.statusCode=200;res.headers={'content-type':'text/plain'};cb(res)});return req};assert.equal((await fetchPublicText('https://example.com',{lookup,request})).text,'safe');assert.equal(resolutions,1);
});

test('link fetch releases capacity on interrupted response and limits concurrency',async()=>{
 let release;const blocked=new Promise(r=>release=r),lookup=()=>blocked;const a=fetchPublicText('https://example.com',{lookup}),b=fetchPublicText('https://example.com',{lookup});await assert.rejects(fetchPublicText('https://example.com',{lookup}),{status:429});release([{address:'127.0.0.1',family:4}]);await Promise.all([assert.rejects(a,{status:403}),assert.rejects(b,{status:403})]);
 const request=(url,opts,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/plain'};res.destroy=()=>{};cb(res);res.emit('aborted')});return req};await assert.rejects(fetchPublicText('https://example.com',{lookup:async()=>[{address:'8.8.8.8',family:4}],request}),{status:502});
});

test('link fetch times out without waiting indefinitely',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const request=()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{};return req};const pending=fetchPublicText('https://example.com',{lookup:async()=>[{address:'8.8.8.8',family:4}],request});await Promise.resolve();await Promise.resolve();await Promise.resolve();t.mock.timers.tick(10000);await assert.rejects(pending,{status:504});
});
