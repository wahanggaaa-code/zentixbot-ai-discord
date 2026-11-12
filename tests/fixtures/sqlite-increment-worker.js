import {openSQLiteStore} from '../../src/services/storage/sqlite.js';
const db=await openSQLiteStore({path:process.argv[2],busyTimeout:5000});
for(let i=0;i<100;i++)db.transaction(tx=>tx.set('counter',(tx.get('counter')??0)+1));
db.close();
