import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {PostgreSQLDatabase} from '../src/utils/postgresDatabase.js';
import {getGuildBirthdays,setBirthday,deleteBirthday} from '../src/utils/database.js';
import {setBirthday as serviceSet,deleteBirthday as serviceDelete} from '../src/services/birthdayService.js';
import {movePostgresBirthdayOnLeave,restorePostgresBirthdayOnJoin} from '../src/services/storage/postgresBirthdays.js';
import memberLeave from '../src/events/guildMemberRemove.js';
import memberJoin from '../src/events/guildMemberAdd.js';
import birthdayList from '../src/commands/Birthday/modules/birthday_list.js';
import nextBirthdays from '../src/commands/Birthday/modules/next_birthdays.js';
const enabled=process.env.ZENTIX_TEST_PG_SOCKET==='/tmp/zentix-local-pg';
const g='123456789012345678',a='234567890123456789',b='345678901234567890',key=`guild:${g}:birthdays`,left=key+':left';
async function setup(t){
 const base={host:'/tmp/zentix-local-pg',port:55432,user:'user',database:'postgres'},admin=new pg.Client(base);await admin.connect();const schema=`birthday_safe_${randomBytes(6).toString('hex')}`;await admin.query(`CREATE SCHEMA "${schema}"`);await admin.query(`CREATE TABLE "${schema}".guilds(id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}',counters jsonb DEFAULT '[]');CREATE TABLE "${schema}".welcome_configs(guild_id varchar(20) PRIMARY KEY,config jsonb DEFAULT '{}');CREATE TABLE "${schema}".users(id varchar(20) PRIMARY KEY);CREATE TABLE "${schema}".birthdays(guild_id varchar(20) REFERENCES "${schema}".guilds(id),user_id varchar(20) REFERENCES "${schema}".users(id),month integer NOT NULL,day integer NOT NULL,updated_at timestamp DEFAULT now(),PRIMARY KEY(guild_id,user_id));CREATE TABLE "${schema}".temp_data(key text PRIMARY KEY,value jsonb,expires_at timestamp);CREATE TABLE "${schema}".cache_data(key text PRIMARY KEY,value jsonb,expires_at timestamp)`);
 const pool=new pg.Pool({...base,options:`-c search_path=${schema}`,max:25});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()});const backend=new PostgreSQLDatabase();backend.pool=pool;backend.isConnected=true;const client={homeGuildId:g,db:{db:backend,getStatus:()=>({connectionType:'postgresql',isDegraded:false}),isAvailable:()=>Boolean(backend.isAvailable()),get:(...x)=>backend.get(...x),set:(...x)=>backend.set(...x),delete:(...x)=>backend.delete(...x)}};return {client,pool,backend};
}
test('concurrent distinct birthday writes preserve all records, with full-map writes blocked',{skip:!enabled},async t=>{
 const {client,pool,backend}=await setup(t);const results=await Promise.all(Array.from({length:60},(_,i)=>setBirthday(client,g,String(500000000000000000n+BigInt(i)),2,29)));assert.ok(results.every(Boolean));assert.equal(Object.keys(await getGuildBirthdays(client,g)).length,60);
 for(const k of [key,`birthdays:${g}`,left]){assert.equal(await backend.set(k,{}),false);assert.equal(await backend.delete(k),false)}assert.equal(await backend.setStructuredData({type:'guild_birthdays',guildId:g,fullKey:key},{}),false);assert.equal(await backend.deleteStructuredData({type:'guild_birthdays',guildId:g,fullKey:key}),false);assert.equal((await pool.query('SELECT count(*)::int n FROM birthdays')).rows[0].n,60);
});
test('leave and join preserve backup and active rows atomically and reject conflicts',{skip:!enabled},async t=>{
 const {client,pool}=await setup(t);assert.equal(await setBirthday(client,g,a,2,29),true);assert.equal(await setBirthday(client,g,b,3,1),true);assert.equal(await movePostgresBirthdayOnLeave(client,g,a),true);assert.deepEqual(await getGuildBirthdays(client,g),{[b]:{month:3,day:1}});let backup=(await pool.query('SELECT value FROM temp_data WHERE key=$1',[left])).rows[0].value;assert.deepEqual(backup[a],{month:2,day:29});assert.equal(await restorePostgresBirthdayOnJoin(client,g,a),true);assert.deepEqual((await getGuildBirthdays(client,g))[a],{month:2,day:29});assert.equal(await restorePostgresBirthdayOnJoin(client,g,a),false);
 await pool.query('UPDATE temp_data SET value=$2::jsonb WHERE key=$1',[left,JSON.stringify({[a]:{month:1,day:1}})]);await assert.rejects(movePostgresBirthdayOnLeave(client,g,a),{code:'BIRTHDAY_BACKUP_CONFLICT'});await assert.rejects(restorePostgresBirthdayOnJoin(client,g,a),{code:'BIRTHDAY_BACKUP_CONFLICT'});assert.deepEqual((await getGuildBirthdays(client,g))[a],{month:2,day:29});backup=(await pool.query('SELECT value FROM temp_data WHERE key=$1',[left])).rows[0].value;assert.deepEqual(backup[a],{month:1,day:1});
});
test('failed leave and restore roll back both records',{skip:!enabled},async t=>{
 const {client,pool}=await setup(t);await setBirthday(client,g,a,1,2);await pool.query(`CREATE FUNCTION deny_delete() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'blocked'; END$$;CREATE TRIGGER deny BEFORE DELETE ON birthdays FOR EACH ROW EXECUTE FUNCTION deny_delete()`);await assert.rejects(movePostgresBirthdayOnLeave(client,g,a));assert.deepEqual((await getGuildBirthdays(client,g))[a],{month:1,day:2});assert.equal((await pool.query('SELECT count(*)::int n FROM temp_data')).rows[0].n,0);await pool.query('DROP TRIGGER deny ON birthdays');await movePostgresBirthdayOnLeave(client,g,a);await pool.query(`CREATE FUNCTION deny_backup() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'blocked'; END$$;CREATE TRIGGER deny BEFORE UPDATE ON temp_data FOR EACH ROW EXECUTE FUNCTION deny_backup()`);await assert.rejects(restorePostgresBirthdayOnJoin(client,g,a));assert.equal((await getGuildBirthdays(client,g))[a],undefined);assert.deepEqual((await pool.query('SELECT value FROM temp_data WHERE key=$1',[left])).rows[0].value[a],{month:1,day:2});
});
test('legacy data, malformed rows, outages and malformed backup fail closed',{skip:!enabled},async t=>{
 const {client,pool,backend}=await setup(t);await setBirthday(client,g,a,4,5);await pool.query('INSERT INTO temp_data(key,value) VALUES($1,$2)',[`birthdays:${g}`,'{}']);await assert.rejects(getGuildBirthdays(client,g),{code:'BIRTHDAY_LEGACY_CONFLICT'});assert.equal(await setBirthday(client,g,b,1,1),false);assert.equal(await deleteBirthday(client,g,a),false);await pool.query('DELETE FROM temp_data');await pool.query('UPDATE birthdays SET day=31');await assert.rejects(getGuildBirthdays(client,g),{code:'BIRTHDAY_INVALID'});assert.equal(await deleteBirthday(client,g,a),false);await pool.query('UPDATE birthdays SET day=5');await pool.query('INSERT INTO temp_data(key,value,expires_at) VALUES($1,$2,now())',[left,'{}']);await assert.rejects(movePostgresBirthdayOnLeave(client,g,a),{code:'BIRTHDAY_LEGACY_CONFLICT'});backend.isConnected=false;await assert.rejects(getGuildBirthdays(client,g),{code:'BIRTHDAY_UNAVAILABLE'});assert.equal(await setBirthday(client,g,b,1,1),false);
});
test('service deletion reports atomic result rather than a stale preliminary read',{skip:!enabled},async t=>{
 const {client}=await setup(t);await serviceSet(client,g,a,1,5);const results=await Promise.all(Array.from({length:8},()=>serviceDelete(client,g,a)));assert.equal(results.filter(x=>x.status==='removed').length,1);assert.equal(results.filter(x=>x.status==='not_found').length,7);
});


