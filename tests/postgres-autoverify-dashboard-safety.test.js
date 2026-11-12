import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getGuildConfig,patchGuildConfig} from '../src/services/config/guildConfig.js';
import dashboard from '../src/commands/Verification/modules/autoVerifyDashboard.js';

const guildId='123456789012345678',roleId='345678901234567890',newRoleId='456789012345678901';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();
 const schema=`autoverify_dash_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',updated_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}')`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:12});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;
 const client={db:{db:backend,isAvailable:()=>Boolean(backend.isAvailable()),getStatus:()=>({connectionType:'postgresql',isDegraded:false}),get:(...args)=>backend.get(...args),set:(...args)=>backend.set(...args)}};
 await patchGuildConfig(client,guildId,{verification:{enabled:false,autoVerify:{enabled:true,criteria:'account_age',accountAgeDays:7,roleId}}});
 return {pool,client};
}
async function openDashboard(client){
 const collectors=[];let display;
 const channel={createMessageComponentCollector(){const events={};const c={on(event,fn){events[event]=fn;return c},stop(){},events};collectors.push(c);return c}};
 const guild={id:guildId,name:'Test Guild',roles:{cache:new Map()},members:{me:{roles:{highest:{position:100}}}}};
 const root={id:'111111111111111111',user:{id:'222222222222222222'},guild,channel,deferred:false,replied:false,async deferReply(){this.deferred=true},async editReply(payload){display=payload}};
 await dashboard.execute(root,{},client);assert.equal(collectors.length,2);
 return {root,collectors,getDisplay:()=>display};
}
function component(root,values=[]){
 let response;const i={id:'333333333333333333',user:root.user,values,deferred:false,replied:false,
  async deferUpdate(){this.deferred=true},async followUp(payload){response=payload},async editReply(payload){response=payload},async reply(payload){this.replied=true;response=payload}};
 return {i,response:()=>response};
}

test('failed toggle leaves no pending state that can leak into a later successful role update', {skip:!enabled},async t=>{
 const {client,pool}=await setup(t);const {root,collectors,getDisplay}=await openDashboard(client);
 const button=component(root);button.i.customId=`autoverify_cfg_toggle_${guildId}`;
 await pool.query('ALTER TABLE welcome_configs RENAME TO offline');await collectors[1].events.collect(button.i);
 assert.match(button.response().embeds[0].data.description,/Failed to save server configuration|reload|try again/i);
 await pool.query('ALTER TABLE offline RENAME TO welcome_configs');
 const select=component(root,['role']);await collectors[0].events.collect(select.i);assert.equal(collectors.length,3);
 const role=component(root);role.i.roles={first:()=>({id:newRoleId,managed:false,position:1,toString:()=>'<@&role>'})};await collectors[2].events.collect(role.i);
 assert.match(role.response().embeds[0].data.title,/Role Updated/);
 const current=(await getGuildConfig(client,guildId)).verification.autoVerify;assert.equal(current.enabled,true);assert.equal(current.roleId,newRoleId);
 const status=getDisplay().embeds[0].data.fields.find(x=>x.name==='System Status');assert.equal(status.value,'Enabled');
});

test('account age modal reports stale verification to the actual submitter', {skip:!enabled},async t=>{
 const {client}=await setup(t);const {root,collectors}=await openDashboard(client);
 const select=component(root,['account_age']);let shownResolve,submitResolve;const shown=new Promise(r=>{shownResolve=r});
 select.i.showModal=async()=>shownResolve();select.i.awaitModalSubmit=async()=>new Promise(r=>{submitResolve=r});
 const run=collectors[0].events.collect(select.i);await shown;
 await patchGuildConfig(client,guildId,{verification:{autoVerify:{enabled:true,criteria:'account_age',accountAgeDays:7,roleId:newRoleId}}});
 const submitted=component(root);submitted.i.fields={getTextInputValue:()=> '30'};submitResolve(submitted.i);await run;
 assert.match(submitted.response().embeds[0].data.description,/Reload the dashboard/);assert.equal(select.response(),undefined);
 const current=(await getGuildConfig(client,guildId)).verification.autoVerify;assert.equal(current.accountAgeDays,7);assert.equal(current.roleId,newRoleId);
});

