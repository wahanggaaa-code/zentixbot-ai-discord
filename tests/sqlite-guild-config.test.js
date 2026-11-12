import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {openSQLiteStore} from '../src/services/storage/sqlite.js';import {createSQLiteBotDatabase} from '../src/services/storage/sqliteBotDatabase.js';import {getGuildConfig,setGuildConfig,updateGuildConfig,patchGuildConfig,transferGuildConfigSnapshot} from '../src/services/config/guildConfig.js';
const g='123456789012345678',u='234567890123456789';
function file(t){const dir=mkdtempSync(join(tmpdir(),'zentix-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'db.sqlite')}
function client(sqlite){const adapter=createSQLiteBotDatabase(sqlite);return {homeGuildId:g,db:{isAvailable:()=>true,getStatus:()=>({isDegraded:false}),db:adapter}}}
test('stale full writes cannot overwrite a newer atomic update; copies require explicit snapshot',async t=>{
 const sqlite=await openSQLiteStore({path:file(t)}),c=client(sqlite);const first=await getGuildConfig(c,g),stale=await getGuildConfig(c,g);first.premiumRoleId=u;await setGuildConfig(c,g,first);stale.prefix='?';await assert.rejects(setGuildConfig(c,g,stale),e=>e.userMessage?.includes('changed'));assert.equal((await getGuildConfig(c,g)).premiumRoleId,u);
 const current=await getGuildConfig(c,g),clone={...current,prefix:'?'};await assert.rejects(setGuildConfig(c,g,clone),e=>e.userMessage?.includes('Reload'));await setGuildConfig(c,g,transferGuildConfigSnapshot(current,clone));assert.equal((await getGuildConfig(c,g)).prefix,'?');await assert.rejects(c.db.db.set(`guild:${g}:config`,{}),{code:'CONFIG_WRITE_DISABLED'});await assert.rejects(c.db.db.delete(`guild:${g}:config`),{code:'CONFIG_WRITE_DISABLED'});sqlite.close();
});
test('atomic patches preserve separate settings and reject conflicting welcome/verification changes',async t=>{
 const sqlite=await openSQLiteStore({path:file(t)}),c=client(sqlite);await Promise.all([updateGuildConfig(c,g,{premiumRoleId:u}),patchGuildConfig(c,g,{logging:{enabled:true}})]);let cfg=await getGuildConfig(c,g);assert.equal(cfg.premiumRoleId,u);assert.equal(cfg.logging.enabled,true);
 sqlite.transaction(tx=>tx.botSet(`guild:${g}:welcome`,{roleIds:[u]}));await assert.rejects(patchGuildConfig(c,g,{verification:{enabled:true}}),e=>e.userMessage?.includes('conflicting'));cfg=await getGuildConfig(c,g);assert.equal(cfg.verification.enabled,false);
 await assert.rejects(updateGuildConfig({...c,homeGuildId:u},g,{prefix:'!'}));sqlite.close();
});
test('independent processes serialize partial guild config writes',async t=>{
 const path=file(t),sqlite=await openSQLiteStore({path,busyTimeout:5000});const workers=Array.from({length:4},(_,i)=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['tests/fixtures/sqlite-config-worker.js',path,g,`parallel${i}`],{stdio:['ignore','ignore','pipe']});let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(`worker ${code}: ${err}`)))}));await Promise.all(workers);const cfg=await getGuildConfig(client(sqlite),g);for(let i=0;i<4;i++)assert.equal(cfg[`parallel${i}`],29);sqlite.close();
});
test('ConfigService copied payloads retain their original SQLite snapshot',async t=>{
 const sqlite=await openSQLiteStore({path:file(t)}),c=client(sqlite),{default:ConfigService}=await import('../src/services/config/configService.js');c.guilds={cache:new Map([[g,{id:g,channels:{cache:new Map()},roles:{cache:new Map()}}]])};
 await ConfigService.updateSetting(c,g,'prefix','?',u);assert.equal((await getGuildConfig(c,g)).prefix,'?');await ConfigService.bulkUpdate(c,g,{prefix:'%',dmOnClose:false},u);const cfg=await getGuildConfig(c,g);assert.equal(cfg.prefix,'%');assert.equal(cfg.dmOnClose,false);sqlite.close();
});
