import {ModalBuilder,ActionRowBuilder,TextInputBuilder,TextInputStyle} from 'discord.js';
import {createChatStore,requireDMMembership} from '../../../services/ai/chat.js';
export default {name:'ai_dm_compose',async execute(interaction,client,args){
 const [guildId,userId]=args;
 if(args.length!==2||interaction.guildId||interaction.user.id!==userId||!await requireDMMembership(client,guildId,userId))return interaction.reply({content:'Chat hanya tersedia untuk anggota server utama.'});
 try{const cfg=await createChatStore(client).read(guildId);if(!cfg.dmEnabled)return interaction.reply({content:'Chat DM tidak aktif.'});
  const modal=new ModalBuilder().setCustomId(`ai_dm_form:${guildId}:${userId}`).setTitle('Kirim pertanyaan ke provider AI');
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('question').setLabel('Pertanyaan (jangan kirim data sensitif)').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)));
  await interaction.showModal(modal);
 }catch{await interaction.reply({content:'Chat DM belum tersedia.'}).catch(()=>{});}
}};
