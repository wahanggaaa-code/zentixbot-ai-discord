import {EconomyDataSchema} from '../../utils/schemas.js';

// Experimental conversion primitive, NOT a complete PG->SQLite importer. The
// caller must use a stable PG snapshot and separately detect PG legacy keys.
// Read `balance::text`, `bank::text`, `data::text` to avoid pg numeric parsers.
const failure=(message,code='MIGRATION_INVALID')=>Object.assign(new Error(message),{code});
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const MAX_BATCH=500,MAX_ROW=65536,MAX_BATCH_BYTES=2097152;
function balance(value){
 if(typeof value!=='string'||value.length>19||!/^\d+$/.test(value))throw failure('Invalid PostgreSQL balance');
 const big=BigInt(value);if(big>BigInt(Number.MAX_SAFE_INTEGER))throw failure('Balance exceeds safe integer range','MIGRATION_UNSAFE_NUMBER');return Number(big);
}
// JSONB contains arbitrary-precision numerics; JSON.parse would round them.
// Conservatively reject decimals/exponents and out-of-range integers anywhere,
// including unknown metadata. Numeric text inside JSON strings is left alone.
function parseData(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>MAX_ROW)throw failure('Economy JSON is missing or too large');
 let value;try{value=JSON.parse(text)}catch{throw failure('Invalid economy JSON')}
 if(!value||typeof value!=='object'||Array.isArray(value))throw failure('Economy data must be an object');
 let inString=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}if(ch==='"'){inString=true;continue}
  if(ch==='-'||(ch>='0'&&ch<='9')){const match=text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);if(!match)throw failure('Invalid economy numeric value');const token=match[0];if(/[.eE]/.test(token)||!Number.isSafeInteger(Number(token)))throw failure('Economy metadata has unsupported numeric precision','MIGRATION_UNSAFE_NUMBER');i+=token.length-1;}
 }
 return value;
}
export function convertEconomyRow(row,homeGuildId){
 if(!id(homeGuildId)||!row||row.guild_id!==homeGuildId||!id(row.user_id))throw failure('Invalid economy account identity');
 const wallet=balance(row.balance_text),bank=balance(row.bank_text),data=parseData(row.data_text);
 let account;
 if(Object.keys(data).length===0)account={wallet,bank};
 else{
  if(!Object.hasOwn(data,'wallet')||!Object.hasOwn(data,'bank')||data.wallet!==wallet||data.bank!==bank)throw failure('Economy JSON and columns disagree','MIGRATION_ECONOMY_CONFLICT');
  account=data;
 }
 if(!EconomyDataSchema.safeParse(account).success)throw failure('Economy JSON does not match account schema');
 const encoded=JSON.stringify(account);if(Buffer.byteLength(encoded)>MAX_ROW)throw failure('Economy account is too large');
 return {guildId:homeGuildId,userId:row.user_id,account};
}
/** Synchronous all-or-nothing batch; never overwrites an account or raw legacy key. */
export function importEconomyBatch(sqlite,homeGuildId,rows,{requireEmptyDestination=false,expectedTotals=null}={}){
 if(expectedTotals!==null&&(!expectedTotals||typeof expectedTotals!=='object'||typeof expectedTotals.wallet!=='string'||!/^\d+$/.test(expectedTotals.wallet)||typeof expectedTotals.bank!=='string'||!/^\d+$/.test(expectedTotals.bank)))throw failure('Invalid expected totals');
 if(!sqlite||sqlite.dialect!=='sqlite'||!sqlite.isOpen()||!id(homeGuildId)||!Array.isArray(rows)||rows.length<1||rows.length>MAX_BATCH||typeof requireEmptyDestination!=='boolean')throw failure('Invalid economy migration batch');
 let size=0;const ids=new Set(),accounts=rows.map(row=>{
  size+=typeof row?.data_text==='string'?Buffer.byteLength(row.data_text):0;if(size>MAX_BATCH_BYTES)throw failure('Economy migration batch is too large');
  const item=convertEconomyRow(row,homeGuildId);if(ids.has(item.userId))throw failure('Duplicate economy account');ids.add(item.userId);return item;
 });
 return sqlite.transaction(tx=>{
  if(requireEmptyDestination&&tx.hasAnyEconomyData())throw failure('Destination economy storage is not empty','MIGRATION_DESTINATION_CONFLICT');
  for(const {guildId,userId} of accounts){
   const keys=[`economy:${guildId}:${userId}`,`guild:${guildId}:economy:${userId}`];
   if(tx.getAccount(guildId,userId)!==null||keys.some(key=>tx.hasRawKey(key)))throw failure('Destination economy account or legacy key already exists','MIGRATION_DESTINATION_CONFLICT');
  }
  let walletTotal=0n,bankTotal=0n;
  for(const {guildId,userId,account} of accounts){
   tx.setAccount(guildId,userId,account);const restored=tx.getAccount(guildId,userId);
   if(JSON.stringify(restored)!==JSON.stringify(account))throw failure('Economy destination verification failed','MIGRATION_VERIFY_FAILED');
   walletTotal+=BigInt(account.wallet);bankTotal+=BigInt(account.bank);
  }
  if(expectedTotals&&(walletTotal.toString()!==expectedTotals.wallet||bankTotal.toString()!==expectedTotals.bank))throw failure('Economy totals do not match','MIGRATION_VERIFY_FAILED');
  return {accounts:accounts.length,walletTotal:walletTotal.toString(),bankTotal:bankTotal.toString()};
 });
}
