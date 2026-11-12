import test from 'node:test';import assert from 'node:assert/strict';
import {createAudioService} from '../src/services/ai/audio.js';
import {DEFAULT_AI} from '../src/services/ai/foundation.js';
import {DEFAULT_CHAT,runChat} from '../src/services/ai/chat.js';
const guildId='123456789012345678',userId='234567890123456789',channelId='345678901234567890';
const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEdata')]);
const attachment={url:`https://cdn.discordapp.com/attachments/${channelId}/${userId}/voice.wav`,size:wav.length};
const settings={...DEFAULT_AI,enabled:true,providerDataConsent:true,primaryModel:'model'};
function make(){let calls=[],reserved=0;const foundation={store:{read:async()=>settings,reserve:async()=>{reserved++}}};const service=createAudioService({client:{homeGuildId:guildId},foundation,env:{AI_AUDIO_API_KEY:'example-key',AI_AUDIO_MODEL:'gpt-transcribe'},fetchImpl:async(url,opts)=>{calls.push({url,opts});if(url.startsWith('https://cdn.discordapp.com'))return new Response(wav);return new Response(JSON.stringify({text:'Halo komunitas'}));}});return {service,foundation,calls,get reserved(){return reserved}};}
test('audio upload requires consent and fixed Discord and OpenAI endpoints, reserves quota, and bounds output',async()=>{
 const f=make(),base={guildId,userId,attachment,consent:true};await assert.rejects(f.service.transcribe({...base,consent:false}),{status:403});assert.equal(f.calls.length,0);
 await assert.rejects(f.service.transcribe({...base,attachment:{...attachment,url:'https://bad.test/voice.wav'}}));assert.equal(f.reserved,0);assert.equal(f.calls.length,0);
 assert.equal(await f.service.transcribe(base),'Halo komunitas');assert.equal(f.reserved,1);assert.equal(f.calls.length,2);assert.equal(f.calls[1].url,'https://api.openai.com/v1/audio/transcriptions');assert.equal(f.calls[1].opts.redirect,'error');assert.equal(f.calls[1].opts.body.get('model'),'gpt-transcribe');assert.equal(f.calls[1].opts.body.get('file').type,'audio/wav');
 await assert.rejects(f.service.transcribe({...base,attachment:{...attachment,size:2*1024*1024+1}}));assert.equal(f.reserved,1);
});
test('chat audio is disabled by default and sends transcript to model only when opted in',async()=>{
 let transcriptions=0,prompt;const audioService={transcribe:async()=>{transcriptions++;return 'suara contoh'}};const foundation={generate:async x=>{prompt=x.prompt;return {text:'Baik'}}};let cfg={...DEFAULT_CHAT,enabled:true,channelId};
 const request={client:{homeGuildId:guildId},guildId,channelId,userId,question:'Tolong ringkas',consent:true,audioAttachment:attachment,audioService,foundation,store:{read:async()=>cfg}};
 await assert.rejects(runChat(request),{status:403});assert.equal(transcriptions,0);cfg={...cfg,audioEnabled:true};await assert.rejects(runChat({...request,consent:false}),{status:403});assert.equal(transcriptions,0);
 const result=await runChat(request);assert.equal(result.text,'Baik');assert.match(prompt,/suara contoh/);assert.equal(transcriptions,1);await assert.rejects(runChat({...request,attachment:{}}),{status:400});assert.equal(transcriptions,1);
});

test('audio concurrency cap is shared across service instances',async()=>{
 let resume;const wait=new Promise(r=>{resume=r});const foundation={store:{read:async()=>settings,reserve:async()=>{}}};const args={client:{homeGuildId:guildId},foundation,env:{AI_AUDIO_API_KEY:'x',AI_AUDIO_MODEL:'gpt-transcribe'},download:async()=>{await wait;return wav},fetchImpl:async()=>new Response(JSON.stringify({text:'ok'}))};
 const one=createAudioService(args),two=createAudioService(args),call=s=>s.transcribe({guildId,userId,attachment,consent:true});const a=call(one),b=call(two);await assert.rejects(call(one),{status:429});resume();assert.deepEqual(await Promise.all([a,b]),['ok','ok']);
});
