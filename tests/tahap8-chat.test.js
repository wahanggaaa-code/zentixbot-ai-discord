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
 const i=consent=>({guildId,channelId,user:{id:userId,bot:false},inGuild:()=>true,options:{getBoolean:name=>name==='consent'?consent:false,getAttachment:()=>null,getString:name=>name==='mode'?'channel':'Hi'},reply:async x=>{reply=x},deferReply:async x=>{defer=x},editReply:async x=>{edit=x}});
 await command.execute(i(false),{},client);assert.equal(calls,0);assert.equal(reply.flags,MessageFlags.Ephemeral);await command.execute(i(true),{},client);assert.equal(calls,1);assert.equal(defer.flags,MessageFlags.Ephemeral);assert.deepEqual(edit.allowedMentions,{parse:[]});
});
test('agent channel and DM settings are live',async t=>{
 const html=fs.readFileSync('dashboard-preview/index.html','utf8').replace(/<script src=".*?"><\/script>/g,'');const dom=new JSDOM(html,{url:'http://localhost/dashboard/#ai/agent',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());w.scrollTo=()=>{};let saved;
 w.fetch=async(u,o={})=>({ok:true,json:async()=>{if(String(u).endsWith('/me'))return {user:{username:'Owner'},guild:{name:'Guild'},csrf:'x'};if(o.method==='PATCH'){saved=JSON.parse(o.body);return {ok:true}}return {settings,channels:[{id:channelId,name:'chat'}]}}});
 for(const x of ['session.js','live.js','modules-live.js','operations-live.js','features.js','ai-foundation.js','ai-welcome.js','ai-activities.js','ai-chat.js','ai-studio.js','app.js'])w.eval(fs.readFileSync('dashboard-preview/'+x,'utf8'));
 await new Promise(r=>setTimeout(r,40));const f=w.document.querySelector('#aiChatForm');assert.ok(f);f.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,10));assert.equal(saved.channelId,channelId);assert.equal(saved.dmEnabled,settings.dmEnabled);
 // Channel, DM and persona are one form, so the dashboard shows them under one tab.
 assert.deepEqual([...w.document.querySelectorAll('.f-tabs [data-ai-tab]')].map(b=>b.dataset.aiTab),['channel']);assert.ok(w.document.querySelector('#aiChatForm').elements.dmEnabled);assert.ok(w.document.querySelector('#aiChatForm').elements.persona);assert.ok(w.document.querySelector('#aiChat'));assert.match(w.document.querySelector('.f-demo-warning').textContent,/CHAT CHANNEL DAN DM TERHUBUNG/);
});

test('DM entry only accepts bot messages for target user and rechecks guild membership',async()=>{
 const {mayDispatchEvent}=await import('../src/utils/singleGuild.js');const {default:button}=await import('../src/interactions/buttons/ai/dmCompose.js');const {default:modal}=await import('../src/interactions/modals/ai/dmForm.js');
 const botId='456789012345678901';let member=true,shown=false,called=0,reply;const dmSettings={...settings,dmEnabled:true};
 const client={homeGuildId:guildId,user:{id:botId},guilds:{cache:new Map([[guildId,{members:{fetch:async()=>{if(!member)throw Error('not member');return {id:userId}}}}]])},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:{query:async()=>({rows:[{value:dmSettings}]})}}},aiFoundation:{generate:async()=>{called++;return {text:'DM answer'}}}};
 const dmButton={user:{id:userId},customId:`ai_dm_compose:${guildId}:${userId}`,message:{author:{id:botId}},isButton:()=>true,showModal:async()=>{shown=true},reply:async x=>{reply=x}};
 assert.equal(mayDispatchEvent(client,'interactionCreate',[dmButton]),true);assert.equal(mayDispatchEvent(client,'interactionCreate',[{...dmButton,user:{id:botId}}]),false);assert.equal(mayDispatchEvent(client,'interactionCreate',[{...dmButton,message:{author:{id:userId}}}]),false);
 member=false;await button.execute(dmButton,client,[guildId,userId]);assert.equal(shown,false);assert.match(reply.content,/anggota/);member=true;await button.execute(dmButton,client,[guildId,userId]);assert.equal(shown,true);
 const dmModal={user:{id:userId},customId:`ai_dm_form:${guildId}:${userId}`,isModalSubmit:()=>true,deferReply:async()=>{},fields:{getTextInputValue:()=> 'pertanyaan pribadi',getCheckbox:()=>false,getUploadedFiles:()=>null},editReply:async x=>{reply=x}};
 assert.equal(mayDispatchEvent(client,'interactionCreate',[dmModal]),true);member=false;await modal.execute(dmModal,client,[guildId,userId]);assert.equal(called,0);member=true;await modal.execute(dmModal,client,[guildId,userId]);assert.equal(called,1);assert.equal(reply.content,'DM answer');assert.deepEqual(reply.allowedMentions,{parse:[]});
});

