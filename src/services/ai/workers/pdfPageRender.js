// Rasterization of an untrusted PDF is isolated in a child process, NOT an OS sandbox.
// Suppress PDF.js diagnostics so stdout remains a bounded JSON protocol.
console.log=console.warn=console.error=()=>{};
try {
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1500000)throw Error('input too large');}
 const {base64,pageNumber}=JSON.parse(input),data=Buffer.from(base64,'base64');
 if(data.length<5||data.length>1048576||data.subarray(0,5).toString()!=='%PDF-'||!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>30)throw Error('invalid input');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const {createCanvas}=await import('@napi-rs/canvas');
 const task=getDocument({data:new Uint8Array(data),isEvalSupported:false,verbosity:0,disableFontFace:true,useSystemFonts:false,maxImageSize:4194304,disableAutoFetch:true,disableStream:true});
 const doc=await task.promise;
 try {
  if(doc.numPages>30||pageNumber>doc.numPages)throw Error('page out of range');
  const page=await doc.getPage(pageNumber),base=page.getViewport({scale:1});
  if(!Number.isFinite(base.width)||!Number.isFinite(base.height)||base.width<1||base.height<1||base.width>14400||base.height>14400)throw Error('invalid page size');
  const scale=Math.min(2,1536/Math.max(base.width,base.height)),viewport=page.getViewport({scale});
  const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);if(width<1||height<1||width>1536||height>1536||width*height>2359296)throw Error('invalid viewport');
  const canvas=createCanvas(width,height),context=canvas.getContext('2d');context.fillStyle='#ffffff';context.fillRect(0,0,width,height);
  await page.render({canvasContext:context,viewport,background:'#ffffff'}).promise;
  const png=canvas.toBuffer('image/png');page.cleanup();if(png.length>1048576)throw Error('rendered image too large');
  process.stdout.write(JSON.stringify({base64:png.toString('base64'),pageCount:doc.numPages,width,height}));
 } finally {await task.destroy();}
} catch {process.stdout.write(JSON.stringify({error:'PDF tidak dapat dirender.'}));process.exitCode=1;}
