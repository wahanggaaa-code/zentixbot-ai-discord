import {EXPECTED_SCHEMA_VERSION,EXPECTED_SCHEMA_LABEL} from '../../config/database/schemaVersion.js';

// A single in-flight read-only probe bounds database work, including when a
// driver request hangs past the HTTP deadline. It never treats a pool handle as
// proof that the server is reachable. This does not guard individual bot writes.
export function createDatabaseReadinessProbe({timeoutMs=2000}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new Error('Invalid readiness timeout');
 let inFlight=null;
 function eligible(wrapper,pool){
  try{return Boolean(wrapper&&!wrapper.useFallback&&wrapper.getStatus?.().connectionType==='postgresql'&&wrapper.isAvailable?.()&&wrapper.db?.isAvailable?.()&&wrapper.db.pool===pool&&typeof pool?.query==='function')}
  catch{return false}
 }
 return async function check(wrapper){
  const pool=wrapper?.db?.pool;
  if(!eligible(wrapper,pool))return false;
  // Do not queue unlimited probes if a previous request never resolves, even
  // if the pool object was replaced in the meantime.
  if(inFlight)return inFlight.pool===pool ? Boolean(await inFlight.answer)&&eligible(wrapper,pool) : false;
  const entry={pool,answer:null};inFlight=entry;let timer;
  const query=Promise.resolve().then(()=>pool.query('SELECT 1 AS ready')).then(result=>result?.rows?.[0]?.ready===1,()=>false);
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs)});
  entry.answer=Promise.race([query,deadline]);
  query.then(()=>{clearTimeout(timer);if(inFlight===entry)inFlight=null});
  return Boolean(await entry.answer)&&eligible(wrapper,pool);
 };
}
export function createReadinessHandler(client,checkDatabase=createDatabaseReadinessProbe()){
 return async (_req,res)=>{
  let status;try{status=client.db?.getStatus?.()}catch{}status ||= {isDegraded:true,connectionType:'none'};
  let discordReady=false;try{discordReady=Boolean(client.isReady?.())}catch{}
  const reachable=discordReady&&!status.isDegraded?await checkDatabase(client.db):false;
  const metrics={guildCount:client.guilds?.cache?.size??0,commandCount:client.commands?.size??0,database:{mode:status.connectionType??'none',degraded:Boolean(status.isDegraded),degradedReason:status.degradedReason??null,reachable},schemaVersion:EXPECTED_SCHEMA_VERSION,schemaLabel:EXPECTED_SCHEMA_LABEL};
  if(discordReady&&reachable)return res.status(200).json({ready:true,message:'Bot is ready',metrics});
  return res.status(503).json({ready:false,reason:!discordReady?'Bot not Ready':'Database unavailable',metrics});
 };
}
