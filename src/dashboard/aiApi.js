import express from 'express';
import { createAIFoundation, validateSettings } from '../services/ai/foundation.js';
import { ChannelType } from 'discord.js';
import { createAIWelcomeStore, validateAIWelcome, generateWelcomeTemplate } from '../services/ai/welcome.js';
import { createActivityStore, validateActivity, startActivity } from '../services/ai/activities.js';
import { sendDMPublicPanel } from '../services/ai/dmPanel.js';
import { createChatStore, validateChatSettings } from '../services/ai/chat.js';
import { createInteractive, validateInteractive } from '../services/ai/interactive.js';
import { createKnowledgeStore, askKnowledge } from '../services/ai/knowledge.js';
import { summarizeLink } from '../services/ai/linkSummary.js';
import { research } from '../services/ai/research.js';
import { runTextTool } from '../services/ai/tools.js';
import { createImageService } from '../services/ai/images.js';
import { createBuilder, PLAN_LIMITS, CHANNEL_TYPES } from '../services/ai/builder.js';
import { listThemes } from '../services/ai/builderThemes.js';
import { createManualBuilder, MANUAL_ROLE_PERMISSIONS } from '../services/ai/builderManual.js';
import { extractImageText, extractPdfPageText } from '../services/ai/ocr.js';
import { extractDocument } from '../services/ai/documentExtract.js';
import { createSearchService } from '../services/ai/search.js';
import { createSmart } from '../services/ai/smart.js';
import { LANGUAGES, MAX_FAQ_ENTRIES, MAX_SMART_CHANNELS } from '../services/ai/smartSettings.js';
import { MESSAGE_MENUS } from '../services/ai/menus.js';
import { MAX_REPORT_DAYS } from '../services/ai/usage.js';
import { resolveSearchProvider } from '../services/ai/extraProviders.js';

