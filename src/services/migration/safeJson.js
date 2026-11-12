const failure=(message,code='MIGRATION_INVALID')=>Object.assign(new Error(message),{code});
// JSONB can contain arbitrary precision numbers that JSON.parse silently rounds.
// This conservative migration parser accepts safe integers only; numeric strings
// are preserved unchanged. Decimals and exponent notation need manual review.
export function parseMigrationJSON(text,maxBytes=65536){
 if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw failure('JSON is missing or too large');
 let value;try{value=JSON.parse(text)}catch{throw failure('Invalid JSON')}
 let inString=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')inString=false;continue}if(ch==='"'){inString=true;continue}
  if(ch==='-'||(ch>='0'&&ch<='9')){const match=text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);if(!match)throw failure('Invalid numeric value');const token=match[0];if(/[.eE]/.test(token)||!Number.isSafeInteger(Number(token)))throw failure('JSON has unsupported numeric precision','MIGRATION_UNSAFE_NUMBER');i+=token.length-1;}
 }
 return value;
}
