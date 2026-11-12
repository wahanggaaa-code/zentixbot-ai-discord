import {pgConfig} from '../../config/database/postgres.js';
import {botConfig} from '../../config/bot.js';
import {DEFAULT_ECONOMY_DATA} from '../../utils/constants.js';
import {normalizeEconomyData} from '../../utils/schemas.js';
const err=(message,code='ECONOMY_UNAVAILABLE')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const t=pgConfig.tables;
function validBalance(data){if(!data||typeof data!=='object'||Array.isArray(data)||!Number.isSafeInteger(data.wallet)||data.wallet<0||!Number.isSafeInteger(data.bank)||data.bank<0)throw err('Invalid economy balance.','ECONOMY_INVALID');}
function decoded(row){
 const raw=row.data&&typeof row.data==='object'&&!Array.isArray(row.data)&&Object.keys(row.data).length?row.data:{wallet:Number(row.balance),bank:Number(row.bank)};
 const data=normalizeEconomyData(raw,{...DEFAULT_ECONOMY_DATA,wallet:botConfig.economy?.startingBalance??DEFAULT_ECONOMY_DATA.wallet});validBalance(data);return data;
}
/** Transaction for one or two accounts. Callback MUST be synchronous and have no external side effects.
 * Rows are locked in deterministic order. Legacy read-then-write paths can still overwrite this commit;
 * do not route Activities rewards to the wallet until all writers have migrated. */
export async function withEconomyTransaction(client,guildId,userIds,mutate){
 if(!id(guildId)||(client?.homeGuildId&&client.homeGuildId!==guildId)||!Array.isArray(userIds)||userIds.length<1||userIds.length>2||userIds.some(x=>!id(x))||new Set(userIds).size!==userIds.length||typeof mutate!=='function')throw err('Invalid economy transaction.','ECONOMY_INVALID');
 const db=client?.db;if(!db||db.getStatus?.().isDegraded||!db.isAvailable?.()||!db.db?.isAvailable?.()||!db.db.pool)throw err('Persistent economy database unavailable.');
 const ordered=[...userIds].sort(),conn=await db.db.pool.connect();let began=false;
 try{
  await conn.query('BEGIN');began=true;await conn.query(`INSERT INTO ${t.guilds} (id,created_at) VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,[guildId]);
  for(const userId of ordered){const existing=await conn.query(`SELECT 1 FROM ${t.economy} WHERE guild_id=$1 AND user_id=$2`,[guildId,userId]);if(!existing.rows.length){const legacy=await conn.query(`SELECT 1 FROM ${t.temp_data} WHERE key = ANY($1::text[]) LIMIT 1`,[[`economy:${guildId}:${userId}`,`guild:${guildId}:economy:${userId}`]]);if(legacy.rows.length)throw err('Legacy economy data requires migration before use.','ECONOMY_LEGACY');}await conn.query(`INSERT INTO ${t.users} (id,created_at) VALUES ($1,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,[userId]);const data={...DEFAULT_ECONOMY_DATA,wallet:botConfig.economy?.startingBalance??DEFAULT_ECONOMY_DATA.wallet};validBalance(data);await conn.query(`INSERT INTO ${t.economy} (guild_id,user_id,balance,bank,data) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (guild_id,user_id) DO NOTHING`,[guildId,userId,data.wallet,data.bank,JSON.stringify(data)]);}
  const rows=await conn.query(`SELECT user_id,balance,bank,data FROM ${t.economy} WHERE guild_id=$1 AND user_id = ANY($2::varchar[]) ORDER BY user_id FOR UPDATE`,[guildId,ordered]);
  if(rows.rows.length!==ordered.length)throw err('Economy account missing.');const accounts=new Map(rows.rows.map(row=>[row.user_id,decoded(row)]));if(ordered.some(x=>!accounts.has(x)))throw err('Economy account missing.');
  const result=mutate(accounts);if(result&&typeof result.then==='function')throw err('Economy mutation must be synchronous.','ECONOMY_INVALID');
  for(const userId of ordered){const data=accounts.get(userId);validBalance(data);const json=JSON.stringify(data);if(!json||Buffer.byteLength(json)>65536)throw err('Economy data is too large.','ECONOMY_INVALID');const updated=await conn.query(`UPDATE ${t.economy} SET balance=$3,bank=$4,data=$5::jsonb,updated_at=CURRENT_TIMESTAMP WHERE guild_id=$1 AND user_id=$2`,[guildId,userId,data.wallet,data.bank,json]);if(updated.rowCount!==1)throw err('Economy account update failed.');}
  await conn.query('COMMIT');began=false;return result;
 }catch(e){if(began)await conn.query('ROLLBACK').catch(()=>{});throw e}finally{conn.release();}
}
