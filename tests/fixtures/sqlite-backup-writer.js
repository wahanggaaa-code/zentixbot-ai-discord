import {openSQLiteStore} from '../../src/services/storage/sqlite.js';
const s=await openSQLiteStore({path:process.argv[2],busyTimeout:5000});
process.send('ready');
process.once('message',async()=>{
 for(let i=1;i<=300;i++){
  s.transaction(tx=>{tx.set('backup:left',i);tx.set('backup:right',i)});
  if(i===1)process.send('writing');
  await new Promise(r=>setTimeout(r,1));
 }
 s.close();process.disconnect();
});
