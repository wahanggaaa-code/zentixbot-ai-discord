import {openSQLiteStore} from '../../src/services/storage/sqlite.js';
import {createSQLiteBotDatabase} from '../../src/services/storage/sqliteBotDatabase.js';
import {updateGuildConfig} from '../../src/services/config/guildConfig.js';
const [path,guild,key]=process.argv.slice(2),sqlite=await openSQLiteStore({path,busyTimeout:5000}),adapter=createSQLiteBotDatabase(sqlite),client={homeGuildId:guild,db:{isAvailable:()=>true,getStatus:()=>({isDegraded:false}),db:adapter}};
for(let i=0;i<30;i++)await updateGuildConfig(client,guild,{[key]:i});
sqlite.close();
