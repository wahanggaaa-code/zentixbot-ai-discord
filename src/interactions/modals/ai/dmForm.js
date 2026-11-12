import {requireDMMembership,runChat} from '../../../services/ai/chat.js';
export default {name:'ai_dm_form',async execute(interaction,client,args){
 const [guildId,userId]=args;
 await interaction.deferReply();
 if(args.length!==2||interaction.guildId||interaction.user.id!==userId||!await requireDMMembership(client,guildId,userId))return interaction.editReply('Chat hanya tersedia untuk anggota server utama.');
 try{
  const question=interaction.fields.getTextInputValue('question'),memory=interaction.fields.getCheckbox('memory')===true,useKnowledge=interaction.fields.getCheckbox('knowledge')===true,files=interaction.fields.getUploadedFiles('attachment');
  if(files&&files.size>1)throw Object.assign(new Error('Hanya satu lampiran yang didukung.'),{status:400});const file=files?.first()||null,name=file?.name||'';
  let image=null,audio=null,textFile=null;if(file){if(/\.(png|jpe?g)$/i.test(name))image=file;else if(/\.(ogg|wav|mp3|m4a|mp4|flac|webm)$/i.test(name))audio=file;else if(/\.(txt|md|csv|json)$/i.test(name))textFile=file;else throw Object.assign(new Error('Jenis lampiran tidak didukung.'),{status:400});}
  const result=await runChat({client,guildId,channelId:null,userId,question,consent:true,dm:true,memory,useKnowledge,attachment:image,audioAttachment:audio,fileAttachment:textFile});
  return interaction.editReply({content:(result.text+(result.sources.length?'\n\nSumber kandidat: '+result.sources.map(x=>`[${x.index}] ${x.name}`).join(', '):'')).slice(0,2000),allowedMentions:{parse:[]}});
 }catch(e){return interaction.editReply({content:e.status&&e.status<500?e.message:'Chat AI tidak tersedia. Coba lagi nanti.',allowedMentions:{parse:[]}})}
}};
