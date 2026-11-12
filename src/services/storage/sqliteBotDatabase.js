import {canonicalizeKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
import {parseKey,isTempBackedType} from '../../utils/database/keyParser.js';

// Experimental bot API. Startup does not select this backend yet. The bot KV table
// is separate from AI storage so equal keys in the old PG temp/cache tables cannot collide.
const failure=(message,code='SQLITE_INVALID')=>Object.assign(new Error(message),{code});
const checkKey=key=>{if(typeof key!=='string'||!key||key.length>255||/[\u0000-\u001f]/.test(key))throw failure('Key tidak valid.');return canonicalizeKey(key)};
const legacyKeys=(canonical,original)=>[...new Set([canonical,...getLegacyVariantsForCanonical(canonical),original])];
export function readSQLiteBotValue(tx,key,def=null){const canonical=checkKey(key),parsed=parseKey(canonical);if(parsed.type==='economy'){
 const data=tx.getAccount(parsed.guildId,parsed.userId);if(data!==null)return data;
 if(legacyKeys(canonical,key).some(k=>tx.botGet(k)!==null||tx.get(k)!==null))throw failure('Data ekonomi lama memerlukan migrasi.','ECONOMY_LEGACY');return def;
 }
 for(const k of legacyKeys(canonical,key)){const v=tx.botGet(k);if(v!==null)return v}return def;
}
function nonEconomy(key){const canonical=checkKey(key);if(parseKey(canonical).type==='guild_config')throw failure('Gunakan transaksi konfigurasi guild.','CONFIG_WRITE_DISABLED');if(parseKey(canonical).type==='economy')throw failure('Penulisan ekonomi lama dinonaktifkan; gunakan transaksi ekonomi.','ECONOMY_LEGACY_WRITE_DISABLED');return canonical}
function ttlToExpiry(key,ttl){if(ttl===null||ttl===undefined||ttl===0)return null;if(typeof ttl!=='number'||!Number.isFinite(ttl)||ttl<0)throw failure('TTL tidak valid.');const parsed=parseKey(key);if(parsed.type!=='cache'&&!isTempBackedType(parsed.type))return null;const value=Date.now()+ttl*1000;if(!Number.isSafeInteger(value))throw failure('TTL di luar batas.');return value;}
function canonicalPrefix(prefix){if(prefix===undefined||prefix==='')return '';if(typeof prefix!=='string'||prefix.length>255||/[\u0000-\u001f]/.test(prefix))throw failure('Prefix tidak valid.');
 let m;if((m=prefix.match(/^economy:([^:]+):/)))return `guild:${m[1]}:economy:${prefix.slice(m[0].length)}`;
 if((m=prefix.match(/^moderation:warnings:([^:]+):/)))return `guild:${m[1]}:warnings:${prefix.slice(m[0].length)}`;
 if((m=prefix.match(/^reaction_roles:([^:]+):/)))return `guild:${m[1]}:reaction_roles:${prefix.slice(m[0].length)}`;
 if((m=prefix.match(/^([^:]+):leveling:users:/))&&m[1]!=='guild')return `guild:${m[1]}:leveling:users:${prefix.slice(m[0].length)}`;
 return canonicalizeKey(prefix);
}
export function createSQLiteBotDatabase(sqlite){
 if(!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen())throw failure('SQLite tidak tersedia.','SQLITE_UNAVAILABLE');
 const view={get:sqlite.get,botGet:sqlite.botGet,getAccount:sqlite.getAccount};
 const ensure=()=>{if(!sqlite.isOpen())throw failure('SQLite tidak tersedia.','SQLITE_UNAVAILABLE')};
 const adjust=(key,amount)=>{ensure();const canonical=nonEconomy(key);if(!Number.isSafeInteger(amount))throw failure('Nilai increment tidak valid.');return sqlite.transaction(tx=>{const current=readSQLiteBotValue(tx,key,0);const n=(typeof current==='number'?current:0)+amount;if(!Number.isSafeInteger(n))throw failure('Counter di luar batas.');tx.botSet(canonical,n);return n})};
 return {
  sqlite,
  isAvailable(){return sqlite.isOpen()},
  async insertVerificationAudit(record){ensure();sqlite.transaction(tx=>tx.addVerificationAudit(record));return true;},
  async get(key,defaultValue=null){ensure();return readSQLiteBotValue(view,key,defaultValue)},
  async set(key,value,ttl=null){ensure();const canonical=nonEconomy(key),expires=ttlToExpiry(canonical,ttl);sqlite.transaction(tx=>tx.botSet(canonical,value??null,expires));return true},
  async delete(key){ensure();const canonical=nonEconomy(key);sqlite.transaction(tx=>{for(const k of legacyKeys(canonical,key))tx.botDelete(k)});return true},
  async exists(key){ensure();return readSQLiteBotValue(view,key,null)!==null},
  async list(prefix=''){ensure();const wanted=canonicalPrefix(prefix),keys=new Set();for(const key of [...sqlite.botList(),...sqlite.accountKeys()]){const c=canonicalizeKey(key);if(c.startsWith(wanted))keys.add(c)}return [...keys].sort()},
  async increment(key,amount=1){return adjust(key,amount)},
  async decrement(key,amount=1){if(!Number.isSafeInteger(amount))throw failure('Nilai decrement tidak valid.');return adjust(key,-amount)},
 };
}
