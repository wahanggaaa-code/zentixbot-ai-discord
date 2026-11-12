import test from 'node:test';import assert from 'node:assert/strict';
import {LogIgnoreSchema,LoggingConfigSchema,GuildConfigSchema,EconomyDataSchema,normalizeGuildConfig,normalizeEconomyData} from '../src/utils/schemas.js';
import {validateChatInputPayloadOrThrow} from '../src/utils/commandInputValidation.js';
test('zod migration preserves common guild, logging and economy normalization',()=>{
 assert.deepEqual(LogIgnoreSchema.parse({}),{users:[],channels:[]});assert.deepEqual(JSON.parse(JSON.stringify(LoggingConfigSchema.parse({}))),{enabled:false,enabledEvents:{}});assert.deepEqual(JSON.parse(JSON.stringify(GuildConfigSchema.parse({}))),{});
 assert.deepEqual(JSON.parse(JSON.stringify(LoggingConfigSchema.parse({enabled:true,channels:{audit:'123'},enabledEvents:{message:true}}))),{enabled:true,channels:{audit:'123'},enabledEvents:{message:true}});
 const normalized=normalizeGuildConfig({prefix:'!',logChannelId:'123',enableLogging:true});assert.equal(normalized.logging.enabled,true);assert.equal(normalized.logging.channels.audit,'123');assert.equal(normalized.logChannelId,undefined);
 assert.equal(EconomyDataSchema.safeParse({wallet:-1}).success,false);const e=normalizeEconomyData({wallet:120,inventory:{item:2},cooldowns:{daily:4}});assert.equal(e.wallet,120);assert.equal(e.bank,0);assert.deepEqual(e.inventory,{item:2});assert.equal(e.cooldowns.daily,4);
 assert.equal(GuildConfigSchema.safeParse({disabledCommands:{foo:'yes'}}).success,false);
});
test('zod migration validates Discord input including attachment IDs and rejects oversize',()=>{
 const ok={commandName:'aichat',options:{data:[{name:'image',type:11,value:'123456789012345678'}]}};assert.equal(validateChatInputPayloadOrThrow(ok).options[0].type,11);
 assert.throws(()=>validateChatInputPayloadOrThrow({commandName:'aichat',options:{data:Array.from({length:26},(_,i)=>({name:`x${i}`,type:3,value:'a'}))}}));
});
