import {getTicketKey} from '../../utils/database/keys.js';

// A snapshot is a capability to replace exactly the record that was read.
// Never hold a SQLite transaction across Discord or other external calls.
const snapshots=new WeakMap();
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const fail=(message,code='TICKET_INVALID')=>Object.assign(new Error(message),{code});
export function isSQLiteTicketBackend(wrapper){return wrapper?.db?.sqlite?.dialect==='sqlite'}
function backendStore(wrapper,guild){
 if(!isSQLiteTicketBackend(wrapper)||wrapper.useFallback||!wrapper.isAvailable?.()||!wrapper.db.isAvailable?.()||!wrapper.db.sqlite.isOpen())throw fail('Persistent ticket storage unavailable','TICKET_UNAVAILABLE');
 if(!id(guild))throw fail('Invalid ticket identity');return wrapper.db.sqlite;
}
function store(wrapper,guild,channel){const sqlite=backendStore(wrapper,guild);if(!id(channel))throw fail('Invalid ticket identity');return sqlite}
export function listSQLiteTicketKeys(wrapper,guild){return backendStore(wrapper,guild).ticketKeysRaw(guild)}
function load(tx,guild,channel){
 const key=getTicketKey(guild,channel);if(tx.hasRawAIKey(key))throw fail('Ticket conflicts with legacy storage','TICKET_LEGACY_CONFLICT');
 const raw=tx.botGetRaw(key);if(!raw)return null;
 const value=raw.value;if(raw.expiresAt!==null||!value||typeof value!=='object'||Array.isArray(value)||('ok' in value&&'value' in value)||(value.guildId!=null&&value.guildId!==guild))throw fail('Ticket data requires review','TICKET_LEGACY_CONFLICT');
 return value;
}
function track(value,sqlite,guild,channel){snapshots.set(value,{sqlite,guild,channel,raw:JSON.stringify(value)});return value}
export function readSQLiteTicket(wrapper,guild,channel){const sqlite=store(wrapper,guild,channel),value=sqlite.transaction(tx=>load(tx,guild,channel));return value===null?null:track(value,sqlite,guild,channel)}
export function saveSQLiteTicket(wrapper,guild,channel,value){
 const sqlite=store(wrapper,guild,channel);
 if(!value||typeof value!=='object'||Array.isArray(value)||('ok' in value&&'value' in value)||(value.guildId!=null&&value.guildId!==guild))throw fail('Invalid ticket data');
 const snapshot=snapshots.get(value);
 sqlite.transaction(tx=>{const current=load(tx,guild,channel);
  if(current!==null){if(!snapshot||snapshot.sqlite!==sqlite||snapshot.guild!==guild||snapshot.channel!==channel||JSON.stringify(current)!==snapshot.raw)throw fail('Ticket changed; reload before saving','TICKET_STALE');}
  else if(snapshot)throw fail('Ticket was deleted','TICKET_STALE');
  tx.botSet(getTicketKey(guild,channel),value);
 });track(value,sqlite,guild,channel);return true;
}

/** Deletes every ticket record of the guild in one transaction; the ticket counter stays. Returns how many were deleted. */
export function deleteSQLiteTickets(wrapper,guild){
 const sqlite=backendStore(wrapper,guild);
 return sqlite.transaction(tx=>{const keys=tx.ticketKeysRaw(guild);for(const key of keys)tx.botDelete(key);return keys.length});
}
