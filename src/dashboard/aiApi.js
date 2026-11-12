import express from 'express';
import { createAIFoundation, validateSettings } from '../services/ai/foundation.js';
import { ChannelType } from 'discord.js';
import { createAIWelcomeStore, validateAIWelcome, generateWelcomeTemplate } from '../services/ai/welcome.js';
import { createActivityStore, validateActivity, startActivity } from '../services/ai/activities.js';
import { createChatStore, validateChatSettings } from '../services/ai/chat.js';
import { createKnowledgeStore, askKnowledge } from '../services/ai/knowledge.js';
import { runTextTool } from '../services/ai/tools.js';
import { createImageService } from '../services/ai/images.js';
import { createBuilder } from '../services/ai/builder.js';
import { extractDocument } from '../services/ai/documentExtract.js';
import { createSearchService } from '../services/ai/search.js';

export function createAIApi(client,{auth,csrf,env=process.env,foundation=client.aiFoundation||createAIFoundation({client,env}),welcomeStore=createAIWelcomeStore(client),goodbyeStore=createAIWelcomeStore(client,'goodbye'),activityStore=createActivityStore(client),chatStore=createChatStore(client),knowledgeStore=createKnowledgeStore(client),imageService=client.aiImageService||createImageService({client,foundation,env}),builder=createBuilder({client,foundation}),searchService=client.aiSearchService||createSearchService({client,foundation,env})}) {
 const router=express.Router();const json=express.json({limit:'24kb'});router.use((req,res,next)=>['/image','/knowledge/upload'].includes(req.path)?next():json(req,res,next));
 const owner=(req,res,next)=>{const ids=String(env.OWNER_IDS||'').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x));if(!ids.includes(req.session.user.id))return res.status(403).json({error:'Pengaturan dan uji AI hanya untuk owner bot.'});next()};
 const fail=(res,e)=>res.status(e.status||503).json({error:e.status?e.message:'Layanan AI atau database tidak tersedia.',code:e.code||'UNAVAILABLE',...(e.created?{created:e.created}:{})});
 router.get('/settings',auth,owner,async(req,res)=>{try{res.json({settings:await foundation.store.read(req.guild.id),credentials:foundation.credentials()})}catch(e){fail(res,e)}});
 router.patch('/settings',auth,owner,csrf,async(req,res)=>{try{const settings=validateSettings(req.body);await foundation.store.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.get('/welcome',auth,owner,async(req,res)=>{try{const settings=await welcomeStore.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels})}catch(e){fail(res,e)}});
 router.patch('/welcome',auth,owner,csrf,async(req,res)=>{try{const settings=validateAIWelcome(req.body,req.guild);await welcomeStore.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.post('/welcome/preview',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi pengujian diperlukan.'});
  try{const cfg=await welcomeStore.read(req.guild.id);const result=await generateWelcomeTemplate({foundation,guildId:req.guild.id,actorId:req.session.user.id,cfg});res.json({ok:true,source:result.source,preview:result.template.replaceAll('{user}','@anggota').replaceAll('{server}','Server Contoh')});}catch(e){fail(res,e)}
 });
 router.get('/goodbye',auth,owner,async(req,res)=>{try{const settings=await goodbyeStore.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels})}catch(e){fail(res,e)}});
 router.patch('/goodbye',auth,owner,csrf,async(req,res)=>{try{const settings=validateAIWelcome(req.body,req.guild);if(settings.toDm)throw Object.assign(Error('AI Goodbye tidak mendukung DM.'),{status:400});await goodbyeStore.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.post('/goodbye/preview',auth,owner,csrf,async(req,res)=>{if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi pengujian diperlukan.'});try{const cfg=await goodbyeStore.read(req.guild.id);const result=await generateWelcomeTemplate({foundation,guildId:req.guild.id,actorId:req.session.user.id,cfg,kind:'goodbye'});res.json({ok:true,source:result.source,preview:result.template.replaceAll('{user}','@anggota').replaceAll('{server}','Server Contoh')});}catch(e){fail(res,e)}});
 router.get('/activities',auth,owner,async(req,res)=>{try{const settings=await activityStore.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels})}catch(e){fail(res,e)}});
 router.patch('/activities',auth,owner,csrf,async(req,res)=>{try{const settings=validateActivity(req.body,req.guild);await activityStore.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.post('/activities/start',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi memulai ronde diperlukan.'});
  try{const result=await startActivity({client,guild:req.guild,actorId:req.session.user.id,store:activityStore,foundation});res.json({ok:true,...result});}catch(e){fail(res,e)}
 });
 router.get('/chat',auth,owner,async(req,res)=>{try{const settings=await chatStore.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels})}catch(e){fail(res,e)}});
 router.patch('/chat',auth,owner,csrf,async(req,res)=>{try{const settings=validateChatSettings(req.body,req.guild);await chatStore.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.get('/knowledge',auth,owner,async(req,res)=>{try{const docs=await knowledgeStore.read(req.guild.id);res.json({documents:docs.map(({id,name,createdAt,content})=>({id,name,createdAt,characters:content.length}))})}catch(e){fail(res,e)}});
 router.post('/knowledge',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,content,name'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const doc=await knowledgeStore.add(req.guild.id,b.name,b.content);res.json({ok:true,document:doc})}catch(e){fail(res,e)}});
 router.post('/knowledge/upload',auth,owner,csrf,express.json({limit:'1500kb'}),async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='base64,confirmed,name'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const content=await extractDocument(b.name,b.base64);const document=await knowledgeStore.add(req.guild.id,b.name,content);res.json({ok:true,document})}catch(e){fail(res,e)}});
 router.delete('/knowledge/:id',auth,owner,csrf,async(req,res)=>{try{if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});await knowledgeStore.remove(req.guild.id,req.params.id);res.json({ok:true})}catch(e){fail(res,e)}});
 router.post('/knowledge/ask',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,question'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await askKnowledge({client,guildId:req.guild.id,userId:req.session.user.id,question:b.question,consent:true,store:knowledgeStore,foundation})})}catch(e){fail(res,e)}});
 router.post('/tools',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,language,mode,text'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await runTextTool({client,guildId:req.guild.id,userId:req.session.user.id,mode:b.mode,text:b.text,language:b.language,consent:true,foundation})})}catch(e){fail(res,e)}});
 router.post('/image',auth,owner,csrf,express.json({limit:'3mb'}),async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,imageBase64,mode,prompt'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await imageService.generate({guildId:req.guild.id,userId:req.session.user.id,prompt:b.prompt,mode:b.mode,imageBase64:b.imageBase64,consent:true})})}catch(e){fail(res,e)}});
 router.post('/builder/draft',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,description'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.draft({guildId:req.guild.id,userId:req.session.user.id,description:b.description,consent:true})})}catch(e){fail(res,e)}});
 router.post('/builder/apply',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,id'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.apply({guild:req.guild,userId:req.session.user.id,id:b.id,confirmed:true})})}catch(e){fail(res,e)}});
 router.post('/search',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,query'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await searchService.search({guildId:req.guild.id,userId:req.session.user.id,query:b.query,consent:true})})}catch(e){fail(res,e)}});
 router.post('/test',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi biaya dan pengiriman ke provider diperlukan.'});
  try{const result=await foundation.generate({guildId:req.guild.id,userId:req.session.user.id,consent:true,prompt:'Jawab singkat dengan kalimat: Koneksi AI siap diuji.'});res.json({ok:true,...result});}catch(e){fail(res,e)}
 });
 return router;
}
