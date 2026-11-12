import {pgConfig} from '../../config/database/postgres.js';
import {getGuildBirthdaysKey,getBirthdayLeftBackupKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
import {validBirthday} from './sqliteBirthdays.js';
const t=pgConfig.tables;
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const failure=(message,code='BIRTHDAY_INVALID')=>Object.assign(new Error(message),{code});
export const isPostgresBirthdayBackend=client=>client?.db?.getStatus?.()?.connectionType==='postgresql';
function pool(client,guild,user){
 if(!isPostgresBirthdayBackend(client)||client.db.getStatus().isDegraded||!client.db.isAvailable?.()||!client.db.db?.isAvailable?.()||!client.db.db.pool?.connect)throw failure('PostgreSQL birthday storage unavailable','BIRTHDAY_UNAVAILABLE');
 if(!validId(guild)||(client.homeGuildId&&client.homeGuildId!==guild)||(user!==undefined&&!validId(user)))throw failure('Invalid birthday identifiers');
 return client.db.db.pool;
}
function date(value){if(!obj(value)||!validBirthday(value.month,value.day))throw failure('Invalid stored birthday');return {month:value.month,day:value.day};}
async function legacy(conn,guild){
 const key=getGuildBirthdaysKey(guild),keys=[key,...getLegacyVariantsForCanonical(key)];
 for(const table of [t.temp_data,t.cache_data]){const result=await conn.query(`SELECT 1 FROM ${table} WHERE key=ANY($1::text[]) LIMIT 1`,[keys]);if(result.rowCount)throw failure('Legacy birthday data needs review','BIRTHDAY_LEGACY_CONFLICT');}
}
async function locked(client,guild,user,fn){
 const p=pool(client,guild,user),conn=await p.connect();try{
  await conn.query('BEGIN');await conn.query(`INSERT INTO ${t.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`,[guild]);
  await conn.query(`SELECT id FROM ${t.guilds} WHERE id=$1 FOR UPDATE`,[guild]);await legacy(conn,guild);
  const result=await fn(conn);await conn.query('COMMIT');return result;
 }catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release()}
}
async function current(conn,guild,user){const row=(await conn.query(`SELECT month,day FROM ${t.birthdays} WHERE guild_id=$1 AND user_id=$2 FOR UPDATE`,[guild,user])).rows[0];return row?date(row):null;}
async function put(conn,guild,user,value){await conn.query(`INSERT INTO ${t.users}(id) VALUES($1) ON CONFLICT(id) DO NOTHING`,[user]);await conn.query(`INSERT INTO ${t.birthdays}(guild_id,user_id,month,day) VALUES($1,$2,$3,$4) ON CONFLICT(guild_id,user_id) DO UPDATE SET month=EXCLUDED.month,day=EXCLUDED.day,updated_at=CURRENT_TIMESTAMP`,[guild,user,value.month,value.day]);}
async function backup(conn,guild,user){
 const key=getBirthdayLeftBackupKey(guild);
 const cache=await conn.query(`SELECT 1 FROM ${t.cache_data} WHERE key=$1`,[key]);if(cache.rowCount)throw failure('Birthday backup conflicts with cache','BIRTHDAY_LEGACY_CONFLICT');
 const result=await conn.query(`SELECT value,expires_at FROM ${t.temp_data} WHERE key=$1 FOR UPDATE`,[key]);if(!result.rowCount)return {key,value:null};const row=result.rows[0];
 if(row.expires_at!==null||!obj(row.value)||(row.value.ok!==undefined&&row.value.value!==undefined))throw failure('Birthday backup requires review','BIRTHDAY_LEGACY_CONFLICT');
 return {key,value:Object.hasOwn(row.value,user)?date(row.value[user]):null,exists:Object.hasOwn(row.value,user)};
}
const same=(a,b)=>a.month===b.month&&a.day===b.day;
export async function readPostgresBirthdays(client,guild){
 const p=pool(client,guild),conn=await p.connect();try{await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await legacy(conn,guild);const rows=(await conn.query(`SELECT user_id,month,day FROM ${t.birthdays} WHERE guild_id=$1`,[guild])).rows;const result={};for(const row of rows){if(!validId(row.user_id))throw failure('Invalid stored birthday user');result[row.user_id]=date(row)}await conn.query('COMMIT');return result}catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release()}
}
export async function setPostgresBirthday(client,guild,user,month,day){if(!validBirthday(month,day))throw failure('Invalid birthday');return locked(client,guild,user,async conn=>{await current(conn,guild,user);await put(conn,guild,user,{month,day});return true})}
export async function deletePostgresBirthday(client,guild,user){return locked(client,guild,user,async conn=>{const row=await current(conn,guild,user);if(!row)return false;await conn.query(`DELETE FROM ${t.birthdays} WHERE guild_id=$1 AND user_id=$2`,[guild,user]);return true})}
export async function movePostgresBirthdayOnLeave(client,guild,user){return locked(client,guild,user,async conn=>{
 const row=await current(conn,guild,user),saved=await backup(conn,guild,user);if(!row)return false;if(saved.exists&&!same(row,saved.value))throw failure('Birthday backup conflicts','BIRTHDAY_BACKUP_CONFLICT');
 if(!saved.exists)await conn.query(`INSERT INTO ${t.temp_data}(key,value) VALUES($1,jsonb_build_object($2::text,$3::jsonb)) ON CONFLICT(key) DO UPDATE SET value=jsonb_set(${t.temp_data}.value,ARRAY[$2::text],$3::jsonb,true)`,[saved.key,user,JSON.stringify(row)]);
 await conn.query(`DELETE FROM ${t.birthdays} WHERE guild_id=$1 AND user_id=$2`,[guild,user]);return true;
})}
export async function restorePostgresBirthdayOnJoin(client,guild,user){return locked(client,guild,user,async conn=>{
 const row=await current(conn,guild,user),saved=await backup(conn,guild,user);if(!saved.exists)return false;if(row&&!same(row,saved.value))throw failure('Birthday backup conflicts','BIRTHDAY_BACKUP_CONFLICT');if(!row)await put(conn,guild,user,saved.value);
 await conn.query(`UPDATE ${t.temp_data} SET value=value-$2::text WHERE key=$1`,[saved.key,user]);return true;
})}
