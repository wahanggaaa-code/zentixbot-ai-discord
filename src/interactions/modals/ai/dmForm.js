import {requireDMMembership,runChat} from '../../../services/ai/chat.js';
export default {name:'ai_dm_form',async execute(interaction,client,args){
 const [guildId,userId]=args;
 await interaction.deferReply();
 if(args.length!==2||interaction.guildId||interaction.user.id!==userId||!await requireDMMembership(client,guildId,userId))return interaction.editReply('Chat hanya tersedia untuk anggota server utama.');
 const question=interaction.fields.getTextInputValue('question');
 try{const result=await runChat({client,guildId,channelId:null,userId,question,consent:true,dm:true});await interaction.editReply({content:result.text,allowedMentions:{parse:[]}})}catch(e){await interaction.editReply({content:e.status&&e.status<500?e.message:'Chat AI tidak tersedia. Coba lagi nanti.',allowedMentions:{parse:[]}})}
}};
