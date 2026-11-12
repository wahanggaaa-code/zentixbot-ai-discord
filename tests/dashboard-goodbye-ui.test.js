import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');
const scripts=['session.js','live.js','goodbye-live.js','modules-live.js','operations-live.js','features.js','ai-studio.js','app.js'];
const delay=()=>new Promise(r=>setTimeout(r,35));
const channelId='234567890123456789';
function setup(t,url){const dom=new JSDOM(html,{url,runScripts:'outside-only'}),w=dom.window;w.scrollTo=()=>{};w.confirm=()=>true;t.after(()=>w.close());return w;}

test('authenticated goodbye page loads, escapes text, previews locally and submits CSRF-protected data',async t=>{
 const w=setup(t,'http://localhost/dashboard/#features/welcome');let request,fail=false;
 w.fetch=async (url,opts={})=>{
  if(String(url).endsWith('/me'))return {ok:true,json:async()=>({user:{username:'Tester'},guild:{name:'Server'},csrf:'csrf-value'})};
  if(String(url).endsWith('/welcome'))return {ok:true,json:async()=>({welcome:{welcomeMessage:'hello',welcomeEmbed:{},roleIds:[]},channels:[],roles:[],verificationActive:false})};
  if(String(url).endsWith('/goodbye')&&opts.method==='PATCH'){request=opts;return fail?{ok:false,json:async()=>({error:'Pengaturan berubah. Muat ulang sebelum menyimpan.'})}:{ok:true,json:async()=>({revision:'b'.repeat(64)})};}
  if(String(url).endsWith('/goodbye'))return {ok:true,json:async()=>({revision:'a'.repeat(64),goodbye:{enabled:false,channelId,message:'Farewell {username}',ping:false,image:'https://example.test/pixel.png',title:'<img src=x onerror=alert(1)>',footer:'See {server}',color:42},channels:[{id:channelId,name:'<img src=x>'}]})};
  return {ok:true,json:async()=>({})};
 };
 scripts.forEach(x=>w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8')));await delay();
 w.document.querySelector('[data-tab="goodbye"]').click();await delay();
 const form=w.document.querySelector('#goodbyeForm');assert.ok(form);assert.equal(w.document.querySelector('#liveGoodbye img'),null);assert.equal(w.document.querySelector('#goodbyePreviewBox img'),null);
 assert.match(w.document.querySelector('#goodbyePreviewTitle').textContent,/<img/);assert.match(w.document.querySelector('#goodbyePreviewMessage').textContent,/anggota-contoh/);
 form.elements.enabled.checked=true;form.elements.message.value='Bye {user}';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await delay();
 assert.equal(request.headers['x-csrf-token'],'csrf-value');const sent=JSON.parse(request.body);assert.equal(sent.revision,'a'.repeat(64));assert.equal(sent.message,'Bye {user}');assert.equal(sent.channelId,channelId);
 fail=true;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await delay();assert.equal(JSON.parse(request.body).revision,'b'.repeat(64));assert.match(w.document.querySelector('#goodbyeError').textContent,/Muat ulang/);assert.equal(form.elements.message.value,'Bye {user}');
});

test('static preview goodbye remains a simulation and makes no API requests',async t=>{
 const w=setup(t,'http://localhost/preview/#features/welcome');let calls=0;w.fetch=async()=>{calls++;throw Error('unexpected request')};
 scripts.forEach(x=>w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8')));await delay();w.document.querySelector('[data-tab="goodbye"]').click();await delay();
 const form=w.document.querySelector('[data-form="goodbye"]');assert.ok(form);assert.match(w.document.querySelector('.f-demo-warning').textContent,/SIMULASI|CONTOH/);
 form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));assert.match(w.document.querySelector('#toast').textContent,/Simulasi/);assert.equal(calls,0);
});
