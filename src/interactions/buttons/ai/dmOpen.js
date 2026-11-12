import {MessageFlags} from 'discord.js';
import {createChatStore} from '../../../services/ai/chat.js';
import {dmPrompt} from '../../../services/ai/dmPanel.js';
export default {name:'ai_dm_open',async execute(interaction,client,args){
 if(args.length!==1||args[0]!==client.homeGuildId||interaction.guildId!==client.homeGuildId||interaction.user.bot||interaction.message?.author?.id!==client.user?.id)return interaction.reply({content:'Panel tidak valid.',flags:MessageFlags.Ephemeral});
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 try{const cfg=await createChatStore(client).read(interaction.guildId);if(!cfg.dmEnabled||cfg.channelId!==interaction.channelId)return interaction.editReply('Panel DM tidak aktif di channel ini.');await interaction.user.send(dmPrompt(interaction.guildId,interaction.user.id));return interaction.editReply('Periksa DM untuk melanjutkan.');}catch{return interaction.editReply('Tidak dapat membuka DM atau memuat pengaturan.');}
}};
