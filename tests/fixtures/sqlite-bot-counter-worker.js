import {openSQLiteStore} from '../../src/services/storage/sqlite.js';
import {createSQLiteBotDatabase} from '../../src/services/storage/sqliteBotDatabase.js';
const sqlite=await openSQLiteStore({path:process.argv[2],busyTimeout:5000}),db=createSQLiteBotDatabase(sqlite);
for(let i=0;i<75;i++)await db.increment('test:counter');
sqlite.close();
