import {sqliteBackend} from './sqlite.js';
import {getGuildBirthdaysKey,getBirthdayLeftBackupKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
import {validBirthday} from '../../utils/birthdayDates.js';
const fail=(message,code='BIRTHDAY_INVALID')=>Object.assign(new Error(message),{code});
const id=value=>typeof value==='string'&&/^\d{17,20}$/.test(value);
export {validBirthday};
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

// ---- dashboard --------------------------------------------------------------
// Same rules as on PostgreSQL: an edit needs the date the page showed, a new record never
// replaces an existing one, and a member with a leave backup is left for review.
const dateInput=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')==='day,month'&&validBirthday(x.month,x.day);
const sameDate=(a,b)=>a.month===b.month&&a.day===b.day;
/** Every stored date of the guild as `{user_id,month,day}`, ordered by month, day and user id. */
export function listSQLiteBirthdays(client,guild){
 const value=readSQLiteBirthdays(client,guild);
 return Object.entries(value).map(([user_id,b])=>({user_id,month:b.month,day:b.day})).sort((a,b)=>a.month-b.month||a.day-b.day||(a.user_id.length-b.user_id.length)||(a.user_id<b.user_id?-1:a.user_id>b.user_id?1:0));
}
/** Whether a member has a stored date. Does not return the date. */
export function hasSQLiteBirthday(client,guild,user){if(!id(user))throw fail('Invalid user');return Object.hasOwn(readSQLiteBirthdays(client,guild),user)}
export function updateSQLiteBirthdayFromDashboard(client,guild,user,expected,next){
 const sqlite=store(client,guild);if(!id(user)||!dateInput(expected)||(next!==null&&!dateInput(next)))throw fail('Invalid birthday input');
 return sqlite.transaction(tx=>{
  const key=getGuildBirthdaysKey(guild),current=load(tx,key),row=Object.hasOwn(current.value,user)?current.value[user]:null;
  if(!row||!sameDate(row,expected))throw fail('Birthday changed; reload before saving','BIRTHDAY_STALE');
  if(Object.hasOwn(load(tx,getBirthdayLeftBackupKey(guild)).value,user))throw fail('Birthday leave backup requires review','BIRTHDAY_BACKUP_CONFLICT');
  if(next===null)delete current.value[user];else current.value[user]={month:next.month,day:next.day};
  write(tx,key,current,current.value);return true;
 });
}
export function addSQLiteBirthdayFromDashboard(client,guild,user,next){
 const sqlite=store(client,guild);if(!id(user)||!dateInput(next))throw fail('Invalid birthday input');
 return sqlite.transaction(tx=>{
  const key=getGuildBirthdaysKey(guild),current=load(tx,key);
  if(Object.hasOwn(current.value,user))throw fail('Birthday already exists','BIRTHDAY_EXISTS');
  if(Object.hasOwn(load(tx,getBirthdayLeftBackupKey(guild)).value,user))throw fail('Birthday leave backup requires review','BIRTHDAY_BACKUP_CONFLICT');
  current.value[user]={month:next.month,day:next.day};write(tx,key,current,current.value);return true;
 });
}
