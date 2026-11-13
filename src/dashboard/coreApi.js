import express from 'express';
import {getCommandAccessSnapshot,getCategoryRegistry,resolveCommandTarget,isProtectedCommand} from '../services/commandAccessService.js';
import {readPostgresCommandAccess,mutatePostgresCommandAccess} from '../services/config/commandAccessPostgres.js';
const bad=(status,message)=>Object.assign(new Error(message),{status});
function respond(res,e){const conflict=['COMMAND_ACCESS_STALE','COMMAND_ACCESS_INVALID'].includes(e.code);res.status(e.status||(conflict?409:503)).json({error:e.status?e.message:conflict?'Pengaturan berubah atau data akses perlu diperiksa. Muat ulang.':'Tidak dapat mengakses database; jika hasil simpan tidak diketahui, muat ulang sebelum mencoba lagi.'})}
export function createCoreApi(client,{auth,csrf}){
 const router=express.Router();router.use('/core/commands',express.json({limit:'4kb'}));router.use('/core/commands',(req,res,next)=>{res.set('Cache-Control','no-store');next()});
 router.get('/core/commands',auth,async(req,res)=>{try{
  if(!client.commands?.values)throw bad(503,'Daftar perintah bot belum tersedia.');
  const {config,revision}=await readPostgresCommandAccess(client,req.guild.id);const snapshot=getCommandAccessSnapshot(client,config);
  if(snapshot.totalCommands>1000)throw bad(503,'Jumlah perintah melebihi batas dashboard.');
  const categories=snapshot.categories.map(c=>({key:c.key,name:c.displayName,disabled:c.categoryDisabled,commands:c.commands.map(x=>({name:x.name,description:String(x.description).slice(0,300),protected:isProtectedCommand(x.parentCommand||x.name),ownDisabled:!!snapshot.disabledCommands[x.name.toLowerCase()],enabled:c.enabledCommands.includes(x.name)}))}));
  res.json({revision,categories});
 }catch(e){respond(res,e)}});
 router.patch('/core/commands',auth,csrf,async(req,res)=>{try{
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='confirmed,disabled,kind,revision,target'||b.confirmed!==true||typeof b.disabled!=='boolean'||!['command','category'].includes(b.kind)||typeof b.target!=='string'||b.target.length>128||typeof b.revision!=='string'||!/^(missing|[0-9a-f]{64})$/.test(b.revision))throw bad(400,'Permintaan pengaturan akses tidak valid.');
  if(!client.commands?.values)throw bad(503,'Daftar perintah bot belum tersedia.');
  let field;
  if(b.kind==='command'){
   const target=resolveCommandTarget(client,b.target);if(!target||target.name!==b.target)throw bad(400,'Perintah tidak tersedia.');
   if(b.disabled&&isProtectedCommand(target.parentCommand||target.name))throw bad(403,'Perintah pemulihan tidak dapat dinonaktifkan.');field='disabledCommands';
  }else{const category=getCategoryRegistry(client,b.target);if(!category||category.key!==b.target)throw bad(400,'Kategori tidak tersedia.');field='disabledCategories';}
  const revision=await mutatePostgresCommandAccess(client,req.guild.id,{field,targets:[b.target],disabled:b.disabled,revision:b.revision});res.json({ok:true,revision});
 }catch(e){respond(res,e)}});
 return router;
}
