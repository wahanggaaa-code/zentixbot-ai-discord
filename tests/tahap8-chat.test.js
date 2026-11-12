import test from 'node:test';
import assert from 'node:assert/strict';
import {ChannelType,MessageFlags} from 'discord.js';
import {JSDOM} from 'jsdom';
import fs from 'node:fs';
import {DEFAULT_CHAT,validateChatSettings,runChat} from '../src/services/ai/chat.js';
import command from '../src/commands/AI/aichat.js';
const guildId='123456789012345678',userId='234567890123456789',channelId='345678901234567890';
const settings={...DEFAULT_CHAT,enabled:true,channelId};
test('chat is opt-in, single-guild, channel restricted and sends only supplied question/persona',async()=>{
 const guild={channels:{cache:new Map([[channelId,{id:channelId,type:ChannelType.GuildText}]])}};assert.equal(DEFAULT_CHAT.enabled,false);assert.deepEqual(validateChatSettings(settings,guild),settings);for(const p of [{channelId:'999999999999999999'},{persona:''},{enabled:'true'},{other:true}])assert.throws(()=>validateChatSettings({...settings,...p},guild));
 let sent;const client={homeGuildId:guildId},store={read:async()=>settings},foundation={generate:async x=>{sent=x;return {text:'Jawaban',usedFallback:false}}};const base={client,guildId,channelId,userId,question:'Pertanyaan contoh',consent:true,store,foundation};
 await assert.rejects(runChat({...base,consent:false}),{status:403});await assert.rejects(runChat({...base,guildId:'456789012345678901'}),{status:403});await assert.rejects(runChat({...base,channelId:'456789012345678901'}),{status:403});assert.equal(sent,undefined);
 const result=await runChat(base);assert.equal(result.text,'Jawaban');assert.equal(sent.userId,userId);assert.match(sent.prompt,/Pertanyaan contoh/);assert.equal(sent.consent,true);
});
test('Discord slash chat requires consent, ephemeral response, and blocks mass mentions',async()=>{
 let calls=0,reply,edit,defer;const client={homeGuildId:guildId,db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:{query:async()=>({rows:[{value:settings}]})}}},aiFoundation:{generate:async()=>{calls++;return {text:'Hi @everyone'}}}};
 const i=consent=>({guildId,channelId,user:{id:userId,bot:false},inGuild:()=>true,options:{getBoolean:()=>consent,getString:name=>name==='mode'?'channel':'Hi'},reply:async x=>{reply=x},deferReply:async x=>{defer=x},editReply:async x=>{edit=x}});
 await command.execute(i(false),{},client);assert.equal(calls,0);assert.equal(reply.flags,MessageFlags.Ephemeral);await command.execute(i(true),{},client);assert.equal(calls,1);assert.equal(defer.flags,MessageFlags.Ephemeral);assert.deepEqual(edit.allowedMentions,{parse:[]});
});
test('agent channel and DM settings are live',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const dom=new JSDOM(html,{url:'http://localhost/dashboard/#ai/agent',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.scrollTo=()=>{};let saved;
 w.fetch=async(u,o={})=>({ok:true,json:async()=>{if(String(u).endsWith('/me'))return {user:{username:'Owner'},guild:{name:'Guild'},csrf:'x'};if(o.method==='PATCH'){saved=JSON.parse(o.body);return {ok:true}}return {settings,channels:[{id:channelId,name:'chat'}]}}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-welcome.js','ai-activities.js','ai-chat.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,40));const f=w.document.querySelector('#aiChatForm');assert.ok(f);f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));assert.equal(saved.channelId,channelId);w.document.querySelector('[data-ai-tab="dm"]').click();assert.ok(w.document.querySelector('#aiChat'));assert.match(w.document.querySelector('.f-demo-warning').textContent,/CHAT CHANNEL DAN DM TERHUBUNG/);
});

test('DM entry only accepts bot messages for target user and rechecks guild membership',async()=>{
 const {mayDispatchEvent}=await import('../src/utils/singleGuild.js');const {default:button}=await import('../src/interactions/buttons/ai/dmCompose.js');const {default:modal}=await import('../src/interactions/modals/ai/dmForm.js');
 const botId='456789012345678901';let member=true,shown=false,called=0,reply;const dmSettings={...settings,dmEnabled:true};
 const client={homeGuildId:guildId,user:{id:botId},guilds:{cache:new Map([[guildId,{members:{fetch:async()=>{if(!member)throw Error('not member');return {id:userId}}}}]])},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:{query:async()=>({rows:[{value:dmSettings}]})}}},aiFoundation:{generate:async()=>{called++;return {text:'DM answer'}}}};
 const dmButton={user:{id:userId},customId:`ai_dm_compose:${guildId}:${userId}`,message:{author:{id:botId}},isButton:()=>true,showModal:async()=>{shown=true},reply:async x=>{reply=x}};
 assert.equal(mayDispatchEvent(client,'interactionCreate',[dmButton]),true);assert.equal(mayDispatchEvent(client,'interactionCreate',[{...dmButton,user:{id:botId}}]),false);assert.equal(mayDispatchEvent(client,'interactionCreate',[{...dmButton,message:{author:{id:userId}}}]),false);
 member=false;await button.execute(dmButton,client,[guildId,userId]);assert.equal(shown,false);assert.match(reply.content,/anggota/);member=true;await button.execute(dmButton,client,[guildId,userId]);assert.equal(shown,true);
 const dmModal={user:{id:userId},customId:`ai_dm_form:${guildId}:${userId}`,isModalSubmit:()=>true,deferReply:async()=>{},fields:{getTextInputValue:()=> 'pertanyaan pribadi'},editReply:async x=>{reply=x}};
 assert.equal(mayDispatchEvent(client,'interactionCreate',[dmModal]),true);member=false;await modal.execute(dmModal,client,[guildId,userId]);assert.equal(called,0);member=true;await modal.execute(dmModal,client,[guildId,userId]);assert.equal(called,1);assert.equal(reply.content,'DM answer');assert.deepEqual(reply.allowedMentions,{parse:[]});
});
