import {createHash} from 'node:crypto';
import {pgConfig} from '../../config/database/postgres.js';
import {assertOnboardingShape,assertOnboardingCompatible} from './onboardingConflict.js';
import {sqliteFor} from '../storage/sqliteRows.js';
const tables=pgConfig.tables;
const fail=(message,code='COMMAND_ACCESS_INVALID')=>Object.assign(new Error(message),{code});
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
export const isPostgresCommandAccess=client=>client?.db?.getStatus?.()?.connectionType==='postgresql';
export const commandAccessVersion=serialized=>createHash('sha256').update('command-access-v1:'+serialized).digest('hex');
export function checkAccessConfig(raw){
 if(!obj(raw)||(raw.ok!==undefined&&raw.value!==undefined))throw fail('Invalid guild config');
 const out={};
 for(const field of ['disabledCommands','disabledCategories']){
  const data=raw[field];const map=Object.create(null);if(data!==undefined&&data!==null){
   const entries=Array.isArray(data)?data.map(k=>[k,true]):obj(data)?Object.entries(data):null;
   if(!entries||entries.length>10000)throw fail('Invalid command access data');
   for(const [k,v] of entries){if(typeof k!=='string'||k.length<1||k.length>128||typeof v!=='boolean'||['__proto__','prototype','constructor'].includes(k.toLowerCase())||Object.hasOwn(map,k.toLowerCase()))throw fail('Invalid command access entry');map[k.toLowerCase()]=v;}
  }
  out[field]=map;
 }
 return out;
}
function getPool(client){const db=client?.db,s=db?.getStatus?.();if(s?.connectionType!=='postgresql'||s.isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool?.connect)throw fail('PostgreSQL unavailable','COMMAND_ACCESS_UNAVAILABLE');return db.db.pool;}
// On SQLite the guild config is one row; the revision is the hash of its stored JSON text.
const unavailable=()=>fail('Database unavailable','COMMAND_ACCESS_UNAVAILABLE');
const configKey=guild=>`guild:${guild}:config`,welcomeKey=guild=>`guild:${guild}:welcome`;
const sqliteRevision=raw=>raw===null?'missing':commandAccessVersion(JSON.stringify(raw));
function mutateSQLiteCommandAccess(sqlite,guild,{field,targets,disabled,revision}){
 return sqlite.transaction(tx=>{
  const raw=tx.botGet(configKey(guild)),config=raw??{},maps=checkAccessConfig(config);
  if(revision!==undefined&&sqliteRevision(raw)!==revision)throw fail('Command settings changed','COMMAND_ACCESS_STALE');
  const welcome=tx.botGet(welcomeKey(guild))??{};assertOnboardingShape(config,welcome);assertOnboardingCompatible(config,welcome);
  const map=maps[field];for(const target of targets){if(disabled)map[target.toLowerCase()]=true;else delete map[target.toLowerCase()];}
  const next={...config,[field]:{...map}};tx.botSet(configKey(guild),next);return sqliteRevision(next);
 });
}
export async function readPostgresCommandAccess(client,guild){
 const sqlite=sqliteFor(client,unavailable);
 if(sqlite){const stored=sqlite.botGet(configKey(guild)),config=stored??{},maps=checkAccessConfig(config);return {config:{...config,...maps},revision:sqliteRevision(stored)};}
 const result=await getPool(client).query(`SELECT config,config::text AS serialized FROM ${tables.guilds} WHERE id=$1`,[guild]);const row=result.rows[0],raw=row?row.config:{};const maps=checkAccessConfig(raw);return {config:{...raw,...maps},revision:row?commandAccessVersion(row.serialized):'missing'};
}
// Participating config writers share guild -> welcome row-lock order. Only the
// access object is replaced so unknown JSONB values retain exact representation.
export async function mutatePostgresCommandAccess(client,guild,{field,targets,disabled,revision}){
 if(!['disabledCommands','disabledCategories'].includes(field)||!Array.isArray(targets)||!targets.length||targets.length>1000||targets.some(x=>typeof x!=='string'||!x||x.length>128)||typeof disabled!=='boolean'||(revision!==undefined&&!/^(missing|[0-9a-f]{64})$/.test(revision)))throw fail('Invalid mutation');
 const sqlite=sqliteFor(client,unavailable);if(sqlite)return mutateSQLiteCommandAccess(sqlite,guild,{field,targets,disabled,revision});
 const p=getPool(client),conn=await p.connect();try{
  await conn.query('BEGIN');const created=await conn.query(`INSERT INTO ${tables.guilds}(id) VALUES($1) ON CONFLICT(id) DO NOTHING RETURNING id`,[guild]);
  const row=(await conn.query(`SELECT config,config::text AS serialized FROM ${tables.guilds} WHERE id=$1 FOR UPDATE`,[guild])).rows[0];const maps=checkAccessConfig(row?.config);const actual=created.rowCount?'missing':commandAccessVersion(row.serialized);if(revision!==undefined&&actual!==revision)throw fail('Command settings changed','COMMAND_ACCESS_STALE');
  const welcomeResult=await conn.query(`SELECT config FROM ${tables.welcome_configs} WHERE guild_id=$1 FOR UPDATE`,[guild]);const welcome=welcomeResult.rows.length?welcomeResult.rows[0].config:{};
  assertOnboardingShape(row.config,welcome);assertOnboardingCompatible(row.config,welcome);
  const map=maps[field];for(const target of targets){if(disabled)map[target.toLowerCase()]=true;else delete map[target.toLowerCase()];}
  const saved=await conn.query(`UPDATE ${tables.guilds} SET config=jsonb_set(config,ARRAY[$2::text],$3::jsonb,true),updated_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING config::text AS serialized`,[guild,field,JSON.stringify(map)]);await conn.query('COMMIT');return commandAccessVersion(saved.rows[0].serialized);
 }catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release()}
}
