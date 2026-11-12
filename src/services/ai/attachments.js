const error=(message,status=400)=>Object.assign(new Error(message),{status});
let active=0;
// The interaction attachment must be hosted on Discord's CDN; redirects are forbidden.
export async function readDiscordAttachment(attachment,maxBytes,fetchImpl=globalThis.fetch){
 if(!attachment||typeof attachment.url!=='string'||!Number.isSafeInteger(attachment.size)||attachment.size<1||attachment.size>maxBytes)throw error('Ukuran lampiran tidak valid.');
 let url;try{url=new URL(attachment.url)}catch{throw error('URL lampiran tidak valid.')}
 if(url.protocol!=='https:'||url.hostname!=='cdn.discordapp.com'||url.port||url.username||url.password||url.hash||!/^\/attachments\/\d{17,20}\/\d{17,20}\//.test(url.pathname))throw error('Hanya lampiran Discord yang didukung.');
 if(active>=2)throw error('Pemrosesan lampiran sedang sibuk.',429);active++;
 try{
  const response=await fetchImpl(url.toString(),{redirect:'error',signal:AbortSignal.timeout(10000)});if(!response.ok||!response.body)throw error('Lampiran tidak dapat diunduh.');
  const declared=Number(response.headers.get('content-length'));if(declared>maxBytes){await response.body.cancel().catch(()=>{});throw error('Lampiran terlalu besar.');}
  const reader=response.body.getReader(),chunks=[];let length=0;try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>maxBytes)throw error('Lampiran terlalu besar.');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
  const data=Buffer.concat(chunks);if(data.length!==attachment.size)throw error('Ukuran lampiran tidak cocok.');return data;
 }finally{active--;}
}
export async function readDiscordImage(attachment,fetchImpl=globalThis.fetch){
 const data=await readDiscordAttachment(attachment,1048576,fetchImpl);let mime;
 if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='image/png';else if(data.length>=4&&data[0]===255&&data[1]===216&&data[data.length-2]===255&&data[data.length-1]===217)mime='image/jpeg';else throw error('Hanya gambar PNG atau JPEG yang didukung.');
 return {mime,base64:data.toString('base64')};
}
