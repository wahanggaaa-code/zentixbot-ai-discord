// Alternative providers for speech-to-text (Groq), web search (Tavily) and images (Cloudflare Workers AI,
// Pollinations). Every provider here is a fake `fetch`: these tests prove which request the bot builds and
// how it reads an answer, not that the real services accept it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import {createCanvas} from '@napi-rs/canvas';
import {createAudioService} from '../src/services/ai/audio.js';
import {createSearchService} from '../src/services/ai/search.js';
import {createImageService} from '../src/services/ai/images.js';
import {research} from '../src/services/ai/research.js';
import {createAIApi} from '../src/dashboard/aiApi.js';
import {DEFAULT_AI} from '../src/services/ai/foundation.js';
import {resolveAudioProvider,resolveSearchProvider,resolveImageProvider,describeExtraProviders,CLOUDFLARE_DEFAULT_IMAGE_MODEL,EXTRA_PROVIDER_CHOICES} from '../src/services/ai/extraProviders.js';

const guildId='123456789012345678',userId='234567890123456789',channelId='345678901234567890';
const account='0123456789abcdef0123456789abcdef';
const settings={...DEFAULT_AI,enabled:true,providerDataConsent:true,primaryModel:'model'};
const wav=Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4),Buffer.from('WAVEdata')]);
const attachment={url:`https://cdn.discordapp.com/attachments/${channelId}/${userId}/voice.wav`,size:wav.length};
const pngSample='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8ioAAAAASUVORK5CYII=';

function jpeg(width,height){const canvas=createCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle='#b5651d';ctx.fillRect(0,0,width,height);return canvas.toBuffer('image/jpeg');}
function foundationStub(config=settings){const state={reserved:0};return {state,store:{read:async()=>config,reserve:async()=>{state.reserved++}}};}
const header=(opts,name)=>new Headers(opts.headers).get(name);

test('provider choice: empty keeps the original provider, names are case-insensitive, unknown names are refused',()=>{
 assert.deepEqual(EXTRA_PROVIDER_CHOICES,{AI_AUDIO_PROVIDER:['openai','groq'],AI_SEARCH_PROVIDER:['brave','tavily'],AI_IMAGE_PROVIDER:['openai','cloudflare','pollinations']});
 assert.equal(resolveAudioProvider({}).id,'openai');assert.equal(resolveSearchProvider({}).id,'brave');assert.equal(resolveImageProvider({}).id,'openai');
 assert.equal(resolveAudioProvider({AI_AUDIO_PROVIDER:'  '}).id,'openai');
 assert.equal(resolveAudioProvider({AI_AUDIO_PROVIDER:' Groq '}).id,'groq');
 assert.equal(resolveSearchProvider({AI_SEARCH_PROVIDER:'TAVILY'}).id,'tavily');
 assert.equal(resolveImageProvider({AI_IMAGE_PROVIDER:'Cloudflare'}).id,'cloudflare');
 for(const [resolve,variable] of [[resolveAudioProvider,'AI_AUDIO_PROVIDER'],[resolveSearchProvider,'AI_SEARCH_PROVIDER'],[resolveImageProvider,'AI_IMAGE_PROVIDER']]){
  for(const name of ['whisper','constructor','__proto__','toString']){const p=resolve({[variable]:name});assert.equal(p.unknown,true,`${variable}=${name}`);assert.equal(p.variable,variable);}
 }
});

