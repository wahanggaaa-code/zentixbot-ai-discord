import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { requireHomeGuildId, isHomeGuild, mayDispatchEvent } from '../src/utils/singleGuild.js';
import { createDashboardRouter } from '../src/dashboard/router.js';

const home='123456789012345678', other='234567890123456789', user='345678901234567890';
test('single guild policy fails closed including DMs and unknown events', () => {
  assert.throws(()=>requireHomeGuildId('')); assert.throws(()=>requireHomeGuildId('not-an-id'));
  assert.equal(requireHomeGuildId(' '+home+' '),home);
  const client={homeGuildId:home};
  assert.equal(isHomeGuild(client,other),false);
  for(const name of ['messageCreate','interactionCreate','voiceStateUpdate','guildMemberAdd','channelDelete','roleCreate']) {
    assert.equal(mayDispatchEvent(client,name,[{guildId:other}]),false,name);
    assert.equal(mayDispatchEvent(client,name,[{}]),false,name);
    assert.equal(mayDispatchEvent(client,name,[{guildId:home}]),true,name);
  }
  assert.equal(mayDispatchEvent(client,'guildCreate',[{id:other}]),false);
  assert.equal(mayDispatchEvent(client,'guildCreate',[{id:home}]),true);
  assert.equal(mayDispatchEvent(client,'clientReady',[]),true);
  assert.equal(mayDispatchEvent({},'userUpdate',[]),false);
});

test('OAuth session, guild authorization and CSRF are enforced', async t => {
  let admin = true, ready = true, validMember = true;
  const guild={id:home,name:'Home',ownerId:'999999999999999999',members:{fetch:async({user:uid,force})=>{
    assert.equal(uid,user); assert.equal(force,true); if(!validMember) throw Error('not a member');
    return {permissions:{has:p=>p===PermissionFlagsBits.Administrator && admin}};
  }}};
  const client={homeGuildId:home,isReady:()=>ready,guilds:{cache:new Map([[home,guild]])}};
  const mockFetch=async url=>({ok:true,json:async()=>url.endsWith('/token')?{access_token:'mock',expires_in:3600}:{id:user,username:'tester'}});
  const app=express(); app.use('/dashboard',createDashboardRouter(client,{fetchImpl:mockFetch,env:{CLIENT_ID:other,DISCORD_CLIENT_SECRET:'secret',DASHBOARD_URL:'http://localhost:9999'}}));
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const req=(url,opts={})=>fetch(base+url,{redirect:'manual',...opts});
  assert.equal((await req('/dashboard/api/me')).status,401);
  assert.equal((await req('/dashboard/')).status,302);
  assert.equal((await req('/dashboard/callback?code=x&state=bad')).status,400);
  async function login() {
    const start=await req('/dashboard/login'); assert.equal(start.status,302);
    const stateCookie=start.headers.get('set-cookie').split(';')[0];
    const oauth=new URL(start.headers.get('location')); assert.equal(oauth.searchParams.get('scope'),'identify');
    const state=oauth.searchParams.get('state');
    const cb=await req(`/dashboard/callback?code=mock&state=${state}`,{headers:{cookie:stateCookie}});
    return {cb,state,stateCookie};
  }
  let first=await login(); assert.equal(first.cb.status,302);
  let cookies=first.cb.headers.getSetCookie(); let session=cookies.find(x=>x.startsWith('zx_session=')).split(';')[0];
  assert.equal((await req(`/dashboard/callback?code=mock&state=${first.state}`,{headers:{cookie:first.stateCookie}})).status,400);
  assert.equal((await req('/dashboard/',{headers:{cookie:session}})).status,200);
  let me=await req('/dashboard/api/me',{headers:{cookie:session}});assert.equal(me.status,200); const data=await me.json();assert.equal(data.guild.id,home);
  assert.equal((await req('/dashboard/api/logout',{method:'POST',headers:{cookie:session,origin:'http://evil.example','x-csrf-token':data.csrf}})).status,403);
  assert.equal((await req('/dashboard/api/logout',{method:'POST',headers:{cookie:session,origin:'http://localhost:9999','x-csrf-token':'bad'}})).status,403);
  admin=false; assert.equal((await req('/dashboard/api/me',{headers:{cookie:session}})).status,403);
  assert.equal((await login()).cb.status,403);
  validMember=false; assert.equal((await req('/dashboard/api/me',{headers:{cookie:session}})).status,403);
  validMember=true; admin=true; ready=false; assert.equal((await req('/dashboard/api/me',{headers:{cookie:session}})).status,503);
  ready=true;
  assert.equal((await req('/dashboard/api/logout',{method:'POST',headers:{cookie:session,origin:'http://localhost:9999','x-csrf-token':data.csrf}})).status,200);
  assert.equal((await req('/dashboard/api/me',{headers:{cookie:session}})).status,401);
});

