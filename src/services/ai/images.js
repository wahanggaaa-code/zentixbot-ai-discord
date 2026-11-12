const error=(message,status=400)=>Object.assign(new Error(message),{status});
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
function png(data,maxBytes){if(typeof data!=='string'||data.length>Math.ceil(maxBytes/3)*4+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw error('Gambar PNG tidak valid atau terlalu besar.');const b=Buffer.from(data,'base64');if(b.length<24||b.length>maxBytes||!b.subarray(0,8).equals(pngSignature)||b.toString('ascii',12,16)!=='IHDR'||b.readUInt32BE(16)>2048||b.readUInt32BE(20)>2048||b.readUInt32BE(16)===0||b.readUInt32BE(20)===0)throw error('Gambar harus PNG 1–2048 piksel dan dalam batas ukuran.');return b;}
async function bounded(response){if(!response.body)throw error('Respons gambar kosong.',502);const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>11000000)throw error('Respons gambar terlalu besar.',502);chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{})}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw error('Respons gambar tidak valid.',502)}}
export function createImageService({client,foundation=client.aiFoundation,env=process.env,fetchImpl=globalThis.fetch}){
 let busy=false;
 return {async generate({guildId,userId,prompt,mode,imageBase64,consent}){
  if(guildId!==client.homeGuildId||!/^\d{17,20}$/.test(userId||'')||consent!==true)throw error('Server atau persetujuan tidak valid.',403);
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>1000||!['create','edit'].includes(mode))throw error('Instruksi gambar tidak valid.');
  const image=mode==='edit'?png(imageBase64,1500000):null;if(mode==='create'&&imageBase64!==null)throw error('Gambar input tidak diperlukan.');
  const key=String(env.AI_IMAGE_API_KEY||'').trim(),model=String(env.AI_IMAGE_MODEL||'').trim();if(!key||!/^[a-zA-Z0-9._-]{1,100}$/.test(model))throw error('Provider gambar atau model belum dikonfigurasi.',503);
  if(busy)throw error('Generator gambar sedang digunakan.',429);busy=true;
  try{const cfg=await foundation.store.read(guildId);if(!cfg.enabled||!cfg.providerDataConsent)throw error('Fondasi AI belum aktif atau disetujui.',403);await foundation.store.reserve(guildId,userId,cfg);
   let body,headers={Authorization:`Bearer ${key}`};let url='https://api.openai.com/v1/images/generations';
   if(mode==='create'){headers['Content-Type']='application/json';body=JSON.stringify({model,prompt,n:1,size:'1024x1024',output_format:'png'});}else{url='https://api.openai.com/v1/images/edits';body=new FormData();body.append('model',model);body.append('prompt',prompt);body.append('n','1');body.append('size','1024x1024');body.append('output_format','png');body.append('image',new Blob([image],{type:'image/png'}),'image.png');}
   const response=await fetchImpl(url,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw error('Provider gambar menolak atau gagal memproses permintaan.',502);
   const data=await bounded(response);const encoded=data?.data?.[0]?.b64_json;const result=png(encoded,8000000);return {imageBase64:result.toString('base64'),mime:'image/png'};
  }catch(e){if(e.status)throw e;throw error('Provider gambar tidak tersedia atau timeout.',503)}finally{busy=false}
 }};
}
