import {resolveSearchProvider} from './extraProviders.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});

async function readJSON(response){
 const reader=response.body?.getReader();if(!reader)throw error('Respons pencarian tidak valid.',502);let size=0,chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>524288)throw error('Respons pencarian terlalu besar.',502);chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{})}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw error('Respons pencarian tidak valid.',502)}
}

// Brave Search: GET with the key in X-Subscription-Token. Items carry title, url and description.
async function brave({key,query,fetchImpl}){
 const url=new URL('https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',query);url.searchParams.set('count','5');url.searchParams.set('safesearch','moderate');
 const r=await fetchImpl(url.href,{headers:{Accept:'application/json','X-Subscription-Token':key},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw error('Pencarian tidak tersedia.',503);
 const data=await readJSON(r);return (data?.web?.results||[]).map(item=>({title:item?.title,url:item?.url,description:item?.description}));
}

// Tavily: POST with a bearer key. Items carry title, url and content; "basic" depth costs one credit.
// Request and response fields follow https://docs.tavily.com/documentation/api-reference/endpoint/search
async function tavily({key,query,fetchImpl}){
 const body=JSON.stringify({query,search_depth:'basic',max_results:5,chunks_per_source:1,safe_search:true,include_answer:false,include_raw_content:false,include_images:false});
 const r=await fetchImpl('https://api.tavily.com/search',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${key}`},body,redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok){
  await r.body?.cancel().catch(()=>{});
  if(r.status===401)throw error('Tavily menolak kunci API. Periksa AI_TAVILY_API_KEY.',502);
  if([429,432,433].includes(r.status))throw error('Batas laju atau kuota Tavily tercapai.',429);
  throw error('Pencarian tidak tersedia.',503);
 }
 const data=await readJSON(r);return (Array.isArray(data?.results)?data.results:[]).map(item=>({title:item?.title,url:item?.url,description:item?.content}));
}

const callers={brave,tavily};

export function createSearchService({client,foundation=client.aiFoundation,env=process.env,fetchImpl=globalThis.fetch}){
 let active=0;
 return {async search({guildId,userId,query,consent}){
  if(guildId!==client.homeGuildId||!/^\d{17,20}$/.test(userId||'')||consent!==true)throw error('Server atau persetujuan tidak valid.',403);
  if(typeof query!=='string'||!query.trim()||query.length>300)throw error('Kata kunci harus 1–300 karakter.');
  // Brave unless AI_SEARCH_PROVIDER names another provider; an unknown name keeps the feature off.
  const provider=resolveSearchProvider(env);
  if(provider.unknown)throw error(`AI_SEARCH_PROVIDER tidak dikenal. Pilihan: ${provider.allowed.join(', ')}.`,503);
  if(provider.missing.length)throw error(`Kunci ${provider.label} belum dikonfigurasi.`,503);
  if(active>=2)throw error('Pencarian sedang sibuk.',429);active++;
  try{const cfg=await foundation.store.read(guildId);if(!cfg.enabled||!cfg.providerDataConsent)throw error('Fondasi AI belum aktif atau disetujui.',403);await foundation.store.reserve(guildId,userId,cfg);
   const items=await callers[provider.id]({key:provider.key,query,fetchImpl});
   // The same filter for every provider: http(s) only, no credentials in the URL, text fields required and cut to size.
   const results=[];for(const item of items){if(results.length>=5)break;try{const u=new URL(item.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)continue;if(typeof item.title!=='string'||typeof item.description!=='string')continue;results.push({title:item.title.slice(0,200),url:u.href,description:item.description.slice(0,500)})}catch{}}
   return {results,provider:provider.label};
  }catch(e){if(e.status)throw e;throw error('Pencarian tidak tersedia atau timeout.',503)}finally{active--}
 }};
}
