import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const worker=fileURLToPath(new URL('./workers/documentExtract.js',import.meta.url));
const error=(message,status=400)=>Object.assign(new Error(message),{status});
let active=0;
export async function extractDocument(name,base64){
 const type=typeof name==='string'&&/\.pdf$/i.test(name)?'pdf':typeof name==='string'&&/\.docx$/i.test(name)?'docx':null;
 if(!type||name.length>100||/[\u0000-\u001f]/.test(name)||typeof base64!=='string'||base64.length>1398104||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw error('File PDF/DOCX tidak valid atau terlalu besar.');
 const data=Buffer.from(base64,'base64');if(!data.length||data.length>1048576||data.toString('base64')!==base64)throw error('File PDF/DOCX tidak valid atau terlalu besar.');
 if(active>=2)throw error('Ekstraksi sedang sibuk. Coba lagi.',429);active++;
 try{return await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--max-old-space-size=96',worker],{env:{PATH:process.env.PATH||''},stdio:['pipe','pipe','ignore']});let output='',settled=false;
  const finish=(err,value)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(value)};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(error('Ekstraksi dokumen timeout.',408))},12000);timer.unref?.();
  child.on('error',()=>finish(error('Ekstraksi dokumen tidak tersedia.',503)));
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>100000){child.kill('SIGKILL');finish(error('Hasil ekstraksi terlalu besar.'))}});
  child.on('close',code=>{try{const result=JSON.parse(output);if(code!==0||typeof result.text!=='string')throw Error();finish(null,result.text)}catch{finish(error('File tidak valid, terenkripsi, terlalu besar, atau teks tidak dapat diekstrak.'))}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({type,base64}));
 });}finally{active--;}
}
