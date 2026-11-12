import {canonicalizeKey} from './keys.js';
import {pgConfig} from '../../config/database/postgres.js';

// Read-only snapshot: no startup-time rewrite of live data. Limit scanning to
// bound resource usage; both a detected key and an incomplete scan fail closed.
export async function auditLegacyKeysOnStartup(pool,{batchSize=1000,maxKeys=50000}={}){
 if(!Number.isInteger(batchSize)||batchSize<1||!Number.isInteger(maxKeys)||maxKeys<1)throw new Error('Invalid legacy audit limits');
 const conn=await pool.connect();let inTransaction=false,cursor='',scanned=0;
 try{
  await conn.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');inTransaction=true;
  await conn.query("SET LOCAL statement_timeout = '10s'");
  while(true){
   const limit=Math.min(batchSize,maxKeys-scanned+1);
   const result=await conn.query(`SELECT key FROM ${pgConfig.tables.temp_data} WHERE key COLLATE "C" > $1 COLLATE "C" ORDER BY key COLLATE "C" LIMIT $2`,[cursor,limit]);
   if(!Array.isArray(result.rows))throw new Error('Legacy key audit failed');
   for(const row of result.rows){if(typeof row.key!=='string'||!row.key||Buffer.compare(Buffer.from(row.key),Buffer.from(cursor))<=0)throw new Error('Legacy key audit ordering failed');cursor=row.key;scanned++;if(scanned>maxKeys)throw Object.assign(new Error('Legacy key audit limit exceeded; inspect database before startup.'),{code:'LEGACY_KEY_AUDIT_LIMIT'});if(canonicalizeKey(row.key)!==row.key)throw Object.assign(new Error('Legacy database keys require offline review before startup.'),{code:'LEGACY_KEYS_REQUIRE_REVIEW'});}
   if(result.rows.length<limit)break;
  }
  await conn.query('COMMIT');inTransaction=false;return {scanned};
 }catch(error){if(inTransaction)await conn.query('ROLLBACK').catch(()=>{});throw error}finally{conn.release()}
}