test('insecure public URL disables OAuth',async t=>{
 const app=express();app.use('/dashboard',createDashboardRouter({homeGuildId:home},{env:{CLIENT_ID:other,DISCORD_CLIENT_SECRET:'x',DASHBOARD_URL:'http://example.com'}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/dashboard/login`)).status,503);
});

test('registered event loader rejects foreign interaction and still accepts home event', async () => {
  const {EventEmitter}=await import('node:events');
  const {default:loadEvents}=await import('../src/handlers/loaders/events.js');
  const client=new EventEmitter(); client.homeGuildId=home;
  await loadEvents(client);
  let reply;
  client.emit('interactionCreate', {guildId:other,isAutocomplete:()=>false,isRepliable:()=>true,reply:async x=>{reply=x}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(reply.content,/hanya aktif/);
  let responded;
  client.emit('interactionCreate',{guildId:other,isAutocomplete:()=>true,respond:async v=>{responded=v}});
  await new Promise(resolve=>setImmediate(resolve)); assert.deepEqual(responded,[]);
  // A home guild bot message reaches the handler and exits harmlessly.
  client.emit('messageCreate',{guildId:home,author:{bot:true},guild:{id:home}});
  await new Promise(resolve=>setImmediate(resolve));
});

test('startup panel reconciliation skips foreign guilds',async()=>{
  const {reconcileTicketPanels,reconcileVerificationPanels,reconcileReactionRolePanelHealth}=await import('../src/services/panelHealthService.js');
  const foreign={id:other,name:'Other'};
  const client={homeGuildId:home,guilds:{cache:new Map([[other,foreign]])},db:{get:()=>{throw Error('must not read foreign data')}}};
  for(const run of [reconcileTicketPanels,reconcileVerificationPanels,reconcileReactionRolePanelHealth]) {
    const result=await run(client);
    if ('scannedGuilds' in result) assert.equal(result.scannedGuilds,0);
    assert.equal(result.errors,0);
  }
});

test('slash commands register only to configured guild',async()=>{
 const {registerCommands}=await import('../src/handlers/loaders/commandLoader.js');
 const calls=[]; const client={commands:new Map([['ping',{data:{name:'ping',toJSON:()=>({name:'ping',description:'Ping'})}}]]),rest:{put:async(path,body)=>calls.push({path,body})}};
 await registerCommands(client,{clientId:other,guildId:home});
 assert.ok(calls.length); assert.ok(calls.every(call=>call.path===`/applications/${other}/guilds/${home}/commands`));
 await assert.rejects(registerCommands(client,{clientId:other,guildId:''}));
});

test('single-guild policy permits only well-formed feedback DM interactions for home guild',()=>{
 const bot='456789012345678901', channel='567890123456789012';
 const client={homeGuildId:home,user:{id:bot}};
 const button=id=>({customId:id,message:{author:{id:bot}},isButton:()=>true});
 assert.equal(mayDispatchEvent(client,'interactionCreate',[button(`ticket_feedback:${home}:${channel}:5`)]),true);
 assert.equal(mayDispatchEvent(client,'interactionCreate',[button(`ticket_feedback_comment:${home}:${channel}`)]),true);
 assert.equal(mayDispatchEvent(client,'interactionCreate',[button(`ticket_feedback_decline:${home}:${channel}`)]),true);
 assert.equal(mayDispatchEvent(client,'interactionCreate',[{customId:`ticket_feedback_comment_modal:${home}:${channel}`,isModalSubmit:()=>true}]),true);
 assert.equal(mayDispatchEvent(client,'interactionCreate',[{customId:`ticket_feedback:${home}:${channel}`,message:{author:{id:bot}},isStringSelectMenu:()=>true}]),true);
 for(const i of [button(`ticket_feedback:${other}:${channel}:5`),button(`ticket_feedback:${home}:${channel}:6`),button(`ticket_feedback:${home}:invalid:1`),button(`other:${home}:${channel}`),{...button(`ticket_feedback:${home}:${channel}:1`),message:{author:{id:user}}},{customId:`ticket_feedback_comment_modal:${other}:${channel}`,isModalSubmit:()=>true}]) assert.equal(mayDispatchEvent(client,'interactionCreate',[i]),false);
});