test('provider choice: each provider reads only its own key, and reports what is missing',()=>{
 // Groq never takes the OpenAI audio key, and OpenAI never takes the Groq key.
 const groq=resolveAudioProvider({AI_AUDIO_PROVIDER:'groq',AI_AUDIO_API_KEY:'openai-key'});
 assert.equal(groq.key,'');assert.deepEqual(groq.missing,['AI_GROQ_API_KEY']);assert.equal(groq.model,'whisper-large-v3-turbo');
 const openai=resolveAudioProvider({AI_GROQ_API_KEY:'groq-key'});
 assert.equal(openai.key,'');assert.deepEqual(openai.missing,['AI_AUDIO_API_KEY','AI_AUDIO_MODEL']);
 assert.deepEqual(resolveAudioProvider({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:' k '}).missing,[]);
 assert.equal(resolveAudioProvider({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:'k'}).key,'k');
 assert.equal(resolveAudioProvider({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:'k',AI_AUDIO_MODEL:'whisper-large-v3'}).model,'whisper-large-v3');
 assert.deepEqual(resolveAudioProvider({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:'k',AI_AUDIO_MODEL:'bad model'}).missing,['AI_AUDIO_MODEL']);

 assert.deepEqual(resolveSearchProvider({AI_SEARCH_PROVIDER:'tavily',AI_BRAVE_SEARCH_KEY:'brave'}).missing,['AI_TAVILY_API_KEY']);
 assert.deepEqual(resolveSearchProvider({AI_TAVILY_API_KEY:'tavily'}).missing,['AI_BRAVE_SEARCH_KEY']);
 assert.equal(resolveSearchProvider({AI_SEARCH_PROVIDER:'tavily',AI_TAVILY_API_KEY:'t',AI_BRAVE_SEARCH_KEY:'b'}).key,'t');

 const cf=resolveImageProvider({AI_IMAGE_PROVIDER:'cloudflare',AI_IMAGE_API_KEY:'openai-key'});
 assert.equal(cf.key,'');assert.deepEqual(cf.missing,['AI_CLOUDFLARE_API_TOKEN','AI_CLOUDFLARE_ACCOUNT_ID']);assert.equal(cf.model,CLOUDFLARE_DEFAULT_IMAGE_MODEL);assert.equal(cf.canEdit,false);
 const ready={AI_IMAGE_PROVIDER:'cloudflare',AI_CLOUDFLARE_API_TOKEN:'token',AI_CLOUDFLARE_ACCOUNT_ID:account.toUpperCase()};
 assert.deepEqual(resolveImageProvider(ready).missing,[]);assert.equal(resolveImageProvider(ready).accountId,account);
 for(const bad of ['abc',account+'0',account.slice(1)+'g',`${account}/x`])assert.deepEqual(resolveImageProvider({...ready,AI_CLOUDFLARE_ACCOUNT_ID:bad}).missing,['AI_CLOUDFLARE_ACCOUNT_ID'],bad);
 // The model is put into the request path: only "@cf/<vendor>/<model>" passes.
 for(const bad of ['gpt-image-1','@cf/x','@cf/../x','@cf/a/b/c','@cf/a/b?x=1','@hf/a/b','@cf/a/..','@cf/A/b'])assert.deepEqual(resolveImageProvider({...ready,AI_IMAGE_MODEL:bad}).missing,['AI_IMAGE_MODEL'],bad);
 assert.deepEqual(resolveImageProvider({...ready,AI_IMAGE_MODEL:'@cf/leonardo/phoenix-1.0'}).missing,[]);
 const pol=resolveImageProvider({AI_IMAGE_PROVIDER:'pollinations'});assert.deepEqual(pol.missing,[]);assert.equal(pol.canEdit,false);assert.equal(pol.key,'');
 assert.equal(resolveImageProvider({AI_IMAGE_API_KEY:'k',AI_IMAGE_MODEL:'m'}).canEdit,true);
});

test('startup lines name the provider, the missing variables and an unknown choice, and never a key',()=>{
 const off=describeExtraProviders({});
 assert.deepEqual(off.map(l=>l.level),['info','info','info']);
 assert.equal(off[0].text,'AI speech-to-text: OpenAI off (missing or invalid: AI_AUDIO_API_KEY, AI_AUDIO_MODEL)');
 assert.equal(off[1].text,'AI web search: Brave Search off (missing or invalid: AI_BRAVE_SEARCH_KEY)');
 assert.equal(off[2].text,'AI images: OpenAI off (missing or invalid: AI_IMAGE_API_KEY, AI_IMAGE_MODEL)');
 const on=describeExtraProviders({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:'SECRET-ONE',AI_SEARCH_PROVIDER:'tavily',AI_TAVILY_API_KEY:'SECRET-TWO',AI_IMAGE_PROVIDER:'pollinations'});
 assert.deepEqual(on.map(l=>l.text),['AI speech-to-text: Groq configured (whisper-large-v3-turbo)','AI web search: Tavily configured','AI images: Pollinations configured']);
 assert.doesNotMatch(JSON.stringify(on),/SECRET/);
 const wrong=describeExtraProviders({AI_IMAGE_PROVIDER:'dalle'});
 assert.equal(wrong[2].level,'warn');assert.equal(wrong[2].text,'AI_IMAGE_PROVIDER="dalle" is not recognised (use openai, cloudflare, pollinations); images stays off.');
});

function audio(env){
 const calls=[],foundation=foundationStub();
 const service=createAudioService({client:{homeGuildId:guildId},foundation,env,fetchImpl:async(url,opts)=>{calls.push({url,opts});if(url.startsWith('https://cdn.discordapp.com'))return new Response(wav);return new Response(JSON.stringify({text:' Halo dari Groq '}));}});
 return {service,calls,foundation,run:()=>service.transcribe({guildId,userId,attachment,consent:true})};
}

