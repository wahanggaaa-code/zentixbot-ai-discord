// Shared strict parser for experimental pending-create metadata. The returned
// entries contain private fields; callers must explicitly select safe fields.
const id=x=>typeof x==='string'&&/^\d{17,20}$/.test(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const token=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseJoinToCreatePending(value){
 if(value===undefined)return [];
 if(!object(value))throw new Error('Invalid pending create');
 const entries=Object.entries(value);if(entries.length>1)throw new Error('Invalid pending create');
 for(const [key,v] of entries){
  if(!token.test(key)||!object(v)||!id(v.ownerId)||!id(v.triggerId)||!Number.isSafeInteger(v.createdAt)||v.createdAt<0||Number.isNaN(new Date(v.createdAt).getTime()))throw new Error('Invalid pending create');
  const keys=Object.keys(v).sort().join(',');
  if(v.stage==='reserved'){if(keys!=='createdAt,ownerId,stage,triggerId')throw new Error('Invalid pending create');}
  else if(v.stage==='created'){if(keys!=='channelId,createdAt,ownerId,stage,triggerId'||!id(v.channelId))throw new Error('Invalid pending create');}
  else throw new Error('Invalid pending create');
 }
 return entries;
}
