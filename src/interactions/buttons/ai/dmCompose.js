import {ModalBuilder,LabelBuilder,FileUploadBuilder,CheckboxBuilder,TextInputBuilder,TextInputStyle} from 'discord.js';
import {createChatStore,requireDMMembership} from '../../../services/ai/chat.js';
export default {name:'ai_dm_compose',async execute(interaction,client,args){
 const [guildId,userId]=args;
 if(args.length!==2||interaction.guildId||interaction.user.id!==userId||!await requireDMMembership(client,guildId,userId))return interaction.reply({content:'Chat hanya tersedia untuk anggota server utama.'});
 try{const cfg=await createChatStore(client).read(guildId);if(!cfg.dmEnabled)return interaction.reply({content:'Chat DM tidak aktif.'});
  const modal=new ModalBuilder().setCustomId(`ai_dm_form:${guildId}:${userId}`).setTitle('Setuju dan kirim ke provider AI');
  modal.addLabelComponents(
   new LabelBuilder().setLabel('Pertanyaan').setDescription('Jangan kirim informasi sensitif.').setTextInputComponent(new TextInputBuilder().setCustomId('question').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500)),
   new LabelBuilder().setLabel('Satu lampiran opsional').setDescription('PNG/JPEG, audio atau TXT/MD/CSV/JSON; dikirim ke provider.').setFileUploadComponent(new FileUploadBuilder().setCustomId('attachment').setMinValues(0).setMaxValues(1).setRequired(false)),
   new LabelBuilder().setLabel('Gunakan memori DM sementara').setDescription('Opt-in, dua pertukaran teks selama 30 menit.').setCheckboxComponent(new CheckboxBuilder().setCustomId('memory').setDefault(false)),
   new LabelBuilder().setLabel('Gunakan dokumen server').setDescription('Cuplikan dokumen dikirim ke provider bila owner mengizinkan.').setCheckboxComponent(new CheckboxBuilder().setCustomId('knowledge').setDefault(false))
  );await interaction.showModal(modal);
 }catch{await interaction.reply({content:'Chat DM belum tersedia.'}).catch(()=>{});}
}};
