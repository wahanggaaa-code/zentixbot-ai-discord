import {getWarningsKey,getLegacyVariantsForCanonical} from '../../utils/database/keys.js';
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const fail=(message,code='WARNING_INVALID')=>Object.assign(new Error(message),{code});
export function isSQLiteWarningBackend(wrapper){return wrapper?.db?.sqlite?.dialect==='sqlite'}
function store(wrapper,guild,user){
 if(!isSQLiteWarningBackend(wrapper)||wrapper.useFallback||!wrapper.isAvailable?.()||!wrapper.db.isAvailable?.()||!wrapper.db.sqlite.isOpen())throw fail('Warning storage unavailable','WARNING_UNAVAILABLE');
 if(!id(guild)||(user!==undefined&&!id(user)))throw fail('Invalid warning identity');return wrapper.db.sqlite;
}
function validWarningId(value){return (Number.isSafeInteger(value)&&value>=0)||(typeof value==='string'&&value.length>0&&value.length<=128)}
function load(tx,guild,user){
 const key=getWarningsKey(guild,user),keys=[key,...getLegacyVariantsForCanonical(key)];let found=null,source=null;
 for(const k of keys){if(tx.hasRawAIKey(k))throw fail('Warning key conflicts with legacy storage','WARNING_LEGACY_CONFLICT');const raw=tx.botGetRaw(k);if(!raw)continue;if(found||raw.expiresAt!==null)throw fail('Conflicting or expiring warnings','WARNING_LEGACY_CONFLICT');found=raw;source=k}
 if(!found)return {key,source:null,warnings:[]};const warnings=found.value;
 validateSQLiteWarningArray(warnings,guild,user);
 return {key,source,warnings};
}
export function validateSQLiteWarningArray(warnings,guild,user){
 if(!id(guild)||!id(user)||!Array.isArray(warnings)||warnings.length>10000)throw fail('Invalid warning data');const seen=new Set();
 for(const warning of warnings){
  if(!warning||typeof warning!=='object'||Array.isArray(warning)||!validWarningId(warning.id)||typeof warning.reason!=='string'||warning.reason.length>4000||(warning.guildId!=null&&warning.guildId!==guild)||(warning.userId!=null&&warning.userId!==user)||(warning.moderatorId!=null&&!id(warning.moderatorId))||(warning.timestamp!=null&&(!Number.isSafeInteger(warning.timestamp)||warning.timestamp<0)))throw fail('Invalid warning record');
  const value=`${typeof warning.id}:${warning.id}`;if(seen.has(value))throw fail('Duplicate warning IDs','WARNING_LEGACY_CONFLICT');seen.add(value);
 }
 return true;
}
function write(tx,current){tx.botSet(current.key,current.warnings);if(current.source&&current.source!==current.key)tx.botDelete(current.source)}
function sequence(tx,guild,user,warnings){
 const key=`guild:${guild}:warning-sequence:${user}`;if(tx.hasRawAIKey(key))throw fail('Warning sequence conflicts with legacy data','WARNING_LEGACY_CONFLICT');const raw=tx.botGetRaw(key);if(raw&&(raw.expiresAt!==null||!Number.isSafeInteger(raw.value)||raw.value<0))throw fail('Invalid warning sequence','WARNING_LEGACY_CONFLICT');
 let largest=raw?.value??0;for(const w of warnings)if(typeof w.id==='number')largest=Math.max(largest,w.id);
 const next=Math.max(Date.now(),largest+1);if(!Number.isSafeInteger(next))throw fail('Warning ID exhausted');tx.botSet(key,next);return next;
}
export function readSQLiteWarnings(wrapper,guild,user){const sqlite=store(wrapper,guild,user);return sqlite.transaction(tx=>load(tx,guild,user).warnings)}
export function addSQLiteWarning(wrapper,{guildId,userId,moderatorId,reason,timestamp}){
 const sqlite=store(wrapper,guildId,userId);if(!id(moderatorId)||typeof reason!=='string'||!reason.trim()||reason.length>4000||!Number.isSafeInteger(timestamp)||timestamp<0)throw fail('Invalid warning');
 return sqlite.transaction(tx=>{const current=load(tx,guildId,userId);if(current.warnings.length>=10000)throw fail('Warning limit reached');const warning={id:sequence(tx,guildId,userId,current.warnings),guildId,userId,moderatorId,reason,timestamp,status:'active'};current.warnings.push(warning);write(tx,current);return {id:warning.id,totalCount:current.warnings.length}});
}
export function removeSQLiteWarning(wrapper,guild,user,warningId){
 const sqlite=store(wrapper,guild,user);if(!validWarningId(warningId))throw fail('Invalid warning ID');
 return sqlite.transaction(tx=>{const current=load(tx,guild,user),warning=current.warnings.find(w=>w.id===warningId);if(!warning)return false;warning.status='deleted';write(tx,current);return true});
}
export function clearSQLiteWarnings(wrapper,guild,user){const sqlite=store(wrapper,guild,user);return sqlite.transaction(tx=>{const current=load(tx,guild,user),count=current.warnings.length;current.warnings=[];write(tx,current);return {count}})}
export function listSQLiteWarningUsers(wrapper,guild){const sqlite=store(wrapper,guild),keys=sqlite.warningKeysRaw(guild),users=new Set(),canonical=`guild:${guild}:warnings:`,legacy=`moderation:warnings:${guild}:`;for(const key of keys){const user=key.slice((key.startsWith(canonical)?canonical:legacy).length);if(!id(user))throw fail('Invalid warning key');users.add(user)}return [...users]}
