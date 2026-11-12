import test from 'node:test';import assert from 'node:assert/strict';
import {readChatFile} from '../src/services/ai/chatFile.js';import {runChat,DEFAULT_CHAT} from '../src/services/ai/chat.js';
const guildId='123456789012345678',userId='234567890123456789',channelId='345678901234567890';
test('file chat extracts bounded UTF-8 without storage',async()=>{
 const download=async(a,max)=>{assert.equal(max,12000);return Buffer.from('Halo, file!')};assert.equal(await readChatFile({name:'catatan.md'},{download}),'Halo, file!');
 await assert.rejects(readChatFile({name:'bad.exe'},{download}),{status:400});await assert.rejects(readChatFile({name:'x.txt'},{download:async()=>Buffer.alloc(2001,65)}),{status:400});await assert.rejects(readChatFile({name:'x.txt'},{download:async()=>Buffer.from([255])}),{status:400});
 await assert.rejects(readChatFile({name:'doc.pdf'},{download}),{status:400});
});
test('file chat needs owner activation and user consent; document contents treated as data',async()=>{
 let cfg={...DEFAULT_CHAT,enabled:true,channelId},reads=0,prompt;const request={client:{homeGuildId:guildId},guildId,channelId,userId,question:'Ringkas',consent:true,fileAttachment:{name:'x.txt'},fetchFile:async()=>{reads++;return 'isi file'},store:{read:async()=>cfg},foundation:{generate:async p=>{prompt=p.prompt;return {text:'ok'}}}};
 await assert.rejects(runChat(request),{status:403});await assert.rejects(runChat({...request,consent:false}),{status:403});assert.equal(reads,0);cfg={...cfg,fileEnabled:true};await runChat(request);assert.match(prompt,/FILE \(data pengguna\): isi file/);assert.equal(reads,1);await assert.rejects(runChat({...request,attachment:{}}),{status:400});
});