test('knowledge access is explicitly enabled and selected; memory opt-in is per-user and erasable',async()=>{
 const {clearChatMemory,viewChatMemory}=await import('../src/services/ai/chat.js');const client={homeGuildId:guildId},prompts=[];
 const foundation={generate:async x=>{prompts.push(x.prompt);return {text:'jawaban AI'}}};let cfg={...settings};const store={read:async()=>cfg};let reads=0;
 const knowledgeStore={read:async()=>{reads++;return [{name:'aturan.txt',content:'Aturan komunitas: saling menghormati.'}]}};
 const base={client,guildId,channelId,userId,question:'aturan komunitas',consent:true,store,foundation,knowledgeStore};
 clearChatMemory(guildId,userId);await assert.rejects(runChat({...base,useKnowledge:true}),{status:403});assert.equal(reads,0);
 cfg={...cfg,knowledgeEnabled:true};const r=await runChat({...base,memory:true,useKnowledge:true});assert.equal(reads,1);assert.equal(r.sources[0].name,'aturan.txt');assert.match(prompts[0],/saling menghormati/);
 assert.equal(viewChatMemory(guildId,userId).length,1);assert.deepEqual(viewChatMemory(guildId,'999999999999999999'),[]);
 await runChat({...base,question:'baru',memory:false});assert.doesNotMatch(prompts[1],/RIWAYAT/);assert.equal(viewChatMemory(guildId,userId).length,1);
 await runChat({...base,question:'lanjut',memory:true});assert.match(prompts[2],/aturan komunitas/);clearChatMemory(guildId,userId);assert.deepEqual(viewChatMemory(guildId,userId),[]);
});
test('clearing memory during an in-flight provider call prevents recreation',async()=>{
 const {clearChatMemory,viewChatMemory}=await import('../src/services/ai/chat.js');let finish;const wait=new Promise(r=>{finish=r});
 const job=runChat({client:{homeGuildId:guildId},guildId,channelId,userId,question:'halo',consent:true,memory:true,store:{read:async()=>settings},foundation:{generate:()=>wait}});
 await new Promise(r=>setImmediate(r));clearChatMemory(guildId,userId);finish({text:'hai'});await job;assert.deepEqual(viewChatMemory(guildId,userId),[]);
});

test('proactive agent claims daily slot, sends only generic output, and rejects unsafe content',async()=>{
 const {runProactiveAgent}=await import('../src/services/ai/chat.js');let saved={},messages=[],prompts=[];
 const query=async(sql,args=[])=>{if(sql.startsWith('SELECT value'))return {rows:[{value:saved}]};if(sql.startsWith('UPDATE'))saved=JSON.parse(args[1]);return {rows:[]}};
 const channel={type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),send:async x=>messages.push(x)};
 const guild={id:guildId,channels:{cache:new Map([[channelId,channel]])},members:{me:{}}};const client={homeGuildId:guildId,user:{id:userId},guilds:{cache:new Map([[guildId,guild]])},db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{isAvailable:()=>true,pool:{connect:async()=>({query,release(){}})}}}};
 const cfg={...settings,proactiveEnabled:true,proactiveTime:'18:00',proactiveZone:'WIB'};const store={read:async()=>cfg};const foundation={generate:async x=>{prompts.push(x.prompt);return {text:'Apa hobi favoritmu?'}}};const now=new Date('2026-11-12T11:00:00Z');
 assert.equal(await runProactiveAgent(client,{store,foundation,now}),true);assert.equal(await runProactiveAgent(client,{store,foundation,now}),false);assert.equal(messages.length,1);assert.deepEqual(messages[0].allowedMentions,{parse:[]});assert.doesNotMatch(prompts[0],new RegExp(userId));
 saved={};await assert.rejects(runProactiveAgent(client,{store,now,foundation:{generate:async()=>({text:'@everyone https://bad.test'})}}));assert.equal(messages.length,1);
});

test('image chat accepts only bounded Discord CDN PNG/JPEG and transmits only after consent',async()=>{
 const {readDiscordImage}=await import('../src/services/ai/attachments.js');const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,1]);const a={url:`https://cdn.discordapp.com/attachments/${channelId}/${userId}/image.png`,size:bytes.length};let fetches=0;
 const fetcher=async()=>{fetches++;return new Response(bytes)};await assert.rejects(readDiscordImage({...a,url:'https://evil.example/x'},fetcher));assert.equal(fetches,0);
 const image=await readDiscordImage(a,fetcher);assert.equal(image.mime,'image/png');await assert.rejects(readDiscordImage({...a,size:1},fetcher));await assert.rejects(readDiscordImage(a,async()=>new Response(Buffer.from('notimage!x'))));
 let sent;const base={client:{homeGuildId:guildId},guildId,channelId,userId,question:'Apa ini?',consent:true,attachment:a,store:{read:async()=>settings},fetchImage:async()=>image,foundation:{generate:async x=>{sent=x;return {text:'gambar'}}}};
 await assert.rejects(runChat({...base,consent:false}),{status:403});assert.equal(sent,undefined);await runChat(base);assert.deepEqual(sent.image,image);
});

test('concurrent memory requests for same user and scope are rejected before provider or attachment work',async()=>{
 const {clearChatMemory,viewChatMemory}=await import('../src/services/ai/chat.js');let release,calls=0,downloads=0;const wait=new Promise(r=>{release=r});const base={client:{homeGuildId:guildId},guildId,channelId,userId,question:'pertanyaan pertama',consent:true,memory:true,store:{read:async()=>settings},foundation:{generate:async()=>{calls++;await wait;return {text:'jawaban'}}}};
 clearChatMemory(guildId,userId);const first=runChat(base);await new Promise(r=>setImmediate(r));await assert.rejects(runChat({...base,question:'pertanyaan kedua',attachment:{},fetchImage:async()=>{downloads++}}),{status:429});assert.equal(calls,1);assert.equal(downloads,0);
 // DM memory has a different scope; stateless requests also remain independent.
 await runChat({...base,dm:true,store:{read:async()=>({...settings,dmEnabled:true})},foundation:{generate:async()=>({text:'DM'})}});await runChat({...base,memory:false,foundation:{generate:async()=>({text:'tanpa memori'})}});
 clearChatMemory(guildId,userId);release();await first;assert.deepEqual(viewChatMemory(guildId,userId),[]);await runChat({...base,foundation:{generate:async()=>({text:'lanjut'})}});assert.equal(viewChatMemory(guildId,userId).length,1);clearChatMemory(guildId,userId);clearChatMemory(guildId,userId,'dm');
});