test('speech-to-text with Groq: fixed Groq address, the Groq key only, default model, same request shape',async()=>{
 const f=audio({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:'groq-key',AI_AUDIO_API_KEY:'openai-key'});
 assert.equal(await f.run(),'Halo dari Groq');
 assert.equal(f.foundation.state.reserved,1);assert.equal(f.calls.length,2);
 const call=f.calls[1];
 assert.equal(call.url,'https://api.groq.com/openai/v1/audio/transcriptions');
 assert.equal(call.opts.method,'POST');assert.equal(call.opts.redirect,'error');
 assert.equal(header(call.opts,'authorization'),'Bearer groq-key');
 assert.equal(call.opts.body.get('model'),'whisper-large-v3-turbo');
 assert.equal(call.opts.body.get('file').type,'audio/wav');
 const other=audio({AI_AUDIO_PROVIDER:'groq',AI_GROQ_API_KEY:'groq-key',AI_AUDIO_MODEL:'whisper-large-v3'});
 await other.run();assert.equal(other.calls[1].opts.body.get('model'),'whisper-large-v3');
});

test('speech-to-text stays on OpenAI when no provider is named, even with a Groq key present',async()=>{
 const f=audio({AI_AUDIO_API_KEY:'openai-key',AI_AUDIO_MODEL:'gpt-transcribe',AI_GROQ_API_KEY:'groq-key'});
 await f.run();
 assert.equal(f.calls[1].url,'https://api.openai.com/v1/audio/transcriptions');
 assert.equal(header(f.calls[1].opts,'authorization'),'Bearer openai-key');
 assert.equal(f.calls[1].opts.body.get('model'),'gpt-transcribe');
});

test('speech-to-text refuses before any download or quota use when the choice is unknown or the key is missing',async()=>{
 for(const env of [{AI_AUDIO_PROVIDER:'groq',AI_AUDIO_API_KEY:'openai-key',AI_AUDIO_MODEL:'gpt-transcribe'},{AI_AUDIO_PROVIDER:'deepgram',AI_AUDIO_API_KEY:'openai-key',AI_AUDIO_MODEL:'gpt-transcribe',AI_GROQ_API_KEY:'groq-key'},{AI_GROQ_API_KEY:'groq-key'}]){
  const f=audio(env);
  await assert.rejects(f.run(),{status:503,message:'Kredensial/model audio belum dikonfigurasi.'});
  assert.equal(f.calls.length,0);assert.equal(f.foundation.state.reserved,0);
 }
});

function searcher(env,respond){
 const calls=[],foundation=foundationStub();
 const service=createSearchService({client:{homeGuildId:guildId},foundation,env,fetchImpl:async(url,opts)=>{calls.push({url,opts});return respond(url,opts);}});
 return {service,calls,foundation,run:(query='gunung gede')=>service.search({guildId,userId,query,consent:true})};
}
const tavilyAnswer={query:'gunung gede',answer:null,images:[],response_time:1.2,results:[
 {title:'Aman',url:'https://example.com/a',content:'Isi cuplikan',score:0.9,raw_content:null},
 {title:'Skrip',url:'javascript:alert(1)',content:'buruk'},
 {title:'Kredensial',url:'https://user:pass@example.com/',content:'buruk'},
 {title:'Tanpa cuplikan',url:'https://example.com/b',content:null},
 {title:42,url:'https://example.com/c',content:'judul bukan teks'},
 {title:'T'.repeat(300),url:'http://example.org/panjang',content:'c'.repeat(900)},
 {title:'Tiga',url:'https://example.com/3',content:'x'},{title:'Empat',url:'https://example.com/4',content:'x'},{title:'Lima',url:'https://example.com/5',content:'x'},{title:'Enam',url:'https://example.com/6',content:'x'}
]};

