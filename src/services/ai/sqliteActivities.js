// Only selected when the explicitly supplied experimental SQLite adapter is available.
// Round state and separate activity points commit in the same SQLite transaction.
export function createSqliteActivityStore(sqlite,{defaults,validateActivity,validateQuiz,error}){
 const key=id=>`ai:activity:settings:${id}`,roundKey=id=>`ai:activity:round:${id}`,pointsKey=(id,userId)=>`ai:activity:points:${id}:${userId}`;
 const locked=(id,fn)=>sqlite.transaction(tx=>{const result=fn(tx.get(roundKey(id))??{},tx);if(result.write)tx.set(roundKey(id),result.write);return result.result});
 return {
  async read(id){const v=sqlite.get(key(id));return v?validateActivity({...defaults,...v}):{...defaults}},
  async save(id,cfg){const v=validateActivity(cfg);sqlite.set(key(id),v);return v},
  async claimSchedule(id,day){return sqlite.transaction(tx=>{const k=`ai:activity:schedule:${id}`;if(tx.get(k)?.day===day)return false;tx.set(k,{day});return true})},
  async status(id,now=Date.now()){const v=sqlite.get(roundKey(id));if(!v||!['pending','open','expired','solved','closed'].includes(v.state))return {state:'none'};const state=v.state==='open'&&v.expiresAt<=now?'expired':v.state,quiz=validateQuiz(v.question);return {state,expiresAt:Number.isFinite(v.expiresAt)?v.expiresAt:null,...(quiz?{question:quiz.question,options:quiz.options,...(state!=='open'&&state!=='pending'?{answer:quiz.answer}:{})}:{})}},
  async points(id,userId){if(!/^\d{17,20}$/.test(userId||''))throw error('Anggota tidak valid.');const n=sqlite.get(pointsKey(id,userId))?.points??0;if(!Number.isSafeInteger(n)||n<0)throw error('Saldo poin tidak valid.',503);return n},
  async reserve(id,roundId,now){return locked(id,v=>{if(['pending','open'].includes(v.state)&&v.expiresAt>now)throw error('Masih ada ronde yang berjalan.',409);return {write:{state:'pending',id:roundId,expiresAt:now+150000},result:true}})},
  async open(id,roundId,question,duration,now,rewardPoints=0){return locked(id,v=>{if(v.state!=='pending'||v.id!==roundId||v.expiresAt<=now)throw error('Reservasi ronde kedaluwarsa.',409);return {write:{state:'open',id:roundId,expiresAt:now+duration*1000,question,answered:[],messageId:null,rewardPoints},result:true}})},
  async attach(id,roundId,messageId){return locked(id,v=>{if(v.state!=='open'||v.id!==roundId)throw error('Ronde sudah berubah.',409);return {write:{...v,messageId},result:true}})},
  async cancel(id,roundId){return locked(id,v=>v.id===roundId?{write:{state:'closed'},result:true}:{result:false})},
  async answer(id,roundId,messageId,userId,choice,now){return locked(id,(v,tx)=>{
   if(v.id!==roundId||v.messageId!==messageId||v.state!=='open')return {result:{status:'closed'}};
   if(v.expiresAt<=now)return {write:{...v,state:'expired'},result:{status:'expired',question:v.question}};
   if(!Array.isArray(v.answered)||v.answered.length>=1000)return {result:{status:'full'}};
   if(v.answered.includes(userId))return {result:{status:'answered'}};
   const answered=[...v.answered,userId];if(choice===v.question.answer){const reward=v.rewardPoints??0;if(!Number.isInteger(reward)||reward<0||reward>1000||!/^\d{17,20}$/.test(userId||''))throw error('Data hadiah tidak valid.',503);let points=null;
    if(reward){const k=pointsKey(id,userId),before=tx.get(k)?.points??0;points=before+reward;if(!Number.isSafeInteger(before)||before<0||!Number.isSafeInteger(points))throw error('Saldo poin tidak valid.',503);tx.set(k,{points})}
    return {write:{...v,state:'solved',answered},result:{status:'correct',question:v.question,reward,points}}}
   return {write:{...v,answered},result:{status:'wrong'}};
  })},
  async expire(id,roundId,now){return locked(id,v=>v.id===roundId&&v.state==='open'&&v.expiresAt<=now?{write:{...v,state:'expired'},result:v.question}:{result:null})},
 };
}
