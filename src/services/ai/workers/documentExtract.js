// Untrusted file parsing runs in a time- and memory-limited child process. This is not an OS sandbox.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
// Keep third-party diagnostics out of the JSON protocol.
console.log=console.warn=console.error=()=>{};
const mammoth=require('mammoth'),yauzl=require('yauzl');
async function checkDocx(buffer){
 return new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,autoClose:true},(err,zip)=>{
  if(err)return reject(err);let count=0,total=0,document=false,types=false;
  zip.on('error',reject);zip.on('entry',e=>{count++;total+=e.uncompressedSize;
   if(count>200||total>4*1024*1024||e.uncompressedSize>2*1024*1024||(e.generalPurposeBitFlag&1)||e.uncompressedSize>Math.max(1048576,e.compressedSize*200)){zip.close();return reject(Error('Arsip terlalu besar atau terenkripsi.'));}
   if(e.fileName==='word/document.xml')document=true;if(e.fileName==='[Content_Types].xml')types=true;zip.readEntry();});
  zip.on('end',()=>document&&types?resolve():reject(Error('DOCX tidak valid.')));zip.readEntry();
 }));
}
try{
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1500000)throw Error('Input terlalu besar.');}
 const {type,base64}=JSON.parse(input),data=Buffer.from(base64,'base64');let text;
 if(type==='pdf'){if(data.subarray(0,5).toString()!=='%PDF-')throw Error('PDF tidak valid.');const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const task=getDocument({data:new Uint8Array(data),isEvalSupported:false,verbosity:0,disableFontFace:true,useSystemFonts:false});const document=await task.promise;try{if(document.numPages>30)throw Error('PDF maksimal 30 halaman.');text='';for(let n=1;n<=document.numPages;n++){const page=await document.getPage(n);const content=await page.getTextContent();text+=content.items.map(item=>item.str||'').join(' ')+'\n';if(text.length>12000)throw Error('Teks terlalu panjang.');page.cleanup();}}finally{await task.destroy();}}
 else if(type==='docx'){await checkDocx(data);text=(await mammoth.extractRawText({buffer:data})).value;}
 else throw Error('Jenis file tidak didukung.');
 if(typeof text!=='string'||!text.trim()||text.length>12000||text.includes('\0'))throw Error('Teks hasil ekstraksi harus 1–12000 karakter.');
 process.stdout.write(JSON.stringify({text}));
}catch{process.stdout.write(JSON.stringify({error:'File tidak valid, terenkripsi, terlalu besar, atau teks tidak dapat diekstrak.'}));process.exitCode=1;}