test('web search with Tavily: fixed address, bearer key, one-credit request, and the same result filter as Brave',async()=>{
 const f=searcher({AI_SEARCH_PROVIDER:'tavily',AI_TAVILY_API_KEY:'tvly-key',AI_BRAVE_SEARCH_KEY:'brave-key'},()=>new Response(JSON.stringify(tavilyAnswer)));
 const r=await f.run();
 assert.equal(f.calls.length,1);assert.equal(f.foundation.state.reserved,1);
 const {url,opts}=f.calls[0];
 assert.equal(url,'https://api.tavily.com/search');assert.equal(opts.method,'POST');assert.equal(opts.redirect,'error');
 assert.equal(header(opts,'authorization'),'Bearer tvly-key');assert.equal(header(opts,'content-type'),'application/json');
 assert.equal(header(opts,'x-subscription-token'),null);assert.doesNotMatch(JSON.stringify(opts),/brave-key/);
 assert.deepEqual(JSON.parse(opts.body),{query:'gunung gede',search_depth:'basic',max_results:5,chunks_per_source:1,safe_search:true,include_answer:false,include_raw_content:false,include_images:false});
 assert.equal(r.provider,'Tavily');
 assert.deepEqual(r.results.map(x=>x.url),['https://example.com/a','http://example.org/panjang','https://example.com/3','https://example.com/4','https://example.com/5']);
 assert.deepEqual(r.results[0],{title:'Aman',url:'https://example.com/a',description:'Isi cuplikan'});
 assert.equal(r.results[1].title.length,200);assert.equal(r.results[1].description.length,500);
});

test('web search with Tavily: provider errors become clear messages; missing key and unknown choice send nothing',async()=>{
 const env={AI_SEARCH_PROVIDER:'tavily',AI_TAVILY_API_KEY:'tvly-key'};
 const status=code=>searcher(env,()=>new Response('{"detail":{"error":"x"}}',{status:code})).run();
 await assert.rejects(status(401),{status:502,message:/AI_TAVILY_API_KEY/});
 for(const code of [429,432,433])await assert.rejects(status(code),{status:429,message:/kuota Tavily/});
 await assert.rejects(status(500),{status:503});
 await assert.rejects(searcher(env,()=>new Response('not json')).run(),{status:502});
 await assert.rejects(searcher(env,()=>{throw new TypeError('network')}).run(),{status:503});
 assert.deepEqual((await searcher(env,()=>new Response(JSON.stringify({results:'none'}))).run()).results,[]);
 for(const [bad,message] of [[{AI_SEARCH_PROVIDER:'tavily',AI_BRAVE_SEARCH_KEY:'brave-key'},'Kunci Tavily belum dikonfigurasi.'],[{AI_SEARCH_PROVIDER:'google',AI_BRAVE_SEARCH_KEY:'brave-key',AI_TAVILY_API_KEY:'t'},'AI_SEARCH_PROVIDER tidak dikenal. Pilihan: brave, tavily.'],[{AI_TAVILY_API_KEY:'t'},'Kunci Brave Search belum dikonfigurasi.']]){
  const f=searcher(bad,()=>new Response('{}'));
  await assert.rejects(f.run(),{status:503,message});assert.equal(f.calls.length,0);assert.equal(f.foundation.state.reserved,0);
 }
});

test('web search stays on Brave when no provider is named, and research works on Tavily results',async()=>{
 const brave=searcher({AI_BRAVE_SEARCH_KEY:'brave-key',AI_TAVILY_API_KEY:'tvly-key'},()=>new Response(JSON.stringify({web:{results:[{title:'B',url:'https://example.com/b',description:'dari brave'}]}})));
 const r=await brave.run();
 assert.equal(new URL(brave.calls[0].url).origin,'https://api.search.brave.com');
 assert.equal(header(brave.calls[0].opts,'x-subscription-token'),'brave-key');assert.equal(header(brave.calls[0].opts,'authorization'),null);
 assert.deepEqual(r,{results:[{title:'B',url:'https://example.com/b',description:'dari brave'}],provider:'Brave Search'});

 const tavily=searcher({AI_SEARCH_PROVIDER:'tavily',AI_TAVILY_API_KEY:'tvly-key'},()=>new Response(JSON.stringify(tavilyAnswer)));
 let prompt;const out=await research({client:{homeGuildId:guildId},guildId,userId,query:'gunung gede',consent:true,searchService:tavily.service,foundation:{generate:async x=>{prompt=x.prompt;return {text:'Tinjauan [1]',usedFallback:false}}}});
 assert.match(prompt,/Isi cuplikan/);assert.equal(out.sources.length,3);assert.equal(out.sources[0].url,'https://example.com/a');
});

function painter(env,respond,config){
 const calls=[],foundation=foundationStub(config);
 const service=createImageService({client:{homeGuildId:guildId},foundation,env,seed:()=>4242,fetchImpl:async(url,opts)=>{calls.push({url,opts});return respond(url,opts);}});
 const base={guildId,userId,prompt:'Seekor burung',mode:'create',imageBase64:null,consent:true};
 return {service,calls,foundation,run:(extra={})=>service.generate({...base,...extra})};
}
const cloudflareEnv={AI_IMAGE_PROVIDER:'cloudflare',AI_CLOUDFLARE_API_TOKEN:'cf-token',AI_CLOUDFLARE_ACCOUNT_ID:account,AI_IMAGE_API_KEY:'openai-key'};
const cloudflareJSON=bytes=>new Response(JSON.stringify({result:{image:bytes.toString('base64')},success:true,errors:[],messages:[]}),{headers:{'content-type':'application/json'}});

