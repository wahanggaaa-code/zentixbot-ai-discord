import {MessageFlags} from 'discord.js';
import {createActivityStore} from '../../../services/ai/activities.js';
export default {name:'ai_quiz_points',async execute(interaction,client,args){
 if(interaction.guildId!==client.homeGuildId||interaction.user.bot||args.length!==1||args[0]!=='view')return interaction.reply({content:'Tidak tersedia.',flags:MessageFlags.Ephemeral});
 await interaction.deferReply({flags:MessageFlags.Ephemeral});
 try{const n=await createActivityStore(client).points(interaction.guildId,interaction.user.id);await interaction.editReply({content:`Saldo poin Activities: ${n}. Poin ini terpisah dari ekonomi bot.`,allowedMentions:{parse:[]}});}catch{await interaction.editReply('Saldo poin tidak tersedia.');}
}};
