import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getGuildConfig, patchGuildConfig} from '../src/services/config/guildConfig.js';
import {saveVerificationDashboardChange} from '../src/services/config/verificationDashboardUpdate.js';
import dashboard from '../src/commands/Verification/modules/verification_dashboard.js';

const guildId='123456789012345678', channelId='234567890123456789';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function setup(t) {
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();
 const schema=`verif_dash_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',updated_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}')`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:12});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;const client={db:{db:backend,isAvailable:()=>Boolean(backend.isAvailable()),getStatus:()=>({connectionType:'postgresql',isDegraded:false}),get:(...args)=>backend.get(...args),set:(...args)=>backend.set(...args)}};
 await patchGuildConfig(client,guildId,{verification:{enabled:false,channelId,roleId:'345678901234567890',message:'initial',buttonText:'Verify'}});
 return {pool,client};
}

test('dashboard edits preserve unrelated fields and reject stale nested state', {skip:!enabled},async t=>{
 const {client}=await setup(t);const shared=(await getGuildConfig(client,guildId)).verification, original=structuredClone(shared);
 await patchGuildConfig(client,guildId,{prefix:'?'});
 await saveVerificationDashboardChange(client,guildId,shared,original,{message:'new'});
 let latest=await getGuildConfig(client,guildId);assert.equal(latest.prefix,'?');assert.equal(latest.verification.message,'new');
 const before=structuredClone(shared);await patchGuildConfig(client,guildId,{verification:{buttonText:'Changed elsewhere'}});
 await assert.rejects(saveVerificationDashboardChange(client,guildId,shared,before,{roleId:'456789012345678901'}),e=>e.userMessage?.includes('Reload'));
 assert.deepEqual(shared,before);latest=await getGuildConfig(client,guildId);assert.equal(latest.verification.buttonText,'Changed elsewhere');assert.equal(latest.verification.roleId,'345678901234567890');
});

test('concurrent dashboard writes from one displayed state only commit one change', {skip:!enabled},async t=>{
 const {client}=await setup(t);const shared=(await getGuildConfig(client,guildId)).verification, expected=structuredClone(shared);
 const result=await Promise.allSettled(Array.from({length:20},(_,i)=>saveVerificationDashboardChange(client,guildId,shared,expected,{message:`message-${i}`})));
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 const latest=(await getGuildConfig(client,guildId)).verification;assert.deepEqual(shared,latest);assert.match(latest.message,/^message-/);
});

test('failed save does not mutate local dashboard state', {skip:!enabled},async t=>{
 const {client,pool}=await setup(t);const shared=(await getGuildConfig(client,guildId)).verification, expected=structuredClone(shared);
 await pool.query('ALTER TABLE welcome_configs RENAME TO offline');
 await assert.rejects(saveVerificationDashboardChange(client,guildId,shared,expected,{message:'unsaved'}));assert.deepEqual(shared,expected);
 await pool.query('ALTER TABLE offline RENAME TO welcome_configs');assert.equal((await getGuildConfig(client,guildId)).verification.message,'initial');
});

test('actual verification modal reports stale changes to the submitter and does not claim success', {skip:!enabled},async t=>{
 const {client}=await setup(t);const collectors=[];
 const channel={createMessageComponentCollector(){const events={};const c={on(event,fn){events[event]=fn;return c},stop(){},events};collectors.push(c);return c}};
 const guild={id:guildId,name:'Test Guild',roles:{cache:new Map()},channels:{cache:new Map()}};
 const root={id:'111111111111111111',user:{id:'222222222222222222'},guild,channel,deferred:false,replied:false,
  async deferReply(){this.deferred=true},async editReply(){},async fetchReply(){return {id:'333333333333333333'}}};
 await dashboard.execute(root,{},client);assert.equal(collectors.length,2);
 let response, submitResolve, modalShownResolve;const modalShown=new Promise(r=>{modalShownResolve=r});
 const submitted={id:'444444444444444444',user:root.user,deferred:false,replied:false,fields:{getTextInputValue:()=> 'user edit'},async reply(payload){this.replied=true;response=payload},async followUp(payload){response=payload},async editReply(payload){response=payload}};
 const select={id:'555555555555555555',user:root.user,values:['message'],message:{id:'333333333333333333'},deferred:false,replied:false,
  async showModal(){modalShownResolve()},async awaitModalSubmit(){return new Promise(r=>{submitResolve=r})},async deferUpdate(){this.deferred=true},async editReply(){},async followUp(){}};
 const handling=collectors[0].events.collect(select);await modalShown;
 await patchGuildConfig(client,guildId,{verification:{buttonText:'External change'}});
 submitResolve(submitted);await handling;
 assert.match(response.embeds[0].data.description,/Reload the dashboard/);
 const current=(await getGuildConfig(client,guildId)).verification;assert.equal(current.message,'initial');assert.equal(current.buttonText,'External change');
});