test('images with Cloudflare: fixed address with account and model, the Cloudflare token only, JPEG read from result.image',async()=>{
 const picture=jpeg(1024,1024),f=painter(cloudflareEnv,()=>cloudflareJSON(picture));
 const r=await f.run({style:'pixel'});
 assert.equal(f.calls.length,1);assert.equal(f.foundation.state.reserved,1);
 const {url,opts}=f.calls[0];
 assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`);
 assert.equal(opts.method,'POST');assert.equal(opts.redirect,'error');
 assert.equal(header(opts,'authorization'),'Bearer cf-token');assert.doesNotMatch(JSON.stringify(opts),/openai-key/);
 assert.deepEqual(JSON.parse(opts.body),{prompt:'Pixel art style. Seekor burung'});
 assert.deepEqual(r,{imageBase64:picture.toString('base64'),mime:'image/jpeg',provider:'Cloudflare Workers AI',width:1024,height:1024});
});

test('images with Cloudflare: an unrequested size is reported, a picture body and a chosen model are accepted',async()=>{
 const wide=await painter(cloudflareEnv,()=>cloudflareJSON(jpeg(1024,1024))).run({size:'1536x1024'});
 assert.equal(wide.note,'Provider mengembalikan 1024×1024, bukan 1536×1024 yang diminta.');assert.equal(wide.width,1024);
 const f=painter({...cloudflareEnv,AI_IMAGE_MODEL:'@cf/leonardo/phoenix-1.0'},()=>new Response(Buffer.from(pngSample,'base64'),{headers:{'content-type':'image/png'}}));
 const r=await f.run();
 assert.equal(f.calls[0].url,`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/leonardo/phoenix-1.0`);
 assert.equal(r.mime,'image/png');assert.equal(r.imageBase64,pngSample);assert.equal(r.width,1);assert.equal(r.height,1);assert.match(r.note,/1×1/);
 const flat=await painter(cloudflareEnv,()=>new Response(JSON.stringify({image:jpeg(1024,1024).toString('base64')}))).run();
 assert.equal(flat.mime,'image/jpeg');assert.equal(flat.note,undefined);
});

test('images with Cloudflare: bad answers and provider errors are refused with a status the dashboard can show',async()=>{
 const answer=respond=>painter(cloudflareEnv,respond).run();
 await assert.rejects(answer(()=>new Response('{}',{status:401})),{status:502,message:/AI_CLOUDFLARE_API_TOKEN/});
 await assert.rejects(answer(()=>new Response('{}',{status:403})),{status:502,message:/AI_CLOUDFLARE_ACCOUNT_ID/});
 await assert.rejects(answer(()=>new Response('{}',{status:429})),{status:429,message:/jatah harian/});
 await assert.rejects(answer(()=>new Response('{}',{status:500})),{status:502});
 await assert.rejects(answer(()=>{throw new TypeError('network')}),{status:503});
 const invalid={status:502,message:'Provider gambar mengembalikan gambar yang tidak valid atau terlalu besar.'};
 await assert.rejects(answer(()=>new Response(JSON.stringify({result:{}}))),invalid);
 await assert.rejects(answer(()=>new Response(JSON.stringify({result:{image:'not base64!'}}))),invalid);
 await assert.rejects(answer(()=>cloudflareJSON(Buffer.from('GIF89a'+'x'.repeat(60)))),invalid);
 await assert.rejects(answer(()=>cloudflareJSON(jpeg(1024,1024).subarray(0,120))),invalid,'a JPEG cut before its frame header');
 const noStart=Buffer.from(jpeg(64,64));noStart[0]=0x58;noStart[1]=0x58;
 await assert.rejects(answer(()=>cloudflareJSON(noStart)),invalid,'JPEG segments without the JPEG start marker');
 await assert.rejects(answer(()=>new Response(JSON.stringify({result:{image:''}}))),invalid);
 await assert.rejects(answer(()=>cloudflareJSON(jpeg(2049,8))),invalid,'wider than 2048');
 await assert.rejects(answer(()=>cloudflareJSON(jpeg(8,2049))),invalid,'taller than 2048');
 assert.equal((await answer(()=>cloudflareJSON(jpeg(2048,16)))).width,2048);
 await assert.rejects(answer(()=>new Response('<html>',{headers:{'content-type':'text/html'}})),{status:502});
});

test('images: edit is OpenAI only, and a bad choice or missing value stops before any request or quota use',async()=>{
 const refused=[
  [{...cloudflareEnv},{mode:'edit',imageBase64:pngSample},400,'Edit gambar hanya tersedia dengan provider OpenAI. Provider aktif: Cloudflare Workers AI.'],
  [{AI_IMAGE_PROVIDER:'pollinations'},{mode:'edit',imageBase64:pngSample},400,'Edit gambar hanya tersedia dengan provider OpenAI. Provider aktif: Pollinations.'],
  [{AI_IMAGE_PROVIDER:'cloudflare',AI_IMAGE_API_KEY:'openai-key',AI_IMAGE_MODEL:'gpt-image-1'},{},503,'Provider gambar atau model belum dikonfigurasi (Cloudflare Workers AI: AI_CLOUDFLARE_API_TOKEN, AI_CLOUDFLARE_ACCOUNT_ID, AI_IMAGE_MODEL).'],
  [{AI_IMAGE_PROVIDER:'midjourney',AI_IMAGE_API_KEY:'k',AI_IMAGE_MODEL:'m'},{},503,'AI_IMAGE_PROVIDER tidak dikenal. Pilihan: openai, cloudflare, pollinations.'],
  [{AI_CLOUDFLARE_API_TOKEN:'cf-token',AI_CLOUDFLARE_ACCOUNT_ID:account},{},503,'Provider gambar atau model belum dikonfigurasi (OpenAI: AI_IMAGE_API_KEY, AI_IMAGE_MODEL).']
 ];
 for(const [env,extra,status,message] of refused){
  const f=painter(env,()=>cloudflareJSON(jpeg(64,64)));
  await assert.rejects(f.run(extra),{status,message});assert.equal(f.calls.length,0,message);assert.equal(f.foundation.state.reserved,0,message);
 }
 const disabled=painter(cloudflareEnv,()=>cloudflareJSON(jpeg(64,64)),{...settings,enabled:false});
 await assert.rejects(disabled.run(),{status:403});assert.equal(disabled.calls.length,0);
});

test('images with OpenAI are unchanged: same addresses, key, body and PNG check; the answer now also names the provider',async()=>{
 const f=painter({AI_IMAGE_API_KEY:'openai-key',AI_IMAGE_MODEL:'gpt-image-1',AI_CLOUDFLARE_API_TOKEN:'cf-token',AI_CLOUDFLARE_ACCOUNT_ID:account},()=>new Response(JSON.stringify({data:[{b64_json:pngSample}]})));
 const r=await f.run({size:'1024x1536'});
 assert.equal(f.calls[0].url,'https://api.openai.com/v1/images/generations');
 assert.equal(header(f.calls[0].opts,'authorization'),'Bearer openai-key');assert.doesNotMatch(JSON.stringify(f.calls[0].opts),/cf-token/);
 assert.deepEqual(JSON.parse(f.calls[0].opts.body),{model:'gpt-image-1',prompt:'Seekor burung',n:1,size:'1024x1536',output_format:'png'});
 assert.deepEqual(r,{imageBase64:pngSample,mime:'image/png',provider:'OpenAI',width:1,height:1,note:'Provider mengembalikan 1×1, bukan 1024×1536 yang diminta.'});
 await f.run({mode:'edit',imageBase64:pngSample});
 assert.equal(f.calls[1].url,'https://api.openai.com/v1/images/edits');assert.equal(f.calls[1].opts.body.get('model'),'gpt-image-1');
 // OpenAI must still answer with a PNG: a JPEG there is refused as before.
 const wrong=painter({AI_IMAGE_API_KEY:'k',AI_IMAGE_MODEL:'m'},()=>new Response(JSON.stringify({data:[{b64_json:jpeg(64,64).toString('base64')}]})));
 await assert.rejects(wrong.run(),{status:400,message:/PNG/});
});

test('images with Pollinations: no key, prompt in the path, size scaled to the 768 × 768 limit, seed and safe filter set',async()=>{
 const sizes={'1024x1024':[768,768],'1536x1024':[940,627],'1024x1536':[627,940]};
 for(const [size,[width,height]] of Object.entries(sizes)){
  assert.ok(width*height<=768*768,`${size} stays inside the documented area`);
  const picture=jpeg(width,height),f=painter({AI_IMAGE_PROVIDER:'pollinations',AI_IMAGE_API_KEY:'openai-key',AI_CLOUDFLARE_API_TOKEN:'cf-token'},()=>new Response(picture,{headers:{'content-type':'image/jpeg'}}));
  const r=await f.run({size,prompt:'Kucing & anjing/100% lucu?',style:'photo'});
  const url=new URL(f.calls[0].url);
  assert.equal(url.origin,'https://image.pollinations.ai');
  assert.equal(url.pathname,'/prompt/'+encodeURIComponent('Photorealistic photography style. Kucing & anjing/100% lucu?'));
  assert.deepEqual(Object.fromEntries(url.searchParams),{width:String(width),height:String(height),seed:'4242',safe:'true'});
  const opts=f.calls[0].opts;
  assert.equal(opts.method??'GET','GET');assert.equal(opts.redirect,'error');assert.equal(opts.body,undefined);
  assert.equal(header(opts,'authorization'),null);assert.doesNotMatch(JSON.stringify(opts)+f.calls[0].url,/openai-key|cf-token/);
  assert.equal(r.mime,'image/jpeg');assert.equal(r.provider,'Pollinations');assert.equal(r.width,width);assert.equal(r.height,height);assert.equal(r.imageBase64,picture.toString('base64'));
  assert.equal(r.note,`Provider mengembalikan ${width}×${height}, bukan ${size.replace('x','×')} yang diminta.`);
 }
});

test('images with Pollinations: the free limit answers 402 and becomes a wait message; other failures are refused',async()=>{
 const env={AI_IMAGE_PROVIDER:'pollinations'},answer=respond=>painter(env,respond).run();
 await assert.rejects(answer(()=>new Response('{"error":"limit"}',{status:402,headers:{'retry-after':'37'}})),{status:429,message:'Batas gratis Pollinations per alamat IP tercapai. Coba lagi dalam 37 detik.'});
 await assert.rejects(answer(()=>new Response('',{status:402})),{status:429,message:'Batas gratis Pollinations per alamat IP tercapai. Coba lagi nanti.'});
 await assert.rejects(answer(()=>new Response('',{status:429,headers:{'retry-after':'soon'}})),{status:429,message:/Coba lagi nanti\.$/});
 await assert.rejects(answer(()=>new Response('',{status:500})),{status:502});
 await assert.rejects(answer(()=>new Response('<html>limit card</html>')),{status:502});
 await assert.rejects(painter(env,()=>new Response(jpeg(64,64))).run({prompt:'..'}),{status:400});
 const seeds=new Set();
 for(let i=0;i<3;i++){const calls=[];const service=createImageService({client:{homeGuildId:guildId},foundation:foundationStub(),env,fetchImpl:async url=>{calls.push(url);return new Response(jpeg(768,768))}});await service.generate({guildId,userId,prompt:'x',mode:'create',imageBase64:null,consent:true});const seed=Number(new URL(calls[0]).searchParams.get('seed'));assert.ok(Number.isInteger(seed)&&seed>=1&&seed<2147483647);seeds.add(seed);}
 assert.ok(seeds.size>1,'the default seed changes between requests');
});

test('dashboard routes pass the provider name, size and note through to the browser',async t=>{
 const client={homeGuildId:guildId};
 const image=createImageService({client,foundation:foundationStub(),env:cloudflareEnv,fetchImpl:async()=>cloudflareJSON(jpeg(1024,1024))});
 const search=createSearchService({client,foundation:foundationStub(),env:{AI_SEARCH_PROVIDER:'tavily',AI_TAVILY_API_KEY:'t'},fetchImpl:async()=>new Response(JSON.stringify(tavilyAnswer))});
 const auth=(req,res,next)=>{req.session={user:{id:userId}};req.guild={id:guildId};next()},csrf=(req,res,next)=>next();
 const app=express();app.use('/ai',createAIApi(client,{auth,csrf,env:{OWNER_IDS:userId},foundation:foundationStub(),imageService:image,searchService:search}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const post=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/ai/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
 const made=await post('image',{confirmed:true,mode:'create',prompt:'burung',imageBase64:null,size:'1024x1536',style:'default'});
 assert.equal(made.status,200);assert.equal(made.body.mime,'image/jpeg');assert.equal(made.body.provider,'Cloudflare Workers AI');assert.equal(made.body.width,1024);assert.match(made.body.note,/1024×1536/);
 const edit=await post('image',{confirmed:true,mode:'edit',prompt:'burung',imageBase64:pngSample});
 assert.equal(edit.status,400);assert.match(edit.body.error,/hanya tersedia dengan provider OpenAI/);
 const found=await post('search',{confirmed:true,query:'gunung gede'});
 assert.equal(found.status,200);assert.equal(found.body.provider,'Tavily');assert.equal(found.body.results.length,5);
});

async function page(script,t){
 const {JSDOM}=await import('jsdom');
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/dashboard/',runScripts:'outside-only'}),w=dom.window;t.after(()=>w.close());
 w.ZentixSession=Promise.resolve({csrf:'token'});w.confirm=()=>true;
 w.eval(fs.readFileSync('dashboard-preview/'+script,'utf8'));
 return {w,root:w.document.querySelector('#root'),settle:()=>new Promise(r=>setTimeout(r,25))};
}

test('image page shows a JPEG answer, offers it as .jpg, and prints provider, size and note; other types are refused',async t=>{
 const {w,root,settle}=await page('ai-images-live.js',t);
 const picture=jpeg(64,48).toString('base64');let answer={ok:true,imageBase64:picture,mime:'image/jpeg',provider:'Pollinations',width:64,height:48,note:'Provider mengembalikan 64×48, bukan 1024×1024 yang diminta.'},sent;
 w.fetch=async(url,opts)=>{sent=JSON.parse(opts.body);return {ok:true,json:async()=>answer}};
 root.innerHTML=w.ZentixAIImages.render('create');w.ZentixAIImages.bind(root,'create');
 assert.match(root.textContent,/AI_IMAGE_PROVIDER/);assert.doesNotMatch(root.textContent,/Edit hanya tersedia dengan OpenAI/);
 const form=root.querySelector('#aiImageForm'),submit=async()=>{form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle()};
 form.elements.prompt.value='burung';await submit();
 assert.deepEqual(sent,{mode:'create',prompt:'burung',imageBase64:null,size:'1024x1024',style:'default',confirmed:true});
 const img=root.querySelector('#aiImageResult'),download=root.querySelector('#aiImageDownload'),status=root.querySelector('#aiImageStatus');
 assert.equal(img.hidden,false);assert.equal(img.src,'data:image/jpeg;base64,'+picture);
 assert.equal(download.hidden,false);assert.equal(download.download,'zentix-ai.jpg');assert.equal(download.href,img.src);
 assert.equal(status.textContent,'Gambar selesai. Provider: Pollinations. 64×48 piksel. Provider mengembalikan 64×48, bukan 1024×1024 yang diminta.');
 answer={ok:true,imageBase64:pngSample,mime:'image/png'};await submit();
 assert.equal(img.src,'data:image/png;base64,'+pngSample);assert.equal(download.download,'zentix-ai.png');assert.equal(status.textContent,'Gambar selesai.');
 answer={ok:true,imageBase64:'PHN2Zz4=',mime:'image/svg+xml'};await submit();
 assert.equal(img.hidden,true);assert.equal(download.hidden,true);assert.equal(status.textContent,'Hasil gambar tidak valid.');
 root.innerHTML=w.ZentixAIImages.render('edit');assert.match(root.textContent,/Edit hanya tersedia dengan OpenAI/);
});

test('search page names both providers before sending and prints where the results came from',async t=>{
 const {w,root,settle}=await page('ai-search-live.js',t);
 let asked;w.confirm=text=>{asked=text;return true};
 let answer={ok:true,provider:'Tavily',results:[{title:'Aman',url:'https://example.com/a',description:'Isi'}]};
 w.fetch=async()=>({ok:true,json:async()=>answer});
 root.innerHTML=w.ZentixAISearch.render();w.ZentixAISearch.bind(root);
 assert.match(root.textContent,/AI_SEARCH_PROVIDER=tavily bersama AI_TAVILY_API_KEY/);
 const form=root.querySelector('#aiSearchForm'),submit=async()=>{form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle()};
 form.elements.query.value='gunung gede';await submit();
 assert.match(asked,/Brave Search atau Tavily/);
 const out=root.querySelector('#aiSearchResults');
 assert.equal(out.querySelector('a').href,'https://example.com/a');assert.match(out.textContent,/Sumber hasil: Tavily\.$/);
 answer={ok:true,provider:'<img src=x onerror=alert(1)>',results:[{title:'Aman',url:'https://example.com/a',description:'Isi'}]};await submit();
 assert.equal(out.querySelector('img'),null,'the provider name is written as text, never as HTML');
 answer={ok:true,provider:'Tavily',results:[]};await submit();
 assert.equal(out.textContent,'Tidak ada hasil.');
});

test('the /aichat audio option names both transcription providers within Discord\'s 100-character limit',()=>{
 const source=fs.readFileSync('src/commands/AI/aichat.js','utf8'),text=source.match(/setName\('audio'\)\.setDescription\('([^']+)'\)/)[1];
 assert.equal(text,'Optional audio up to 2 MB; sent to OpenAI or Groq for transcription.');assert.ok(text.length<=100);
});
