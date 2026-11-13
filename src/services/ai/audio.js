import {readDiscordAttachment} from './attachments.js';
import {validateSettings} from './foundation.js';
import {resolveAudioProvider} from './extraProviders.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const MAX_AUDIO=2*1024*1024;
let active=0;
function audioType(data){
 if(data.subarray(0,4).toString()==='OggS')return ['audio/ogg','ogg'];
 if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WAVE')return ['audio/wav','wav'];
 if(data.subarray(0,3).toString()==='ID3'||data.length>2&&data[0]===255&&(data[1]&0xe0)===0xe0)return ['audio/mpeg','mp3'];
 if(data.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return ['audio/webm','webm'];
 if(data.length>12&&data.subarray(4,8).toString()==='ftyp')return ['audio/mp4','m4a'];
 if(data.subarray(0,4).toString()==='fLaC')return ['audio/flac','flac'];
 throw error('Format audio tidak didukung.');
}
async function readJSON(response){
 if(!response.body)throw error('Respons transkripsi tidak valid.',502);const reader=response.body.getReader(),parts=[];let length=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>32768)throw error('Respons transkripsi terlalu besar.',502);parts.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{throw error('Respons transkripsi tidak valid.',502)}
}
export function createAudioService({client,foundation=client.aiFoundation,env=process.env,fetchImpl=globalThis.fetch,download=readDiscordAttachment}={}){
 return {async transcribe({guildId,userId,attachment,consent}){
  if(guildId!==client.homeGuildId||!/^\d{17,20}$/.test(userId||''))throw error('Akses server tidak valid.',403);
  if(consent!==true)throw error('Persetujuan audio diperlukan.',403);
  // OpenAI unless AI_AUDIO_PROVIDER names another provider; an unknown name or a missing key keeps the feature off.
  const provider=resolveAudioProvider(env);
  if(provider.unknown||provider.missing.length)throw error('Kredensial/model audio belum dikonfigurasi.',503);
  const {key,model}=provider;
  if(active>=2)throw error('Transkripsi sedang sibuk.',429);active++;
  try{
   const cfg=validateSettings(await foundation.store.read(guildId));if(!cfg.enabled||!cfg.providerDataConsent)throw error('AI belum diaktifkan.',403);
   const data=await download(attachment,MAX_AUDIO,fetchImpl);const [mime,extension]=audioType(data);
   await foundation.store.reserve(guildId,userId,cfg);
   const body=new FormData();body.append('model',model);body.append('file',new Blob([data],{type:mime}),`audio.${extension}`);
   const response=await fetchImpl(provider.url,{method:'POST',headers:{Authorization:`Bearer ${key}`},body,redirect:'error',signal:AbortSignal.timeout(60000)});
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw error('Provider transkripsi tidak tersedia.',502);}
   const result=await readJSON(response);if(typeof result.text!=='string'||!result.text.trim()||result.text.length>1500)throw error('Transkripsi kosong atau lebih dari 1500 karakter.',502);
   return result.text.trim();
  }finally{active--;}
 }};
}
