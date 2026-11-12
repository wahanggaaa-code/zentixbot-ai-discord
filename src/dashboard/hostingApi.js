import express from 'express';
export function createHostingApi({auth,env=process.env,fetchImpl=globalThis.fetch}){
 const router=express.Router();let previous=null;
 router.get('/hosting',auth,async(req,res)=>{
  const owners=String(env.OWNER_IDS||'').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x));
  if(!owners.includes(req.session.user.id))return res.status(403).json({error:'Statistik hosting hanya untuk owner bot.'});
  let base;try{const u=new URL(env.HOSTING_PANEL_URL);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error();base=u.origin;}catch{return res.status(503).json({error:'Panel hosting belum dikonfigurasi.'});}
  const id=env.HOSTING_SERVER_ID,key=env.HOSTING_API_KEY;
  if(!id||!key||!/^[a-zA-Z0-9_-]{1,64}$/.test(id))return res.status(503).json({error:'Kredensial hosting belum dikonfigurasi.'});
  try{
   const r=await fetchImpl(`${base}/api/client/servers/${encodeURIComponent(id)}/resources`,{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('hosting error');
   const data=(await r.json()).attributes, resources=data?.resources;
   const num=x=>typeof x==='number' && Number.isFinite(x) && x>=0?x:null;
   const cpu=num(resources?.cpu_absolute),memory=num(resources?.memory_bytes),disk=num(resources?.disk_bytes),rx=num(resources?.network_rx_bytes),tx=num(resources?.network_tx_bytes),now=Date.now();
   let incoming=null,outgoing=null;
   if(previous&&rx!==null&&tx!==null&&rx>=previous.rx&&tx>=previous.tx&&now>previous.at){incoming=(rx-previous.rx)/((now-previous.at)/1000);outgoing=(tx-previous.tx)/((now-previous.at)/1000)}
   if(rx!==null&&tx!==null)previous={rx,tx,at:now};else previous=null;
   res.json({status:typeof data?.current_state==='string'?data.current_state:'unknown',cpuPercent:cpu,memoryBytes:memory,diskBytes:disk,networkInBytesPerSecond:incoming,networkOutBytesPerSecond:outgoing,sampledAt:now});
  }catch{return res.status(503).json({error:'Tidak dapat mengambil data hosting.'});}
 });return router;
}
