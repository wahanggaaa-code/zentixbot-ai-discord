import {withEconomyTransaction} from './transaction.js';
import {createError,ErrorTypes} from '../../utils/errorHandler.js';
import {BotConfig} from '../../config/bot.js';
const cooldown=BotConfig.economy?.cooldowns?.rob??4*60*60*1000;
const successRate=BotConfig.economy?.robSuccessRate??0.4;
// Mutation and cooldown are checked under the same two-account transaction.
export async function attemptRob({client,guildId,robberId,victimId,victimName,now=Date.now(),random=Math.random}){
 if(robberId===victimId)throw createError('Cannot rob self',ErrorTypes.VALIDATION,'You cannot rob yourself.',{robberId,victimId});
 return withEconomyTransaction(client,guildId,[robberId,victimId],accounts=>{
  const robber=accounts.get(robberId),victim=accounts.get(victimId),last=robber.lastRob||0;
  if(now<last+cooldown){const remaining=last+cooldown-now,hours=Math.floor(remaining/3600000),minutes=Math.floor(remaining%3600000/60000);throw createError('Robbery cooldown active',ErrorTypes.RATE_LIMIT,`You need to lay low. Wait **${hours}h ${minutes}m** before attempting another robbery.`,{remaining,hours,minutes,cooldownType:'rob'});}
  if(victim.wallet<500)throw createError('Victim too poor',ErrorTypes.VALIDATION,`${victimName} is too poor. They need at least $500 cash to be worth robbing.`,{victimWallet:victim.wallet,required:500});
  robber.lastRob=now;
  if((victim.inventory?.personal_safe||0)>0)return {status:'blocked',robberWallet:robber.wallet,victimWallet:victim.wallet};
  if(random()<successRate){const amount=Math.floor(victim.wallet*0.15);robber.wallet+=amount;victim.wallet-=amount;return {status:'success',amount,robberWallet:robber.wallet,victimWallet:victim.wallet};}
  const amount=Math.floor(robber.wallet*0.1);robber.wallet=Math.max(0,robber.wallet-amount);return {status:'failed',amount,robberWallet:robber.wallet,victimWallet:victim.wallet};
 });
}
