import {sqliteBackend} from './sqlite.js';
import {getGiveawaySnapshot,trackGiveawaySnapshot} from './giveawaySnapshots.js';
import {ZentixBotError,ErrorTypes} from '../../utils/errorHandler.js';
const validId=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const fail=(message,userMessage)=>new ZentixBotError(message,ErrorTypes.DATABASE,userMessage);
const invalid=()=>fail('Invalid SQLite giveaway data','Giveaway data is invalid. Contact an administrator.');
function storeFor(client,guildId){if(client?.db?.db?.sqlite?.dialect!=='sqlite')return null;const sqlite=sqliteBackend(client);if(!sqlite)throw fail('SQLite unavailable','Persistent storage is unavailable.');if(!validId(guildId)||(client.homeGuildId&&client.homeGuildId!==guildId))throw invalid();return sqlite;}
function mapFor(tx,key,guildId){const raw=tx.botGet(key);if(raw===null)return Object.create(null);if(!raw||typeof raw!=='object'||(raw.ok!==undefined&&raw.value!==undefined))throw invalid();
 const values=Array.isArray(raw)?raw:Object.values(raw),map=Object.create(null);for(const v of values){if(!v||typeof v!=='object'||Array.isArray(v)||!validId(v.messageId)||(v.guildId!=null&&v.guildId!==guildId)||Object.hasOwn(map,v.messageId))throw invalid();map[v.messageId]=v}return map;}
const keyFor=g=>`guild:${g}:giveaways`;
const timestamp=value=>{if(typeof value==='number')return Number.isFinite(value)?value:NaN;if(typeof value==='string'&&value.trim()){const n=Number(value);return Number.isFinite(n)?n:Date.parse(value)}return NaN};
export function isSQLiteGiveawayBackend(client){return client?.db?.db?.sqlite?.dialect==='sqlite';}
export function readSQLiteGiveaways(client,guildId){const sqlite=storeFor(client,guildId);if(!sqlite)throw invalid();const map=mapFor(sqlite,keyFor(guildId),guildId);return Object.values(map).map(item=>trackGiveawaySnapshot(item,sqlite,guildId));}
export function saveSQLiteGiveaway(client,guildId,data){const sqlite=storeFor(client,guildId);if(!sqlite||!data||typeof data!=='object'||Array.isArray(data)||!validId(data.messageId)||(data.guildId!=null&&data.guildId!==guildId))throw invalid();const snapshot=getGiveawaySnapshot(data);
 const saved=sqlite.transaction(tx=>{const key=keyFor(guildId),map=mapFor(tx,key,guildId),current=map[data.messageId];
  if(current){if(!snapshot||snapshot.sqlite!==sqlite||snapshot.guildId!==guildId||snapshot.messageId!==data.messageId||JSON.stringify(current)!==snapshot.raw)throw fail('Stale giveaway','Giveaway changed. Reload it before trying again.');}
  else if(snapshot)throw fail('Giveaway deleted','Giveaway no longer exists.');
  map[data.messageId]=data;tx.botSet(key,map);return data;
 });trackGiveawaySnapshot(data,sqlite,guildId);return saved;
}
export function deleteSQLiteGiveaway(client,guildId,messageId){const sqlite=storeFor(client,guildId);if(!sqlite||!validId(messageId))throw invalid();return sqlite.transaction(tx=>{const key=keyFor(guildId),map=mapFor(tx,key,guildId);if(!Object.hasOwn(map,messageId))return false;if(map[messageId].deliveryStatus==='pending')throw fail('Giveaway delivery unresolved','Inspect and reconcile pending delivery before deleting this giveaway.');delete map[messageId];tx.botSet(key,map);return true});}
export function joinSQLiteGiveaway(client,guildId,messageId,userId,now=Date.now()){
 const sqlite=storeFor(client,guildId);if(!sqlite||!validId(messageId)||!validId(userId)||!Number.isSafeInteger(now))throw invalid();
 return sqlite.transaction(tx=>{const key=keyFor(guildId),map=mapFor(tx,key,guildId),data=map[messageId];if(!data)return {status:'missing'};const ends=timestamp(data.endsAt??data.endTime);if(!Number.isFinite(ends))throw invalid();if(data.ended||data.isEnded||ends<=now)return {status:'ended'};
  if(data.participants!==undefined&&!Array.isArray(data.participants))throw invalid();const participants=data.participants||[];if(participants.some(id=>!validId(id)))throw invalid();if(participants.includes(userId))return {status:'already'};
  if(participants.length>=10000)throw fail('Giveaway full','This giveaway has reached its entry limit.');data.participants=[...participants,userId];tx.botSet(key,map);return {status:'joined',giveaway:data};
 });
}