test('stale nested role selection is rejected without overwriting newer criteria', {skip:!enabled},async t=>{
 const {client}=await setup(t);const {root,collectors}=await openDashboard(client);
 const select=component(root,['role']);await collectors[0].events.collect(select.i);
 await patchGuildConfig(client,guildId,{verification:{autoVerify:{enabled:true,criteria:'none',accountAgeDays:null,roleId}}});
 const picked=component(root);picked.i.roles={first:()=>({id:newRoleId,managed:false,position:1})};await collectors[2].events.collect(picked.i);
 assert.match(picked.response().embeds[0].data.description,/Reload the dashboard/);
 const current=(await getGuildConfig(client,guildId)).verification.autoVerify;assert.equal(current.roleId,roleId);assert.equal(current.criteria,'none');
});

test('competing dashboard toggles reject stale state and unrelated guild updates survive', {skip:!enabled},async t=>{
 const {client}=await setup(t);const one=await openDashboard(client),two=await openDashboard(client);
 await patchGuildConfig(client,guildId,{prefix:'?'});
 const first=component(one.root),second=component(two.root);first.i.customId=second.i.customId=`autoverify_cfg_toggle_${guildId}`;
 await one.collectors[1].events.collect(first.i);await two.collectors[1].events.collect(second.i);
 assert.match(first.response().embeds[0].data.description,/disabled/);assert.match(second.response().embeds[0].data.description,/Reload the dashboard/);
 const current=await getGuildConfig(client,guildId);assert.equal(current.prefix,'?');assert.equal(current.verification.autoVerify.enabled,false);
});

test('blocked re-enable cannot leak into later edits after autorole is removed', {skip:!enabled},async t=>{
 const {client,pool}=await setup(t);const {root,collectors}=await openDashboard(client);
 const disable=component(root);disable.i.customId=`autoverify_cfg_toggle_${guildId}`;await collectors[1].events.collect(disable.i);
 assert.equal((await getGuildConfig(client,guildId)).verification.autoVerify.enabled,false);
 await pool.query('INSERT INTO welcome_configs(guild_id,config) VALUES($1,$2)',[guildId,JSON.stringify({roleIds:[newRoleId]})]);
 const enable=component(root);enable.i.customId=`autoverify_cfg_toggle_${guildId}`;await collectors[1].events.collect(enable.i);
 assert.match(enable.response().embeds[0].data.description,/conflicting/i);
 await pool.query('UPDATE welcome_configs SET config=$2 WHERE guild_id=$1',[guildId,JSON.stringify({roleIds:[]})]);
 const select=component(root,['role']);await collectors[0].events.collect(select.i);
 const picked=component(root);picked.i.roles={first:()=>({id:newRoleId,managed:false,position:1})};await collectors[2].events.collect(picked.i);
 const current=(await getGuildConfig(client,guildId)).verification.autoVerify;assert.equal(current.enabled,false);assert.equal(current.roleId,newRoleId);
});

test('criteria selection commits only the intended settings and keeps unrelated guild updates', {skip:!enabled},async t=>{
 const {client}=await setup(t);const {root,collectors}=await openDashboard(client);
 const button=component(root);button.i.customId=`autoverify_cfg_criteria_${guildId}`;await collectors[1].events.collect(button.i);
 await patchGuildConfig(client,guildId,{prefix:'?'});
 const picked=component(root,['none']);await collectors[2].events.collect(picked.i);
 assert.match(picked.response().embeds[0].data.title,/Criteria Updated/);
 const current=await getGuildConfig(client,guildId);assert.equal(current.prefix,'?');assert.equal(current.verification.autoVerify.criteria,'none');assert.equal(current.verification.autoVerify.accountAgeDays,null);assert.equal(current.verification.autoVerify.roleId,roleId);
});
