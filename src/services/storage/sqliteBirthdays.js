import {sqliteBackend} from './sqlite.js';
import {getGuildBirthdaysKey,getBirthdayLeftBackupKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
const fail=(message,code='BIRTHDAY_INVALID')=>Object.assign(new Error(message),{code});
const id=value=>typeof value==='string'&&/^\d{17,20}$/.test(value);
export function validBirthday(month,day){return Number.isInteger(month)&&Number.isInteger(day)&&month>=1&&month<=12&&day>=1&&day<=[31,29,31,30,31,30,31,31,30,31,30,31][month-1]}
export function isSQLiteBirthdayBackend(client){return client?.db?.db?.sqlite?.dialect==='sqlite'}
function store(client,guild){if(!isSQLiteBirthdayBackend(client))throw fail('SQLite birthday backend unavailable');const sqlite=sqliteBackend(client);if(!sqlite)throw fail('Persistent storage unavailable','BIRTHDAY_UNAVAILABLE');if(!id(guild)||(client.homeGuildId&&client.homeGuildId!==guild))throw fail('Invalid guild');return sqlite}
function load(tx,key){
 const keys=[key,...getLegacyVariantsForCanonical(key)];let found=null,source=null;
 for(const k of keys){if(tx.hasRawAIKey(k))throw fail('Birthday key conflicts with AI storage','BIRTHDAY_LEGACY_CONFLICT');const raw=tx.botGetRaw(k);if(!raw)continue;if(found)throw fail('Birthday aliases conflict','BIRTHDAY_LEGACY_CONFLICT');if(raw.expiresAt!==null)throw fail('Birthday expiry requires review','BIRTHDAY_LEGACY_CONFLICT');found=raw;source=k;}
 if(!found)return {value:{},source:null};const value=found.value;
 if(!value||typeof value!=='object'||Array.isArray(value)||(value.ok!==undefined&&value.value!==undefined))throw fail('Invalid birthday map');
 for(const [user,birthday] of Object.entries(value))if(!id(user)||!birthday||typeof birthday!=='object'||Array.isArray(birthday)||!validBirthday(birthday.month,birthday.day))throw fail('Invalid birthday record');
 return {value,source};
}
function write(tx,key,loaded,value){tx.botSet(key,value);if(loaded.source&&loaded.source!==key)tx.botDelete(loaded.source)}
export function readSQLiteBirthdays(client,guild){const sqlite=store(client,guild);return sqlite.transaction(tx=>load(tx,getGuildBirthdaysKey(guild)).value)}
export function setSQLiteBirthday(client,guild,user,month,day){const sqlite=store(client,guild);if(!id(user)||!validBirthday(month,day))throw fail('Invalid birthday');return sqlite.transaction(tx=>{const key=getGuildBirthdaysKey(guild),current=load(tx,key);current.value[user]={month,day};write(tx,key,current,current.value);return true})}
export function deleteSQLiteBirthday(client,guild,user){const sqlite=store(client,guild);if(!id(user))throw fail('Invalid user');return sqlite.transaction(tx=>{const key=getGuildBirthdaysKey(guild),current=load(tx,key);if(Object.hasOwn(current.value,user)){delete current.value[user];write(tx,key,current,current.value)}return true})}
export function moveSQLiteBirthdayOnLeave(client,guild,user){const sqlite=store(client,guild);if(!id(user))throw fail('Invalid user');return sqlite.transaction(tx=>{const key=getGuildBirthdaysKey(guild),backupKey=getBirthdayLeftBackupKey(guild),current=load(tx,key),backup=load(tx,backupKey),value=current.value[user];if(!value)return false;if(backup.value[user]&&JSON.stringify(backup.value[user])!==JSON.stringify(value))throw fail('Existing birthday backup conflicts','BIRTHDAY_BACKUP_CONFLICT');backup.value[user]=value;delete current.value[user];write(tx,backupKey,backup,backup.value);write(tx,key,current,current.value);return true})}
export function restoreSQLiteBirthdayOnJoin(client,guild,user){const sqlite=store(client,guild);if(!id(user))throw fail('Invalid user');return sqlite.transaction(tx=>{const key=getGuildBirthdaysKey(guild),backupKey=getBirthdayLeftBackupKey(guild),current=load(tx,key),backup=load(tx,backupKey),value=backup.value[user];if(!value)return false;if(current.value[user]&&JSON.stringify(current.value[user])!==JSON.stringify(value))throw fail('Existing birthday conflicts with backup','BIRTHDAY_BACKUP_CONFLICT');current.value[user]=value;delete backup.value[user];write(tx,key,current,current.value);write(tx,backupKey,backup,backup.value);return true})}
