import { MessageFlags } from 'discord.js';
import { createActivityStore, quizPayload } from '../../../services/ai/activities.js';
export default {
 name:'ai_quiz',
 async execute(interaction,client,args){
  const [id,choice]=args;
  if(interaction.guildId!==client.homeGuildId||!interaction.guild||interaction.user.bot||!/^[a-f0-9]{20}$/.test(id||'')||!/^[0-3]$/.test(choice||'')||args.length!==2)return interaction.reply({content:'Ronde tidak valid.',flags:MessageFlags.Ephemeral});
  await interaction.deferReply({flags:MessageFlags.Ephemeral});
  try{const result=await createActivityStore(client).answer(interaction.guildId,id,interaction.message.id,interaction.user.id,Number(choice),Date.now());
   const text={closed:'Ronde sudah ditutup atau tidak tersedia.',expired:'Waktu sudah habis.',full:'Ronde penuh.',answered:'Kamu sudah menjawab ronde ini.',wrong:'Belum tepat. Terima kasih sudah bermain!',correct:'Benar! Kamu memenangkan ronde ini.'}[result.status]||'Ronde tidak tersedia.';
   await interaction.editReply({content:text,allowedMentions:{parse:[]}});
   if(result.status==='correct'||result.status==='expired')await interaction.message.edit(quizPayload(result.question,id,{ended:result.status==='correct'?'Ronde selesai.':'Waktu habis.'})).catch(()=>{});
  }catch{await interaction.editReply({content:'Tidak dapat memproses jawaban. Coba lagi.',allowedMentions:{parse:[]}}).catch(()=>{});}
 }
};
