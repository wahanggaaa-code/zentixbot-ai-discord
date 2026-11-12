import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapDashboardHandler } from '../src/utils/dashboardSession.js';
import { createError, ErrorTypes } from '../src/utils/errorHandler.js';

test('nested dashboard handlers catch stale config failures and report reload without success', async () => {
  let result, success=false;
  const interaction={id:'123456789012345678',user:{id:'234567890123456789'},deferred:false,replied:false,
    async deferUpdate(){this.deferred=true;},async editReply(payload){result=payload;}};
  const handler=wrapDashboardHandler(async i=>{
    await i.deferUpdate();
    throw createError('Stale guild configuration', ErrorTypes.CONFIGURATION, 'Server settings changed. Reload before saving.');
    success=true;
  },'test');
  await assert.doesNotReject(handler(interaction));
  assert.equal(success,false);
  assert.match(result.embeds[0].data.description,/Reload before saving/);
});

test('nested handler absorbs errors even when replying also fails', async () => {
  const interaction={id:'123456789012345678',user:{id:'234567890123456789'},deferred:false,replied:false,
    async deferUpdate(){this.deferred=true;},async editReply(){throw new Error('Discord offline');}};
  await assert.doesNotReject(wrapDashboardHandler(async()=>{throw new Error('failure');},'test')(interaction));
});