export function createAIApi(client,{auth,csrf,env=process.env,foundation=client.aiFoundation||createAIFoundation({client,env}),welcomeStore=createAIWelcomeStore(client),goodbyeStore=createAIWelcomeStore(client,'goodbye'),activityStore=createActivityStore(client),chatStore=createChatStore(client),knowledgeStore=createKnowledgeStore(client),imageService=client.aiImageService||createImageService({client,foundation,env}),builder=createBuilder({client,foundation}),manualBuilder=createManualBuilder({client}),searchService=client.aiSearchService||createSearchService({client,foundation,env})}) {
 const router=express.Router();const json=express.json({limit:'24kb'});router.use((req,res,next)=>['/image','/knowledge/upload','/knowledge/ocr','/knowledge/ocr-pdf','/smart/faq'].includes(req.path)?next():json(req,res,next));
 const owner=(req,res,next)=>{const ids=String(env.OWNER_IDS||'').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x));if(!ids.includes(req.session.user.id))return res.status(403).json({error:'Pengaturan dan uji AI hanya untuk owner bot.'});next()};
 const fail=(res,e)=>res.status(e.status||503).json({error:e.status?e.message:'Layanan AI atau database tidak tersedia.',code:e.code||'UNAVAILABLE',...(e.created?{created:e.created,buildId:e.buildId??null,recorded:e.recorded===true}:{})});
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
 router.get('/activities/status',auth,owner,async(req,res)=>{try{res.json({round:await activityStore.status(req.guild.id)})}catch(e){fail(res,e)}});
 router.post('/activities/start',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi memulai ronde diperlukan.'});
  try{const result=await startActivity({client,guild:req.guild,actorId:req.session.user.id,store:activityStore,foundation});res.json({ok:true,...result});}catch(e){fail(res,e)}
 });
 router.get('/chat',auth,owner,async(req,res)=>{try{const settings=await chatStore.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels})}catch(e){fail(res,e)}});
 router.patch('/chat',auth,owner,csrf,async(req,res)=>{try{const settings=validateChatSettings(req.body,req.guild);await chatStore.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 // Interactive AI in channels. Saving goes through the running handler so it applies to the next message.
 const interactive=client.aiInteractive||createInteractive({client,foundation});
 router.get('/interactive',auth,owner,async(req,res)=>{try{const settings=await interactive.store.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels,search:{configured:searchReady()}})}catch(e){fail(res,e)}});
 router.patch('/interactive',auth,owner,csrf,async(req,res)=>{try{const settings=await interactive.saveSettings(validateInteractive(req.body,req.guild));res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.post('/chat/panel',auth,owner,csrf,async(req,res)=>{try{if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const settings=await chatStore.read(req.guild.id);res.json({ok:true,...await sendDMPublicPanel({client,guild:req.guild,settings,confirmed:true})})}catch(e){fail(res,e)}});
 router.get('/knowledge',auth,owner,async(req,res)=>{try{const docs=await knowledgeStore.read(req.guild.id);res.json({documents:docs.map(({id,name,createdAt,content})=>({id,name,createdAt,characters:content.length}))})}catch(e){fail(res,e)}});
 router.post('/knowledge',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,content,name'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const doc=await knowledgeStore.add(req.guild.id,b.name,b.content);res.json({ok:true,document:doc})}catch(e){fail(res,e)}});
 router.post('/knowledge/ocr',auth,owner,csrf,express.json({limit:'1500kb'}),async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='base64,confirmed,name'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const result=await extractImageText({client,guildId:req.guild.id,userId:req.session.user.id,name:b.name,base64:b.base64,consent:true,foundation});res.json({ok:true,...result})}catch(e){fail(res,e)}});
 router.post('/knowledge/ocr-pdf',auth,owner,csrf,express.json({limit:'1500kb'}),async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='base64,confirmed,name,pageNumber'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const result=await extractPdfPageText({client,guildId:req.guild.id,userId:req.session.user.id,name:b.name,base64:b.base64,pageNumber:b.pageNumber,consent:true,foundation});res.json({ok:true,...result})}catch(e){fail(res,e)}});
 router.post('/knowledge/upload',auth,owner,csrf,express.json({limit:'1500kb'}),async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='base64,confirmed,name'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});const content=await extractDocument(b.name,b.base64);const document=await knowledgeStore.add(req.guild.id,b.name,content);res.json({ok:true,document})}catch(e){fail(res,e)}});
 router.delete('/knowledge/:id',auth,owner,csrf,async(req,res)=>{try{if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});await knowledgeStore.remove(req.guild.id,req.params.id);res.json({ok:true})}catch(e){fail(res,e)}});
 router.post('/knowledge/ask',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,question'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await askKnowledge({client,guildId:req.guild.id,userId:req.session.user.id,question:b.question,consent:true,store:knowledgeStore,foundation})})}catch(e){fail(res,e)}});
 router.post('/tools',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,language,mode,text'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await runTextTool({client,guildId:req.guild.id,userId:req.session.user.id,mode:b.mode,text:b.text,language:b.language,consent:true,foundation})})}catch(e){fail(res,e)}});
 router.post('/link-summary',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,url'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await summarizeLink({client,guildId:req.guild.id,userId:req.session.user.id,url:b.url,consent:true,foundation})})}catch(e){fail(res,e)}});
 router.post('/research',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,query'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await research({client,guildId:req.guild.id,userId:req.session.user.id,query:b.query,consent:true,foundation,searchService})})}catch(e){fail(res,e)}});
 router.post('/image',auth,owner,csrf,express.json({limit:'3mb'}),async(req,res)=>{try{const b=req.body;if(!b||!['confirmed,imageBase64,mode,prompt','confirmed,imageBase64,mode,prompt,size,style'].includes(Object.keys(b).sort().join(','))||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await imageService.generate({guildId:req.guild.id,userId:req.session.user.id,prompt:b.prompt,mode:b.mode,imageBase64:b.imageBase64,consent:true,...(Object.hasOwn(b,'size')?{size:b.size,style:b.style}:{})})})}catch(e){fail(res,e)}});
 router.get('/builder/manual/permissions',auth,owner,(req,res)=>res.json({permissions:MANUAL_ROLE_PERMISSIONS}));
 router.post('/builder/manual/prepare',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='action,kind,targetId,value')throw Object.assign(Error('Input tidak valid.'),{status:400});res.json({ok:true,...await manualBuilder.prepare({guild:req.guild,userId:req.session.user.id,...b})})}catch(e){fail(res,e)}});
 router.post('/builder/manual/apply',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmation,id')throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await manualBuilder.apply({guild:req.guild,userId:req.session.user.id,...b})})}catch(e){fail(res,e)}});
 router.post('/builder/manual/undo',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmation,id')throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await manualBuilder.undo({guild:req.guild,userId:req.session.user.id,...b})})}catch(e){fail(res,e)}});
 router.post('/builder/draft',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,description'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.draft({guildId:req.guild.id,userId:req.session.user.id,description:b.description,consent:true})})}catch(e){fail(res,e)}});
 router.post('/builder/edit',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='id,plan')throw Object.assign(Error('Rancangan tidak valid.'),{status:400});res.json({ok:true,...await builder.edit({guildId:req.guild.id,userId:req.session.user.id,id:b.id,plan:b.plan})})}catch(e){fail(res,e)}});
 router.post('/builder/apply',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,id'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.apply({guild:req.guild,userId:req.session.user.id,id:b.id,confirmed:true})})}catch(e){fail(res,e)}});
 // Themes cost no AI request; the same review, edit and confirmation steps follow.
 router.get('/builder/themes',auth,owner,(req,res)=>res.json({themes:listThemes(),limits:PLAN_LIMITS,channelTypes:CHANNEL_TYPES}));
 router.post('/builder/theme',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).join(',')!=='themeId'||typeof b.themeId!=='string')throw Object.assign(Error('Tema tidak valid.'),{status:400});res.json({ok:true,...await builder.draftFromTheme({guildId:req.guild.id,userId:req.session.user.id,themeId:b.themeId})})}catch(e){fail(res,e)}});
 // The plan this account still has waiting, so the page can show it again after a reload or a tab change.
 router.get('/builder/pending',auth,owner,(req,res)=>{try{res.json({pending:builder.pending({guildId:req.guild.id,userId:req.session.user.id})})}catch(e){fail(res,e)}});
 router.post('/builder/cancel',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).join(',')!=='id')throw Object.assign(Error('Rancangan tidak valid.'),{status:400});res.json({ok:true,...await builder.cancel({guildId:req.guild.id,userId:req.session.user.id,id:b.id})})}catch(e){fail(res,e)}});
 // What the builder created, and taking the newest build down again. Deleting needs a review first and the typed sentence it returns.
 router.get('/builder/history',auth,owner,async(req,res)=>{try{res.json(await builder.history({guildId:req.guild.id}))}catch(e){fail(res,e)}});
 router.post('/builder/undo/prepare',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).join(',')!=='confirmed'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.prepareUndo({guild:req.guild,userId:req.session.user.id})})}catch(e){fail(res,e)}});
 router.post('/builder/undo/apply',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmation,id')throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.undo({guild:req.guild,userId:req.session.user.id,id:b.id,confirmation:b.confirmation})})}catch(e){fail(res,e)}});
 router.post('/builder/undo/forget',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='buildId,confirmed'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await builder.forget({guild:req.guild,userId:req.session.user.id,buildId:b.buildId,confirmed:true})})}catch(e){fail(res,e)}});
 router.post('/search',auth,owner,csrf,async(req,res)=>{try{const b=req.body;if(!b||Object.keys(b).sort().join(',')!=='confirmed,query'||b.confirmed!==true)throw Object.assign(Error('Konfirmasi diperlukan.'),{status:400});res.json({ok:true,...await searchService.search({guildId:req.guild.id,userId:req.session.user.id,query:b.query,consent:true})})}catch(e){fail(res,e)}});
 // "Fitur pintar": FAQ, reply cache, usage report, message menu, morning digest, greeting extras, auto-translate.
 // Each section is saved on its own; the FAQ gets a larger body limit for its 25 answers.
 const smart=client.aiSmart||createSmart({client,foundation:()=>foundation,searchService:()=>searchService});
 const textChannels=guild=>[...guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));
 const searchReady=()=>{const provider=resolveSearchProvider(env);return !provider.unknown&&provider.missing.length===0};
 router.get('/smart',auth,owner,async(req,res)=>{try{res.json({settings:await smart.settings({strict:true}),channels:textChannels(req.guild),languages:LANGUAGES,menus:MESSAGE_MENUS,search:{configured:searchReady()},limits:{channels:MAX_SMART_CHANNELS,faqEntries:MAX_FAQ_ENTRIES}})}catch(e){fail(res,e)}});
 const saveSmart=async(req,res)=>{
  try{
   const section=req.params.section??'faq',before=(await smart.settings({strict:true})).menu;
   const settings=await smart.saveSection(section,req.body,req.guild);
   // A menu entry switched on or off has to be registered again with Discord; the settings are saved either way.
   let menuSync=null;
   if(section==='menu'&&MESSAGE_MENUS.some(({key})=>before[key]!==settings.menu[key]))menuSync=typeof client.registerCommands==='function'?await client.registerCommands()===true:false;
   res.json({ok:true,settings,menuSync});
  }catch(e){fail(res,e)}
 };
 router.patch('/smart/faq',auth,owner,csrf,express.json({limit:'96kb'}),saveSmart);
 router.patch('/smart/:section',auth,owner,csrf,saveSmart);
 router.get('/smart/usage',auth,owner,async(req,res)=>{
  try{
   const days=Number(req.query.days??7);if(!Number.isInteger(days)||days<1||days>MAX_REPORT_DAYS)throw Object.assign(Error(`Rentang hari harus 1–${MAX_REPORT_DAYS}.`),{status:400});
   const [settings,limits,report]=[await smart.settings({strict:true}),await foundation.store.read(req.guild.id),await smart.usage.report(req.guild.id,days)];
   const members=report.members.map(row=>({...row,name:req.guild.members.cache.get(row.userId)?.displayName??null}));
   res.json({enabled:settings.usage.enabled,limits:{perUserDaily:limits.perUserDaily,guildDaily:limits.guildDaily},...report,members});
  }catch(e){fail(res,e)}
 });
 router.post('/smart/digest/test',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi pengiriman diperlukan.'});
  try{res.json({ok:true,...await smart.digest.sendNow(req.guild,(await smart.settings({strict:true})).digest)})}catch(e){fail(res,e)}
 });
 router.post('/test',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi biaya dan pengiriman ke provider diperlukan.'});
  try{const result=await foundation.generate({guildId:req.guild.id,userId:req.session.user.id,consent:true,kind:'test',prompt:'Jawab singkat dengan kalimat: Koneksi AI siap diuji.'});res.json({ok:true,...result});}catch(e){fail(res,e)}
 });
 return router;
}
