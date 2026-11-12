// economyService.js

import { logger } from '../utils/logger.js';
import { getMaxBankCapacity } from '../utils/economy.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { wrapServiceClassMethods } from '../utils/serviceErrorBoundary.js';
import { withEconomyTransaction } from './economy/transaction.js';

class EconomyService {

  static DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
  static WORK_COOLDOWN = 30 * 60 * 1000;
  static GAMBLE_COOLDOWN = 5 * 60 * 1000;
  static CRIME_COOLDOWN = 60 * 60 * 1000;
  static ROB_COOLDOWN = 4 * 60 * 60 * 1000;
  static MINE_COOLDOWN = 60 * 60 * 1000;
  static FISH_COOLDOWN = 45 * 60 * 1000;
  static BEG_COOLDOWN = 30 * 60 * 1000;
  
  static DAILY_AMOUNT = 1000;
  static MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

  static assertSafeBalance(value, context = {}) {
    if (!Number.isSafeInteger(value) || value < 0 || value > this.MAX_SAFE_INTEGER) {
      throw createError(
        "Invalid balance state",
        ErrorTypes.VALIDATION,
        "Operation would create an invalid account balance.",
        { value, ...context }
      );
    }
  }

  static async claimDaily(client, guildId, userId) {
    const now=Date.now();
    return withEconomyTransaction(client,guildId,[userId],accounts=>{
      const userData=accounts.get(userId),remaining=(userData.lastDaily||0)+this.DAILY_COOLDOWN-now;
      if(remaining>0)throw createError('Daily cooldown active',ErrorTypes.RATE_LIMIT,`You need to wait before claiming daily again. Try again in **${this.formatDuration(remaining)}**.`,{remaining,cooldownType:'daily'});
      const earned=this.DAILY_AMOUNT,nextWallet=userData.wallet+earned;this.assertSafeBalance(nextWallet,{operation:'claimDaily',userId,guildId});userData.wallet=nextWallet;userData.lastDaily=now;
      return {earned,newWallet:nextWallet,nextClaimTime:new Date(now+this.DAILY_COOLDOWN)};
    });
  }

  static async transferMoney(client, guildId, senderId, receiverId, amount) {
    if (senderId === receiverId) throw createError('Cannot pay self', ErrorTypes.VALIDATION, 'You cannot pay yourself.', { senderId });
    this.validateAmount(amount, { operation: 'transfer', senderId, receiverId });
    const result = await withEconomyTransaction(client, guildId, [senderId, receiverId], accounts => {
      const sender = accounts.get(senderId), receiver = accounts.get(receiverId);
      if (sender.wallet < amount) throw createError('Insufficient funds', ErrorTypes.VALIDATION, `You only have **$${sender.wallet.toLocaleString()}** in cash.`, { required: amount, available: sender.wallet, senderId });
      const senderNext = sender.wallet - amount, receiverNext = receiver.wallet + amount;
      this.assertSafeBalance(senderNext, { operation: 'transfer.sender', senderId, amount });
      this.assertSafeBalance(receiverNext, { operation: 'transfer.receiver', receiverId, amount });
      sender.wallet = senderNext; receiver.wallet = receiverNext;
      return { senderNewBalance: senderNext, receiverNewBalance: receiverNext };
    });
    logger.info('[ECONOMY_TRANSACTION] Money transferred', { senderId, receiverId, guildId, amount, ...result });
    return result;
  }

  static async addMoney(client,guildId,userId,amount,source='unknown'){
    this.validateAmount(amount,{operation:'addMoney',userId,source});
    const result=await withEconomyTransaction(client,guildId,[userId],accounts=>{const userData=accounts.get(userId),balanceBefore=userData.wallet,next=balanceBefore+amount;this.assertSafeBalance(next,{operation:'addMoney',userId,source,amount});userData.wallet=next;return {userData,balanceBefore};});
    logger.info('[ECONOMY_TRANSACTION] Money added',{userId,guildId,amount,source,balanceBefore:result.balanceBefore,balanceAfter:result.userData.wallet});return result.userData;
  }

