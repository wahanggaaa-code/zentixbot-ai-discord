import test from 'node:test';import assert from 'node:assert/strict';import {runTextTool} from '../src/services/ai/tools.js';
const guild='123456789012345678',user='234567890123456789';
test('text tools require consent and valid single-server parameters; review is not web search',async()=>{
 let prompt;const client={homeGuildId:guild},foundation={generate:async x=>{prompt=x.prompt;return {text:'hasil'}}};const args={client,guildId:guild,userId:user,mode:'summary',text:'teks contoh',language:'id',consent:true,foundation};
 await assert.rejects(runTextTool({...args,consent:false}),{status:403});await assert.rejects(runTextTool({...args,mode:'search'}),{status:400});await assert.rejects(runTextTool({...args,text:'x'.repeat(2501)}),{status:400});assert.equal((await runTextTool(args)).text,'hasil');assert.match(prompt,/Ringkas/);await runTextTool({...args,mode:'review'});assert.match(prompt,/tidak memiliki sumber web langsung/);
});

test('web search uses fixed Brave endpoint, filters dangerous URLs, requires consent and counts quota',async()=>{
 const {createSearchService}=await import('../src/services/ai/search.js');let called=0,reserved=0;const client={homeGuildId:guild},foundation={store:{read:async()=>({enabled:true,providerDataConsent:true}),reserve:async()=>{reserved++}}};
 const service=createSearchService({client,foundation,env:{AI_BRAVE_SEARCH_KEY:'secret'},fetchImpl:async(u,o)=>{called++;assert.equal(new URL(u).hostname,'api.search.brave.com');assert.equal(o.redirect,'error');return new Response(JSON.stringify({web:{results:[{title:'Safe',url:'https://example.com/a',description:'Info'},{title:'Bad',url:'javascript:alert(1)',description:'bad'}]}}))}});
 const args={guildId:guild,userId:user,query:'test',consent:true};await assert.rejects(service.search({...args,consent:false}),{status:403});assert.equal(called,0);const r=await service.search(args);assert.equal(reserved,1);assert.equal(r.results.length,1);assert.equal(r.results[0].url,'https://example.com/a');
});
