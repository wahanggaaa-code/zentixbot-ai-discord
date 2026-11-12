import {sqliteBackend} from '../storage/sqlite.js';
import {getUserLevelKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
const fail=(message,code='LEVEL_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
export function isSQLiteLevelBackend(client){return client?.db?.db?.sqlite?.dialect==='sqlite'}
function store(client,guild,user){if(!isSQLiteLevelBackend(client))throw fail('SQLite backend unavailable');const sqlite=sqliteBackend(client);if(!sqlite)throw fail('Persistent storage unavailable','LEVEL_UNAVAILABLE');if(!id(guild)||!id(user)||(client.homeGuildId&&client.homeGuildId!==guild))throw fail('Invalid level identity');return sqlite;}
const defaults=()=>({xp:0,level:0,totalXp:0,lastMessage:0,rank:0});
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||(value.ok!==undefined&&value.value!==undefined))throw fail('Invalid level record');
 const merged={...defaults(),...value};
 for(const field of ['xp','level','totalXp','lastMessage','rank'])if(!Number.isSafeInteger(merged[field])||merged[field]<0)throw fail('Invalid level value');
 if(merged.level>1000)throw fail('Level outside supported range');return merged;
}
function load(tx,guild,user){
 if(!id(guild)||!id(user))throw fail('Invalid level identity');const key=getUserLevelKey(guild,user),keys=[key,...getLegacyVariantsForCanonical(key)];let found=null,source=null;
 for(const k of keys){if(tx.hasRawAIKey(k))throw fail('Level data conflicts with AI storage','LEVEL_LEGACY_CONFLICT');const raw=tx.botGetRaw(k);if(!raw)continue;if(found||raw.expiresAt!==null)throw fail('Conflicting or expiring level data','LEVEL_LEGACY_CONFLICT');found=raw;source=k;}
 return {key,source,value:found?validate(found.value):defaults(),exists:Boolean(found)};
}
export function readSQLiteLevel(client,guild,user){const sqlite=store(client,guild,user);return sqlite.transaction(tx=>load(tx,guild,user).value)}
// The callback must be synchronous and free of Discord/network/external effects.
// Return {write:false,result} to leave data untouched, or {result} to save.
export function mutateLevelInTransaction(tx,guild,user,mutate){
 if(typeof mutate!=='function'||mutate.constructor?.name==='AsyncFunction')throw fail('Level mutation must be synchronous');const record=load(tx,guild,user),out=mutate(record.value,record.exists);
 if(!out||typeof out!=='object'||(out&&typeof out.then==='function'))throw fail('Invalid level mutation result');
 if(out.write===false)return out.result;
 const value=validate(record.value);tx.botSet(record.key,value);if(record.source&&record.source!==record.key)tx.botDelete(record.source);return out.result;
}
export function mutateSQLiteLevel(client,guild,user,mutate){const sqlite=store(client,guild,user);return sqlite.transaction(tx=>mutateLevelInTransaction(tx,guild,user,mutate))}
export function deleteSQLiteLevel(client,guild,user){const sqlite=store(client,guild,user);return sqlite.transaction(tx=>{const record=load(tx,guild,user);if(record.exists){tx.botDelete(record.key);if(record.source&&record.source!==record.key)tx.botDelete(record.source)}return true})}
