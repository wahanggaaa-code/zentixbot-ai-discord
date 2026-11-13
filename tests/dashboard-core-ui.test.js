import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');
const scripts=['session.js','live.js','goodbye-live.js','birthday-live.js','core-live.js','modules-live.js','operations-live.js','features.js','ai-studio.js','app.js'];
const delay=()=>new Promise(r=>setTimeout(r,50));
function setup(t,url){const dom=new JSDOM(html,{url,runScripts:'outside-only'});dom.window.scrollTo=()=>{};t.after(()=>dom.window.close());return dom.window}
test('core UI escapes data, filters, confirms and sends CSRF, then reloads',async t=>{
 const w=setup(t,'http://localhost/dashboard/#features/core');let sent=[],reads=0,confirmed=false,stale=false;w.confirm=()=>confirmed;
 const data={revision:'missing',categories:[{key:'core',name:'Core <img src=x>',disabled:false,commands:[{name:'commands disable',description:'<img src=x>',enabled:true,protected:true,ownDisabled:false},{name:'ping',description:'Ping',enabled:true,protected:false,ownDisabled:false}]}]};
 w.fetch=async(url,opts={})=>{url=String(url);if(url.endsWith('/me'))return {ok:true,json:async()=>({user:{username:'Tester'},guild:{name:'Server'},csrf:'csrf'})};if(url.endsWith('/core/commands')){if(opts.method==='PATCH'){sent.push(opts);return stale?{ok:false,json:async()=>({error:'Muat ulang'})}:{ok:true,json:async()=>({ok:true})}}reads++;return {ok:true,json:async()=>data}}return {ok:true,json:async()=>({})}};
 scripts.forEach(x=>w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8')));await delay();assert.ok(w.document.querySelector('#coreLive'));assert.equal(w.document.querySelector('#coreLive img'),null);assert.equal(w.document.querySelectorAll('[data-kind="command"]').length,1);
 let search=w.document.querySelector('#coreSearch');search.value='ping';search.dispatchEvent(new w.Event('input'));assert.equal(w.document.querySelector('[data-command-row="0"]').hidden,true);let button=w.document.querySelector('[data-kind="command"]');button.click();await delay();assert.equal(sent.length,0);confirmed=true;stale=true;button.click();await delay();assert.equal(sent[0].headers['x-csrf-token'],'csrf');assert.deepEqual(JSON.parse(sent[0].body),{kind:'command',target:'ping',disabled:true,revision:'missing',confirmed:true});assert.match(w.document.querySelector('#coreError').textContent,/Muat ulang/);stale=false;w.document.querySelector('#coreReload').click();await delay();w.document.querySelector('[data-kind="category"]').click();await delay();assert.equal(JSON.parse(sent.at(-1).body).kind,'category');assert.ok(reads>=3);
});
test('core static preview does not fetch or expose live controls',async t=>{const w=setup(t,'http://localhost/preview/#features/core');let calls=0;w.fetch=async()=>{calls++;throw Error('unexpected')};scripts.forEach(x=>w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8')));await delay();assert.match(w.document.querySelector('.f-demo-warning').textContent,/SIMULASI|CONTOH/);assert.match(w.document.body.textContent,/tidak terhubung ke bot/i);assert.equal(w.document.querySelector('#coreLive'),null);assert.equal(calls,0)});
