import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getGuildConfig,patchGuildConfig} from '../src/services/config/guildConfig.js';
import {reconcileVerificationPanels,reconcileTicketPanels} from '../src/services/panelHealthService.js';

const guildId='123456789012345678',channelId='234567890123456789',oldId='345678901234567890',newId='456789012345678901',botId='567890123456789012';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
async function setup(t,kind='verification'){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();
 const schema=`panel_reconcile_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);
 await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',updated_at timestamp DEFAULT now()); CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}')`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:12});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});
 const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;
 const client={db:{db:backend,isAvailable:()=>Boolean(backend.isAvailable()),getStatus:()=>({connectionType:'postgresql',isDegraded:false}),get:(...args)=>backend.get(...args),set:(...args)=>backend.set(...args)},user:{id:botId},homeGuildId:guildId};
 if(kind==='verification')await patchGuildConfig(client,guildId,{verification:{enabled:true,channelId,messageId:oldId,message:'initial'}});
 else await patchGuildConfig(client,guildId,{ticketPanelChannelId:channelId,ticketPanelMessageId:oldId});
 let scanResolve,scanStartedResolve;const scanStarted=new Promise(r=>{scanStartedResolve=r});
 const panel={id:newId,author:{id:botId},components:[{type:1,components:[{type:2,custom_id:kind==='verification'?'verify_user':'create_ticket'}]}]};
 const channel={messages:{async fetch(arg){if(typeof arg==='string')return null;scanStartedResolve();return new Promise(r=>{scanResolve=()=>r(new Map([[newId,panel]]))})}}};
 const guild={id:guildId,name:'Test Guild',channels:{async fetch(){return channel}}};client.guilds={cache:new Map([[guildId,guild]])};
 return {client,pool,scanStarted,finishScan:()=>scanResolve()};
}

test('verification startup recovery refuses stale scan and does not overwrite a newer edit', {skip:!enabled},async t=>{
 const {client,scanStarted,finishScan}=await setup(t);
 const running=reconcileVerificationPanels(client);await scanStarted;
 await patchGuildConfig(client,guildId,{verification:{message:'new message'}});finishScan();const summary=await running;
 assert.equal(summary.errors,1);assert.equal(summary.recoveredIds,0);
 const cfg=(await getGuildConfig(client,guildId)).verification;assert.equal(cfg.message,'new message');assert.equal(cfg.messageId,oldId);
});

test('verification startup recovery saves recovered id when the snapshot is unchanged', {skip:!enabled},async t=>{
 const {client,scanStarted,finishScan}=await setup(t);const running=reconcileVerificationPanels(client);await scanStarted;finishScan();const summary=await running;
 assert.equal(summary.errors,0);assert.equal(summary.recoveredIds,1);assert.equal(summary.healthyPanels,1);
 const cfg=(await getGuildConfig(client,guildId)).verification;assert.equal(cfg.message,'initial');assert.equal(cfg.messageId,newId);
});

test('ticket startup recovery reports no successful recovery when its snapshot is stale', {skip:!enabled},async t=>{
 const {client,scanStarted,finishScan}=await setup(t,'ticket');const running=reconcileTicketPanels(client);await scanStarted;
 await patchGuildConfig(client,guildId,{prefix:'?'});finishScan();const summary=await running;
 assert.equal(summary.errors,1);assert.equal(summary.recoveredIds,0);
 const cfg=await getGuildConfig(client,guildId);assert.equal(cfg.prefix,'?');assert.equal(cfg.ticketPanelMessageId,oldId);
});

test('verification startup recovery reports an error when PostgreSQL cannot write', {skip:!enabled},async t=>{
 const {client,pool,scanStarted,finishScan}=await setup(t);const running=reconcileVerificationPanels(client);await scanStarted;
 await pool.query('ALTER TABLE welcome_configs RENAME TO offline');finishScan();const summary=await running;
 assert.equal(summary.errors,1);assert.equal(summary.recoveredIds,0);
 await pool.query('ALTER TABLE offline RENAME TO welcome_configs');
 const cfg=(await getGuildConfig(client,guildId)).verification;assert.equal(cfg.messageId,oldId);
});
