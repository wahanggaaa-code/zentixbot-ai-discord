import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const worker=fileURLToPath(new URL('./workers/pdfPageRender.js',import.meta.url));
const error=(message,status=400)=>Object.assign(new Error(message),{status});
let active=0;
// One selected page at a time. The child has a JS heap/time bound, but native memory is not OS-sandboxed.
export async function renderPdfPage(name,base64,pageNumber){
 if(typeof name!=='string'||name.length>70||/[\u0000-\u001f]/.test(name)||!/[.]pdf$/i.test(name)||!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>30||typeof base64!=='string'||!base64.length||base64.length>1398104||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw error('PDF atau nomor halaman tidak valid.');
 const bytes=Buffer.from(base64,'base64');if(bytes.length>1048576||bytes.subarray(0,5).toString()!=='%PDF-'||bytes.toString('base64')!==base64)throw error('PDF tidak valid atau melebihi 1 MB.');
 if(active>=1)throw error('Render PDF sedang sibuk.',429);active++;
 try{return await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--max-old-space-size=128',worker],{env:{PATH:process.env.PATH||''},stdio:['pipe','pipe','ignore']});let output='',settled=false;
  const finish=(e,v)=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve(v)};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(error('Render PDF timeout.',408))},15000);timer.unref?.();
  child.on('error',()=>finish(error('Render PDF tidak tersedia.',503)));
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1450000){child.kill('SIGKILL');finish(error('Gambar hasil render terlalu besar.',413))}});
  child.on('close',code=>{try{const result=JSON.parse(output);if(code!==0||typeof result.base64!=='string'||result.base64.length>1398104||!Number.isInteger(result.pageCount)||result.pageCount<pageNumber||result.pageCount>30)throw Error();finish(null,result)}catch{finish(error('PDF tidak valid, terenkripsi, terlalu besar, halaman tidak ada, atau tidak dapat dirender.'))}});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({base64,pageNumber}));
 });}finally{active--;}
}
