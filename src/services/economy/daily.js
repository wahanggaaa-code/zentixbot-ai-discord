import {withEconomyTransaction} from './transaction.js';
import {createError,ErrorTypes} from '../../utils/errorHandler.js';
import {formatDuration} from '../../utils/embeds.js';
import {botConfig} from '../../config/bot.js';
const cooldown=24*60*60*1000,amount=botConfig.economy?.dailyAmount??100;
export async function claimDailyAtomic({client,guildId,userId,premium=false,now=Date.now()}){
 if(typeof premium!=='boolean'||!Number.isSafeInteger(now)||now<0)throw createError('Invalid claim',ErrorTypes.VALIDATION,'Invalid daily claim.');
 return withEconomyTransaction(client,guildId,[userId],accounts=>{
  const data=accounts.get(userId),remaining=(data.lastDaily||0)+cooldown-now;
  if(remaining>0)throw createError('Daily cooldown active',ErrorTypes.RATE_LIMIT,`You need to wait before claiming daily again. Try again in **${formatDuration(remaining)}**.`,{timeRemaining:remaining,cooldownType:'daily'});
  const bonus=premium?Math.floor(amount*0.1):0,earned=amount+bonus;data.wallet+=earned;data.lastDaily=now;
  return {earned,bonus,newWallet:data.wallet};
 });
}