test('real join and leave handlers call transactional birthday move and restore',{skip:!enabled},async t=>{
 const {client,pool}=await setup(t);await setBirthday(client,g,a,4,5);client.user={id:'456789012345678901'};client.db.keys=async()=>[];
 const guild={id:g,name:'Test',memberCount:1,channels:{cache:new Map()},roles:{cache:new Map()},members:{me:{}}};client.guilds={cache:new Map([[g,guild]])};client.db.delete=async()=>true;const user={id:a,username:'test',tag:'test#0001',displayName:'test',createdTimestamp:Date.now(),toString:()=>`<@${a}>`,displayAvatarURL:()=> 'https://example.test/a.png'};const member={guild,user,client,joinedTimestamp:Date.now()};
 await memberLeave.execute(member);assert.equal((await getGuildBirthdays(client,g))[a],undefined);assert.deepEqual((await pool.query('SELECT value FROM temp_data WHERE key=$1',[left])).rows[0].value[a],{month:4,day:5});await memberJoin.execute(member);assert.deepEqual((await getGuildBirthdays(client,g))[a],{month:4,day:5});assert.equal((await pool.query('SELECT value FROM temp_data WHERE key=$1',[left])).rows[0].value[a],undefined);
});

test('parallel leave and join of distinct members preserve all backup entries',{skip:!enabled},async t=>{
 const {client}=await setup(t);const ids=Array.from({length:30},(_,i)=>String(600000000000000000n+BigInt(i)));await Promise.all(ids.map(id=>setBirthday(client,g,id,6,7)));await Promise.all(ids.map(id=>movePostgresBirthdayOnLeave(client,g,id)));assert.equal(Object.keys(await getGuildBirthdays(client,g)).length,0);await Promise.all(ids.map(id=>restorePostgresBirthdayOnJoin(client,g,id)));assert.equal(Object.keys(await getGuildBirthdays(client,g)).length,30);
});


test('failed or incomplete member lookups never delete birthday records',{skip:!enabled},async t=>{
 const {client}=await setup(t);await setBirthday(client,g,a,7,8);const interaction={id:'interaction',user:{id:a},guildId:g,guild:{id:g,name:'test',members:{fetch:async value=>typeof value==='object'?new Map():Promise.reject(Error('Discord unavailable'))}},deferred:true,editReply:async()=>{}};await birthdayList.execute(interaction,{},client);await nextBirthdays.execute(interaction,{},client);assert.deepEqual((await getGuildBirthdays(client,g))[a],{month:7,day:8});
});
