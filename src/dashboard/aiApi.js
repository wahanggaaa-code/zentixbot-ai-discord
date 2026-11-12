import express from 'express';
import { createAIFoundation, validateSettings } from '../services/ai/foundation.js';
import { ChannelType } from 'discord.js';
import { createAIWelcomeStore, validateAIWelcome, generateWelcomeTemplate } from '../services/ai/welcome.js';

export function createAIApi(client,{auth,csrf,env=process.env,foundation=client.aiFoundation||createAIFoundation({client,env}),welcomeStore=createAIWelcomeStore(client)}) {
 const router=express.Router();router.use(express.json({limit:'8kb'}));
 const owner=(req,res,next)=>{const ids=String(env.OWNER_IDS||'').split(',').map(x=>x.trim()).filter(x=>/^\d{17,20}$/.test(x));if(!ids.includes(req.session.user.id))return res.status(403).json({error:'Pengaturan dan uji AI hanya untuk owner bot.'});next()};
 const fail=(res,e)=>res.status(e.status||503).json({error:e.status?e.message:'Layanan AI atau database tidak tersedia.',code:e.code||'UNAVAILABLE'});
 router.get('/settings',auth,owner,async(req,res)=>{try{res.json({settings:await foundation.store.read(req.guild.id),credentials:foundation.credentials()})}catch(e){fail(res,e)}});
 router.patch('/settings',auth,owner,csrf,async(req,res)=>{try{const settings=validateSettings(req.body);await foundation.store.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.get('/welcome',auth,owner,async(req,res)=>{try{const settings=await welcomeStore.read(req.guild.id);const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(({id,name})=>({id,name}));res.json({settings,channels})}catch(e){fail(res,e)}});
 router.patch('/welcome',auth,owner,csrf,async(req,res)=>{try{const settings=validateAIWelcome(req.body,req.guild);await welcomeStore.save(req.guild.id,settings);res.json({ok:true,settings})}catch(e){fail(res,e)}});
 router.post('/welcome/preview',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi pengujian diperlukan.'});
  try{const cfg=await welcomeStore.read(req.guild.id);const result=await generateWelcomeTemplate({foundation,guildId:req.guild.id,actorId:req.session.user.id,cfg});res.json({ok:true,source:result.source,preview:result.template.replaceAll('{user}','@anggota').replaceAll('{server}','Server Contoh')});}catch(e){fail(res,e)}
 });
 router.post('/test',auth,owner,csrf,async(req,res)=>{
  if(!req.body||Object.keys(req.body).length!==1||req.body.confirmed!==true)return res.status(400).json({error:'Konfirmasi biaya dan pengiriman ke provider diperlukan.'});
  try{const result=await foundation.generate({guildId:req.guild.id,userId:req.session.user.id,consent:true,prompt:'Jawab singkat dengan kalimat: Koneksi AI siap diuji.'});res.json({ok:true,...result});}catch(e){fail(res,e)}
 });
 return router;
}
