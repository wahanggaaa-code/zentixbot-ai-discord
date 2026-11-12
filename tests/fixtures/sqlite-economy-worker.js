import {openSQLiteStore} from '../../src/services/storage/sqlite.js';
import {withEconomyTransaction} from '../../src/services/economy/transaction.js';
const [path,guild,user]=process.argv.slice(2),sqlite=await openSQLiteStore({path,busyTimeout:5000});
const client={homeGuildId:guild,db:{getStatus:()=>({isDegraded:false}),isAvailable:()=>true,db:{sqlite,isAvailable:()=>true}}};
for(let i=0;i<50;i++)await withEconomyTransaction(client,guild,[user],accounts=>accounts.get(user).wallet++);
sqlite.close();
