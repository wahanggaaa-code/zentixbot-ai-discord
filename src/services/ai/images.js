import {randomInt} from 'node:crypto';
import {resolveImageProvider} from './extraProviders.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_RESULT_BYTES=8000000;
function png(data,maxBytes){if(typeof data!=='string'||data.length>Math.ceil(maxBytes/3)*4+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw error('Gambar PNG tidak valid atau terlalu besar.');const b=Buffer.from(data,'base64');if(b.length<24||b.length>maxBytes||!b.subarray(0,8).equals(pngSignature)||b.toString('ascii',12,16)!=='IHDR'||b.readUInt32BE(16)>2048||b.readUInt32BE(20)>2048||b.readUInt32BE(16)===0||b.readUInt32BE(20)===0)throw error('Gambar harus PNG 1–2048 piksel dan dalam batas ukuran.');return b;}
async function readBounded(response,maxBytes){if(!response.body)throw error('Respons gambar kosong.',502);const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw error('Respons gambar terlalu besar.',502);chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{})}return Buffer.concat(chunks);}
async function bounded(response){const body=await readBounded(response,11000000);try{return JSON.parse(body.toString('utf8'))}catch{throw error('Respons gambar tidak valid.',502)}}

// Width and height of a JPEG, read from its first frame header. Returns null when the bytes are not a JPEG
// or the header is missing. Like the PNG check this looks at the header only; it does not decode the picture.
function jpegSize(b){
 if(b.length<4||b[0]!==0xff||b[1]!==0xd8)return null;
 let i=2;
 while(i+9<=b.length){
  if(b[i]!==0xff)return null;
  const marker=b[i+1];
  if(marker===0xff){i++;continue;}
  if(marker===0x01||(marker>=0xd0&&marker<=0xd8)){i+=2;continue;}
  if(marker===0xd9||marker===0xda)return null;
  const length=b.readUInt16BE(i+2);if(length<2)return null;
  if(marker>=0xc0&&marker<=0xcf&&marker!==0xc4&&marker!==0xc8&&marker!==0xcc)return length<7?null:{height:b.readUInt16BE(i+5),width:b.readUInt16BE(i+7)};
  i+=2+length;
 }
 return null;
}
// What a provider sent back: PNG or JPEG, 1–2048 pixels per side, within the byte limit. Anything else is refused.
function inspect(bytes){
 const invalid=()=>error('Provider gambar mengembalikan gambar yang tidak valid atau terlalu besar.',502);
 if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.length>MAX_RESULT_BYTES)throw invalid();
 let mime,size;
 if(bytes.subarray(0,8).equals(pngSignature)&&bytes.toString('ascii',12,16)==='IHDR'){mime='image/png';size={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};}
 else{mime='image/jpeg';size=jpegSize(bytes);}
 if(!size||size.width<1||size.height<1||size.width>2048||size.height>2048)throw invalid();
 return {mime,...size};
}
// The JSON answer is already capped by bounded(); what the text decodes to is judged by inspect().
function decodeBase64(data){
 if(typeof data!=='string'||!data)throw error('Provider gambar mengembalikan gambar yang tidak valid atau terlalu besar.',502);
 return Buffer.from(data,'base64');
}

