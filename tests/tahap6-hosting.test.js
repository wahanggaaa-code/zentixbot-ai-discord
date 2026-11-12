import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {createHostingApi} from '../src/dashboard/hostingApi.js';
test('hosting is owner-only, key stays server-side, and speed uses counter deltas',async t=>{
 const owner='123456789012345678',other='234567890123456789';let count=0;
 const auth=(req,res,next)=>{req.session={user:{id:req.get('x-user')}};next()};
 const mock=async(url,opts)=>{assert.equal(url,'https://panel.example/api/client/servers/server123/resources');assert.equal(opts.headers.Authorization,'Bearer server-secret');assert.equal(opts.redirect,'error');count++;return {ok:true,json:async()=>({attributes:{current_state:'running',resources:{cpu_absolute:12,memory_bytes:100,disk_bytes:200,network_rx_bytes:count*100,network_tx_bytes:count*200}}})}};
 const app=express();app.use('/api',createHostingApi({auth,fetchImpl:mock,env:{OWNER_IDS:owner,HOSTING_PANEL_URL:'https://panel.example',HOSTING_SERVER_ID:'server123',HOSTING_API_KEY:'server-secret'}}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/hosting`;
 assert.equal((await fetch(base,{headers:{'x-user':other}})).status,403);assert.equal(count,0);
 const first=await (await fetch(base,{headers:{'x-user':owner}})).json();assert.equal(first.cpuPercent,12);assert.equal(first.networkInBytesPerSecond,null);assert.ok(!JSON.stringify(first).includes('server-secret'));
 const second=await (await fetch(base,{headers:{'x-user':owner}})).json();assert.ok(second.networkInBytesPerSecond>=0);assert.equal(count,2);
});
