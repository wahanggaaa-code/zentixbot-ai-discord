import { SlashCommandBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { runChat, createChatStore, clearChatMemory, viewChatMemory } from '../../services/ai/chat.js';
export default {
 data:new SlashCommandBuilder().setName('aichat').setDescription('Ask AI in the configured channel; content is sent to an external provider.')
  .setDMPermission(false)
  .addStringOption(o=>o.setName('mode').setDescription('Channel or private DM').addChoices({name:'Channel',value:'channel'},{name:'DM',value:'dm'},{name:'Lihat memori sementara',value:'memory'},{name:'Hapus memori sementara',value:'clear'}))
  .addStringOption(o=>o.setName('question').setDescription('For channel mode. Do not include sensitive information.').setMaxLength(1500))
  .addBooleanOption(o=>o.setName('consent').setDescription('Agree to send question and selected context to AI providers.'))
  .addBooleanOption(o=>o.setName('memory').setDescription('Opt in: use and store short temporary channel history.'))
  .addBooleanOption(o=>o.setName('knowledge').setDescription('Use public server documents if owner enabled access.'))
  .addAttachmentOption(o=>o.setName('image').setDescription('Optional PNG/JPEG up to 1 MB; sent to AI providers.')),
 async execute(interaction,guildConfig,client){
  if(interaction.guildId!==client.homeGuildId||!interaction.inGuild()||interaction.user.bot)return interaction.reply({content:'Command hanya tersedia untuk anggota server.',flags:MessageFlags.Ephemeral});
  const mode=interaction.options.getString('mode')||'channel';
  if(mode==='clear'){clearChatMemory(interaction.guildId,interaction.user.id);return interaction.reply({content:'Memori chat sementara dihapus.',flags:MessageFlags.Ephemeral});}
  if(mode==='memory'){const turns=viewChatMemory(interaction.guildId,interaction.user.id);const text=turns.map(t=>`Anda: ${t.question}\nAI: ${t.answer}`).join('\n\n');return interaction.reply({content:text||'Tidak ada memori sementara.',flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});}
  if(mode==='dm'){
   await interaction.deferReply({flags:MessageFlags.Ephemeral});
   try{const cfg=await createChatStore(client).read(interaction.guildId);if(!cfg.dmEnabled)return interaction.editReply('Chat AI DM belum diaktifkan.');
    await interaction.user.send({content:'Chat AI DM: isi pertanyaan hanya jika kamu setuju mengirimnya ke provider eksternal. Jangan kirim data sensitif. Provider mungkin menyimpan data sesuai kebijakannya. Tombol hanya untukmu.',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ai_dm_compose:${interaction.guildId}:${interaction.user.id}`).setLabel('Setuju dan tulis pertanyaan').setStyle(ButtonStyle.Primary))],allowedMentions:{parse:[]}});
    return interaction.editReply('Periksa DM untuk membaca persetujuan dan memulai chat.');
   }catch{return interaction.editReply('Tidak dapat membuka DM atau memuat pengaturan.');}
  }
  const consent=interaction.options.getBoolean('consent'),question=interaction.options.getString('question');
  if(consent!==true)return interaction.reply({content:'Persetujuan pengiriman ke provider diperlukan. Jangan kirim data sensitif.',flags:MessageFlags.Ephemeral});
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  try{const result=await runChat({client,guildId:interaction.guildId,channelId:interaction.channelId,userId:interaction.user.id,question,consent,memory:interaction.options.getBoolean('memory')===true,useKnowledge:interaction.options.getBoolean('knowledge')===true,attachment:interaction.options.getAttachment('image')});await interaction.editReply({content:(result.text+(result.sources.length?'\n\nSumber kandidat: '+result.sources.map(x=>`[${x.index}] ${x.name}`).join(', '):'')).slice(0,2000),allowedMentions:{parse:[]}});}
  catch(e){await interaction.editReply({content:e.status&&e.status<500?e.message:'Chat AI tidak tersedia. Coba lagi nanti.',allowedMentions:{parse:[]}});}
 }
};
