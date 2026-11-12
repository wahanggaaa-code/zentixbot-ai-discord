import {readDiscordAttachment} from './attachments.js';
const error=(message,status=400)=>Object.assign(new Error(message),{status});
// Member uploads are UTF-8 text only; PDF/DOCX parsers are reserved for owner uploads.
export async function readChatFile(attachment,{download=readDiscordAttachment}={}){
 const name=attachment?.name;if(typeof name!=='string'||name.length>100||/[\u0000-\u001f]/.test(name)||!/[.](txt|md|csv|json)$/i.test(name))throw error('Hanya file TXT, MD, CSV, atau JSON didukung.');
 const data=await download(attachment,12000);let text;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw error('File teks harus UTF-8.');}
 if(!text.trim()||text.length>2000||text.includes('\0'))throw error('Teks file harus 1–2000 karakter.');return text;
}
