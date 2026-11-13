// Which outside service handles speech-to-text, web search and image generation.
// Each feature is chosen with its own environment variable. An empty variable keeps the original
// provider (OpenAI for speech and images, Brave for search), so existing setups do not change.
// Every provider reads its key from its own variable: a key is never sent to another provider.
const clean=value=>String(value??'').trim();

const AUDIO=Object.freeze({
 openai:{label:'OpenAI',url:'https://api.openai.com/v1/audio/transcriptions',keyVariable:'AI_AUDIO_API_KEY',defaultModel:''},
 groq:{label:'Groq',url:'https://api.groq.com/openai/v1/audio/transcriptions',keyVariable:'AI_GROQ_API_KEY',defaultModel:'whisper-large-v3-turbo'}
});
const SEARCH=Object.freeze({
 brave:{label:'Brave Search',keyVariable:'AI_BRAVE_SEARCH_KEY'},
 tavily:{label:'Tavily',keyVariable:'AI_TAVILY_API_KEY'}
});
const IMAGE=Object.freeze({
 openai:{label:'OpenAI',canEdit:true},
 cloudflare:{label:'Cloudflare Workers AI',canEdit:false},
 pollinations:{label:'Pollinations',canEdit:false}
});
export const CLOUDFLARE_DEFAULT_IMAGE_MODEL='@cf/black-forest-labs/flux-1-schnell';
export const EXTRA_PROVIDER_CHOICES=Object.freeze({AI_AUDIO_PROVIDER:Object.keys(AUDIO),AI_SEARCH_PROVIDER:Object.keys(SEARCH),AI_IMAGE_PROVIDER:Object.keys(IMAGE)});

function choose(env,variable,table,fallback){
 const id=clean(env[variable]).toLowerCase()||fallback;
 if(!Object.hasOwn(table,id))return {id:id.slice(0,40),unknown:true,variable,allowed:Object.keys(table),missing:[]};
 return {id,variable,...table[id]};
}

export function resolveAudioProvider(env=process.env){
 const provider=choose(env,'AI_AUDIO_PROVIDER',AUDIO,'openai');if(provider.unknown)return provider;
 const key=clean(env[provider.keyVariable]),model=clean(env.AI_AUDIO_MODEL)||provider.defaultModel,missing=[];
 if(!key)missing.push(provider.keyVariable);
 if(!/^[\w.-]{1,100}$/.test(model))missing.push('AI_AUDIO_MODEL');
 return {...provider,key,model,missing};
}

export function resolveSearchProvider(env=process.env){
 const provider=choose(env,'AI_SEARCH_PROVIDER',SEARCH,'brave');if(provider.unknown)return provider;
 const key=clean(env[provider.keyVariable]);
 return {...provider,key,missing:key?[]:[provider.keyVariable]};
}

export function resolveImageProvider(env=process.env){
 const provider=choose(env,'AI_IMAGE_PROVIDER',IMAGE,'openai');if(provider.unknown)return provider;
 const missing=[];
 if(provider.id==='openai'){
  const key=clean(env.AI_IMAGE_API_KEY),model=clean(env.AI_IMAGE_MODEL);
  if(!key)missing.push('AI_IMAGE_API_KEY');
  if(!/^[a-zA-Z0-9._-]{1,100}$/.test(model))missing.push('AI_IMAGE_MODEL');
  return {...provider,key,model,missing};
 }
 if(provider.id==='cloudflare'){
  const key=clean(env.AI_CLOUDFLARE_API_TOKEN),accountId=clean(env.AI_CLOUDFLARE_ACCOUNT_ID).toLowerCase(),model=clean(env.AI_IMAGE_MODEL)||CLOUDFLARE_DEFAULT_IMAGE_MODEL;
  if(!key)missing.push('AI_CLOUDFLARE_API_TOKEN');
  if(!/^[a-f0-9]{32}$/.test(accountId))missing.push('AI_CLOUDFLARE_ACCOUNT_ID');
  // The model becomes part of the request path, so only the "@cf/<vendor>/<model>" shape is accepted.
  if(!/^@cf\/[a-z0-9][a-z0-9.-]{0,60}\/[a-z0-9][a-z0-9.-]{0,60}$/.test(model))missing.push('AI_IMAGE_MODEL');
  return {...provider,key,accountId,model,missing};
 }
 return {...provider,key:'',model:'',missing};
}

// One line per feature for the startup log. "configured" means the variables are filled in;
// nothing here contacts the provider, so a wrong key or model still shows as configured.
export function describeExtraProviders(env=process.env){
 const features=[['speech-to-text',resolveAudioProvider(env)],['web search',resolveSearchProvider(env)],['images',resolveImageProvider(env)]];
 return features.map(([feature,provider])=>{
  if(provider.unknown)return {level:'warn',text:`${provider.variable}="${provider.id}" is not recognised (use ${provider.allowed.join(', ')}); ${feature} stays off.`};
  if(provider.missing.length)return {level:'info',text:`AI ${feature}: ${provider.label} off (missing or invalid: ${provider.missing.join(', ')})`};
  return {level:'info',text:`AI ${feature}: ${provider.label} configured${provider.model?` (${provider.model})`:''}`};
 });
}
