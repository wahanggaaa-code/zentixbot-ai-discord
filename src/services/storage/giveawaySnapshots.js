// Snapshots are process-local capabilities for detecting stale full-record writes;
// SQLite performs the comparison and update atomically across processes.
const snapshots=new WeakMap();
export function trackGiveawaySnapshot(record,sqlite,guildId){snapshots.set(record,{sqlite,guildId,messageId:record.messageId,raw:JSON.stringify(record)});return record;}
export function getGiveawaySnapshot(record){return snapshots.get(record);}
export function transferGiveawaySnapshot(source,target){const entry=source&&snapshots.get(source);if(entry&&target&&typeof target==='object')snapshots.set(target,entry);return target;}
