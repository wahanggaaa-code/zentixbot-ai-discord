import {requireDMMembership,viewChatMemory,clearChatMemory} from '../../../services/ai/chat.js';
function valid(i,c,args){return args.length===2&&!i.guildId&&args[0]===c.homeGuildId&&args[1]===i.user.id&&i.message?.author?.id===c.user?.id;}
export default [
 {name:'ai_dm_memory',async execute(i,c,args){if(!valid(i,c,args)||!await requireDMMembership(c,args[0],args[1]))return i.reply({content:'Memori tidak tersedia.'});const turns=viewChatMemory(args[0],args[1],Date.now(),'dm'),text=turns.map(t=>`Anda: ${t.question}\nAI: ${t.answer}`).join('\n\n');return i.reply({content:text||'Tidak ada memori DM sementara.',allowedMentions:{parse:[]}})}},
 {name:'ai_dm_clear',async execute(i,c,args){if(!valid(i,c,args))return i.reply({content:'Memori tidak tersedia.'});clearChatMemory(args[0],args[1],'dm');return i.reply({content:'Memori DM sementara dihapus.',allowedMentions:{parse:[]}})}}
];