  static async removeMoney(client,guildId,userId,amount,reason='unknown'){
    this.validateAmount(amount,{operation:'removeMoney',userId,reason});
    const result=await withEconomyTransaction(client,guildId,[userId],accounts=>{const userData=accounts.get(userId),balanceBefore=userData.wallet;if(balanceBefore<amount)throw createError('Insufficient funds',ErrorTypes.VALIDATION,`You only have **$${balanceBefore.toLocaleString()}**.`,{required:amount,available:balanceBefore,reason});userData.wallet=balanceBefore-amount;return {userData,balanceBefore};});
    logger.info('[ECONOMY_TRANSACTION] Money removed',{userId,guildId,amount,reason,balanceBefore:result.balanceBefore,balanceAfter:result.userData.wallet});return result.userData;
  }

  static async depositToBank(client,guildId,userId,amount){
    this.validateAmount(amount,{operation:'deposit',userId});
    return withEconomyTransaction(client,guildId,[userId],accounts=>{const data=accounts.get(userId),maxBank=getMaxBankCapacity(data);if(data.wallet<amount)throw createError('Insufficient cash',ErrorTypes.VALIDATION,`You only have **$${data.wallet.toLocaleString()}** in cash.`,{required:amount,available:data.wallet});if(data.bank+amount>maxBank)throw createError('Bank capacity exceeded',ErrorTypes.VALIDATION,`Your bank can only hold **$${maxBank.toLocaleString()}**.`,{capacity:maxBank,current:data.bank,requested:amount});this.assertSafeBalance(data.wallet-amount);this.assertSafeBalance(data.bank+amount);data.wallet-=amount;data.bank+=amount;return data;});
  }

  static async withdrawFromBank(client,guildId,userId,amount){
    this.validateAmount(amount,{operation:'withdraw',userId});
    return withEconomyTransaction(client,guildId,[userId],accounts=>{const data=accounts.get(userId);if(data.bank<amount)throw createError('Insufficient bank balance',ErrorTypes.VALIDATION,`You only have **$${data.bank.toLocaleString()}** in your bank.`,{required:amount,available:data.bank});this.assertSafeBalance(data.wallet+amount);this.assertSafeBalance(data.bank-amount);data.wallet+=amount;data.bank-=amount;return data;});
  }

  static checkCooldown(userData, action, cooldownMs) {
    const lastActionField = `last${action.charAt(0).toUpperCase() + action.slice(1)}`;
    const lastTime = userData[lastActionField] || 0;
    const now = Date.now();
    const remaining = Math.max(0, lastTime + cooldownMs - now);

    return {
      isOnCooldown: remaining > 0,
      remaining,
      formatted: this.formatDuration(remaining),
      nextAvailable: new Date(lastTime + cooldownMs)
    };
  }

  static validateAmount(amount, context = {}) {
    if (!Number.isInteger(amount)) {
      throw createError(
        "Invalid amount - not an integer",
        ErrorTypes.VALIDATION,
        "Amount must be a whole number",
        context
      );
    }

    if (amount <= 0) {
      throw createError(
        "Invalid amount - not positive",
        ErrorTypes.VALIDATION,
        "Amount must be positive",
        context
      );
    }

    if (amount > this.MAX_SAFE_INTEGER) {
      logger.error(`[ECONOMY] Amount exceeds MAX_SAFE_INTEGER`, { amount, context });
      throw createError(
        "Amount too large",
        ErrorTypes.VALIDATION,
        "The amount is too large to process",
        context
      );
    }
  }

  static formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  static formatCooldownDisplay(ms) {
    const duration = this.formatDuration(ms);
    return `**${duration}**`;
  }
}

wrapServiceClassMethods(EconomyService, (methodName) => ({
  service: 'EconomyService',
  operation: methodName,
  message: `Economy service operation failed: ${methodName}`,
  userMessage: 'An economy operation failed. Please try again in a moment.'
}));

export default EconomyService;