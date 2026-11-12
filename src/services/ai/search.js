const error=(message,status=400)=>Object.assign(new Error(message),{status});
export function createSearchService({client,foundation=client.aiFoundation,env=process.env,fetchImpl=globalThis.fetch}){
 let active=0;
 return {async search({guildId,userId,query,consent}){
  if(guildId!==client.homeGuildId||!/^\d{17,20}$/.test(userId||'')||consent!==true)throw error('Server atau persetujuan tidak valid.',403);
  if(typeof query!=='string'||!query.trim()||query.length>300)throw error('Kata kunci harus 1–300 karakter.');const key=String(env.AI_BRAVE_SEARCH_KEY||'').trim();if(!key)throw error('Kunci Brave Search belum dikonfigurasi.',503);if(active>=2)throw error('Pencarian sedang sibuk.',429);active++;
  try{const cfg=await foundation.store.read(guildId);if(!cfg.enabled||!cfg.providerDataConsent)throw error('Fondasi AI belum aktif atau disetujui.',403);await foundation.store.reserve(guildId,userId,cfg);
   const url=new URL('https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',query);url.searchParams.set('count','5');url.searchParams.set('safesearch','moderate');
   const r=await fetchImpl(url.href,{headers:{Accept:'application/json','X-Subscription-Token':key},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw error('Pencarian tidak tersedia.',503);
   const reader=r.body?.getReader();if(!reader)throw error('Respons pencarian tidak valid.',502);let size=0,chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>524288)throw error('Respons pencarian terlalu besar.',502);chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{})}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw error('Respons pencarian tidak valid.',502)}
   const results=[];for(const item of data?.web?.results||[]){if(results.length>=5)break;try{const u=new URL(item.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)continue;if(typeof item.title!=='string'||typeof item.description!=='string')continue;results.push({title:item.title.slice(0,200),url:u.href,description:item.description.slice(0,500)})}catch{}}
   return {results};
  }catch(e){if(e.status)throw e;throw error('Pencarian tidak tersedia atau timeout.',503)}finally{active--}
 }};
}