// OpenAI Images API: create and edit, always PNG.
async function openai({provider,mode,prompt,size,image,fetchImpl}){
 let body,headers={Authorization:`Bearer ${provider.key}`};let url='https://api.openai.com/v1/images/generations';
 if(mode==='create'){headers['Content-Type']='application/json';body=JSON.stringify({model:provider.model,prompt,n:1,size,output_format:'png'});}else{url='https://api.openai.com/v1/images/edits';body=new FormData();body.append('model',provider.model);body.append('prompt',prompt);body.append('n','1');body.append('size',size);body.append('output_format','png');body.append('image',new Blob([image],{type:'image/png'}),'image.png');}
 const response=await fetchImpl(url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw error('Provider gambar menolak atau gagal memproses permintaan.',502);
 const data=await bounded(response);return png(data?.data?.[0]?.b64_json,MAX_RESULT_BYTES);
}

// Cloudflare Workers AI: create only. The default model takes a prompt and no size, and answers with
// {"result":{"image":"<base64 JPEG>"}}. Some other models answer with the picture itself, so both are read.
// Source: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
async function cloudflare({provider,prompt,fetchImpl}){
 const url=`https://api.cloudflare.com/client/v4/accounts/${provider.accountId}/ai/run/${provider.model}`;
 const response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${provider.key}`,'Content-Type':'application/json'},body:JSON.stringify({prompt}),redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!response.ok){
  await response.body?.cancel().catch(()=>{});
  if([401,403].includes(response.status))throw error('Cloudflare menolak token atau ID akun. Periksa AI_CLOUDFLARE_API_TOKEN dan AI_CLOUDFLARE_ACCOUNT_ID.',502);
  if(response.status===429)throw error('Batas laju atau jatah harian Cloudflare Workers AI tercapai.',429);
  throw error('Provider gambar menolak atau gagal memproses permintaan.',502);
 }
 if(String(response.headers.get('content-type')||'').toLowerCase().startsWith('image/'))return readBounded(response,MAX_RESULT_BYTES);
 const data=await bounded(response);return decodeBase64(data?.result?.image??data?.image);
}

// Pollinations Classic API: create only, no key. At most 768 × 768 pixels in area, JPEG with a small logo,
// limited per IP address. The prompt travels in the URL. Source: APIDOCS.md in github.com/pollinations/pollinations
const POLLINATIONS_SIZES=Object.freeze({'1024x1024':[768,768],'1536x1024':[940,627],'1024x1536':[627,940]});
async function pollinations({prompt,size,fetchImpl,seed}){
 const [width,height]=POLLINATIONS_SIZES[size];
 const url=new URL('https://image.pollinations.ai/prompt/'+encodeURIComponent(prompt));
 if(!url.pathname.startsWith('/prompt/')||url.pathname.length<=8)throw error('Instruksi gambar tidak valid.');
 url.searchParams.set('width',String(width));url.searchParams.set('height',String(height));url.searchParams.set('seed',String(seed()));url.searchParams.set('safe','true');
 const response=await fetchImpl(url.href,{headers:{Accept:'image/jpeg, image/png, application/json'},redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!response.ok){
  await response.body?.cancel().catch(()=>{});
  if([402,429].includes(response.status)){const wait=Number.parseInt(response.headers.get('retry-after')||'',10);throw error(`Batas gratis Pollinations per alamat IP tercapai. Coba lagi${wait>0&&wait<86400?` dalam ${wait} detik`:' nanti'}.`,429);}
  throw error('Provider gambar menolak atau gagal memproses permintaan.',502);
 }
 return readBounded(response,MAX_RESULT_BYTES);
}

const callers={openai,cloudflare,pollinations};

export function createImageService({client,foundation=client.aiFoundation,env=process.env,fetchImpl=globalThis.fetch,seed=()=>randomInt(1,2147483647)}){
 let busy=false;
 return {async generate({guildId,userId,prompt,mode,imageBase64,consent,size='1024x1024',style='default'}){
  if(guildId!==client.homeGuildId||!/^\d{17,20}$/.test(userId||'')||consent!==true)throw error('Server atau persetujuan tidak valid.',403);
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1000||!['create','edit'].includes(mode))throw error('Instruksi gambar tidak valid.');
  if(!['1024x1024','1536x1024','1024x1536'].includes(size)||!['default','illustration','photo','pixel'].includes(style))throw error('Ukuran atau gaya gambar tidak valid.');
  const styles={default:'',illustration:'Illustration style.',photo:'Photorealistic photography style.',pixel:'Pixel art style.'};const styledPrompt=styles[style]?`${styles[style]} ${prompt}`:prompt;
  const image=mode==='edit'?png(imageBase64,1500000):null;if(mode==='create'&&imageBase64!==null)throw error('Gambar input tidak diperlukan.');
  // OpenAI unless AI_IMAGE_PROVIDER names another provider; an unknown name or a missing value keeps the feature off.
  const provider=resolveImageProvider(env);
  if(provider.unknown)throw error(`AI_IMAGE_PROVIDER tidak dikenal. Pilihan: ${provider.allowed.join(', ')}.`,503);
  if(provider.missing.length)throw error(`Provider gambar atau model belum dikonfigurasi (${provider.label}: ${provider.missing.join(', ')}).`,503);
  if(mode==='edit'&&!provider.canEdit)throw error(`Edit gambar hanya tersedia dengan provider OpenAI. Provider aktif: ${provider.label}.`);
  if(busy)throw error('Generator gambar sedang digunakan.',429);busy=true;
  try{const cfg=await foundation.store.read(guildId);if(!cfg.enabled||!cfg.providerDataConsent)throw error('Fondasi AI belum aktif atau disetujui.',403);await foundation.store.reserve(guildId,userId,cfg);
   const bytes=await callers[provider.id]({provider,mode,prompt:styledPrompt,size,image,fetchImpl,seed});
   const info=inspect(bytes),[wanted,wantedHeight]=size.split('x').map(Number);
   const result={imageBase64:bytes.toString('base64'),mime:info.mime,provider:provider.label,width:info.width,height:info.height};
   // Not every provider honours the requested size; say so instead of presenting the picture as what was asked for.
   if(info.width!==wanted||info.height!==wantedHeight)result.note=`Provider mengembalikan ${info.width}×${info.height}, bukan ${wanted}×${wantedHeight} yang diminta.`;
   return result;
  }catch(e){if(e.status)throw e;throw error('Provider gambar tidak tersedia atau timeout.',503)}finally{busy=false}
 }};
}