test('stale channel selection does not delete the old Discord panel', {skip:!enabled},async t=>{
 const {client}=await setup(t);const oldId='666666666666666666';await patchGuildConfig(client,guildId,{verification:{messageId:oldId}});
 const collectors=[];let deleted=0,response;
 const interactionChannel={createMessageComponentCollector(){const events={};const c={on(event,fn){events[event]=fn;return c},stop(){},events};collectors.push(c);return c}};
 const oldChannel={messages:{async fetch(){return {async delete(){deleted++}}}}};
 const guild={id:guildId,name:'Test Guild',roles:{cache:new Map()},channels:{cache:new Map([[channelId,oldChannel]])},members:{me:{}}};
 const root={id:'111111111111111111',user:{id:'222222222222222222'},guild,channel:interactionChannel,deferred:false,replied:false,async deferReply(){this.deferred=true},async editReply(){},async fetchReply(){return {id:'333333333333333333'}}};
 await dashboard.execute(root,{},client);
 const select={id:'555555555555555555',user:root.user,values:['channel'],message:{id:'333333333333333333'},deferred:false,replied:false,async deferUpdate(){this.deferred=true},async followUp(){}};
 await collectors[0].events.collect(select);assert.equal(collectors.length,3);
 await patchGuildConfig(client,guildId,{verification:{buttonText:'Edited elsewhere'}});
 const destination={id:'777777777777777777',guild,permissionsFor:()=>({has:()=>true})};
 const picked={id:'888888888888888888',user:root.user,channels:{first:()=>destination},deferred:false,replied:false,async deferUpdate(){this.deferred=true},async editReply(payload){response=payload},async followUp(payload){response=payload}};
 await collectors[2].events.collect(picked);
 assert.equal(deleted,0);assert.match(response.embeds[0].data.description,/Reload the dashboard/);
 const current=(await getGuildConfig(client,guildId)).verification;assert.equal(current.channelId,channelId);assert.equal(current.messageId,oldId);assert.equal(current.buttonText,'Edited elsewhere');
});

test('failed Discord send preserves previous channel and panel without claiming success', {skip:!enabled},async t=>{
 const {client}=await setup(t);const oldId='666666666666666666';await patchGuildConfig(client,guildId,{verification:{enabled:true,messageId:oldId}});
 const collectors=[];let deleted=0,response;
 const interactionChannel={createMessageComponentCollector(){const events={};const c={on(event,fn){events[event]=fn;return c},stop(){},events};collectors.push(c);return c}};
 const oldChannel={messages:{async fetch(){return {components:[{type:1,components:[{type:2,custom_id:'verify_user'}]}],async delete(){deleted++}}}}};
 const guild={id:guildId,name:'Test Guild',roles:{cache:new Map()},channels:{cache:new Map([[channelId,oldChannel]]),async fetch(){return oldChannel}},members:{me:{}}};
 const root={id:'111111111111111111',user:{id:'222222222222222222'},guild,channel:interactionChannel,deferred:false,replied:false,async deferReply(){this.deferred=true},async editReply(){},async fetchReply(){return {id:'333333333333333333'}}};
 await dashboard.execute(root,{},client);
 const select={id:'555555555555555555',user:root.user,values:['channel'],message:{id:'333333333333333333'},deferred:false,replied:false,async deferUpdate(){this.deferred=true},async followUp(){}};
 await collectors[0].events.collect(select);
 const destination={id:'777777777777777777',guild,permissionsFor:()=>({has:()=>true}),async send(){throw new Error('Discord unavailable')}};
 const picked={id:'888888888888888888',user:root.user,channels:{first:()=>destination},deferred:false,replied:false,async deferUpdate(){this.deferred=true},async editReply(payload){response=payload},async followUp(payload){response=payload}};
 await collectors[2].events.collect(picked);
 assert.equal(deleted,0);assert.match(response.embeds[0].data.description,/Could not post/);
 const current=(await getGuildConfig(client,guildId)).verification;assert.equal(current.channelId,channelId);assert.equal(current.messageId,oldId);
});

test('stale disable does not delete the active Discord panel', {skip:!enabled},async t=>{
 const {client}=await setup(t);const oldId='666666666666666666';await patchGuildConfig(client,guildId,{verification:{enabled:true,messageId:oldId}});
 const collectors=[];let deleted=0,response;
 const interactionChannel={createMessageComponentCollector(){const events={};const c={on(event,fn){events[event]=fn;return c},stop(){},events};collectors.push(c);return c}};
 const oldChannel={messages:{async fetch(){return {components:[{type:1,components:[{type:2,custom_id:'verify_user'}]}],async delete(){deleted++}}}}};
 const guild={id:guildId,name:'Test Guild',roles:{cache:new Map()},channels:{cache:new Map([[channelId,oldChannel]]),async fetch(){return oldChannel}}};
 const root={id:'111111111111111111',user:{id:'222222222222222222'},guild,channel:interactionChannel,deferred:false,replied:false,async deferReply(){this.deferred=true},async editReply(){},async fetchReply(){return {id:'333333333333333333'}}};
 await dashboard.execute(root,{},client);await patchGuildConfig(client,guildId,{verification:{buttonText:'Edited elsewhere'}});
 const button={id:'888888888888888888',user:root.user,customId:`verif_cfg_toggle_${guildId}`,deferred:false,replied:false,async deferUpdate(){this.deferred=true},async editReply(payload){response=payload},async followUp(payload){response=payload}};
 await collectors[1].events.collect(button);
 assert.equal(deleted,0);assert.match(response.embeds[0].data.description,/Reload the dashboard/);
 const current=(await getGuildConfig(client,guildId)).verification;assert.equal(current.enabled,true);assert.equal(current.messageId,oldId);assert.equal(current.buttonText,'Edited elsewhere');
});
