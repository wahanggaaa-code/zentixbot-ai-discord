import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { PostgreSQLDatabase } from '../src/utils/postgresDatabase.js';
import { getGuildConfig, updateGuildConfig, patchGuildConfig } from '../src/services/config/guildConfig.js';

const guild = '123456789012345678';
const key = `guild:${guild}:config`;

test('config read errors and unavailability prevent read-modify-write', async () => {
  let writes = 0;
  const client = { db: { isAvailable: () => true, get: async () => { throw new Error('offline'); }, set: async () => { writes++; return true; } } };
  await assert.rejects(getGuildConfig(client, guild), e => e.type === 'database');
  await assert.rejects(updateGuildConfig(client, guild, { prefix: '?' }), e => e.type === 'database');
  await assert.rejects(patchGuildConfig(client, guild, { logging: { enabled: false } }), e => e.type === 'database');
  assert.equal(writes, 0);
  client.db.isAvailable = () => false;
  await assert.rejects(updateGuildConfig(client, guild, { prefix: '?' }), e => e.type === 'database');
  await assert.rejects(getGuildConfig({}, guild), e => e.type === 'database');
  assert.equal(writes, 0);
  client.db.isAvailable = () => true;
  client.db.get = async () => null;
  assert.equal(typeof (await getGuildConfig(client, guild)).prefix, 'string');
  client.db.get = async () => ['corrupt'];
  await assert.rejects(updateGuildConfig(client, guild, { prefix: '?' }), e => e.type === 'database');
  assert.equal(writes, 0);
});

test('PostgreSQL config read propagates query error, never overwriting on recovery', { skip: process.env.ZENTIX_TEST_PG_SOCKET !== '/tmp/zentix-local-pg' }, async t => {
  const base = { host: '/tmp/zentix-local-pg', port: 55432, user: 'user', database: 'postgres' };
  const admin = new pg.Client(base); await admin.connect();
  const schema = `config_read_${randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`CREATE TABLE "${schema}".guilds (id varchar(20) primary key, config jsonb, updated_at timestamp)`);
  const pool = new pg.Pool({ ...base, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });
  const backend = new PostgreSQLDatabase(); backend.pool = pool; backend.isConnected = true;
  const client = { db: { db: backend, getStatus: () => ({connectionType:'postgresql', isDegraded:false}), isAvailable: () => Boolean(backend.isAvailable()), get: (...args) => backend.get(...args), set: (...args) => backend.set(...args) } };
  assert.equal(await backend.get(key, null), null);
  await pool.query('INSERT INTO guilds(id,config) VALUES($1,$2)', [guild, JSON.stringify({ prefix: '!', premiumRoleId: '234567890123456789' })]);
  assert.equal((await getGuildConfig(client, guild)).prefix, '!');
  await pool.query('ALTER TABLE guilds RENAME TO temporarily_unavailable');
  await assert.rejects(backend.get(key, null));
  await assert.rejects(updateGuildConfig(client, guild, { prefix: '?' }), e => e.type === 'database');
  await pool.query('ALTER TABLE temporarily_unavailable RENAME TO guilds');
  const actual = (await pool.query('SELECT config FROM guilds WHERE id=$1', [guild])).rows[0].config;
  assert.deepEqual(actual, { prefix: '!', premiumRoleId: '234567890123456789' });
  await updateGuildConfig(client, guild, { prefix: '?' });
  const updated = (await pool.query('SELECT config FROM guilds WHERE id=$1', [guild])).rows[0].config;
  assert.equal(updated.prefix, '?');
  assert.equal(updated.premiumRoleId, '234567890123456789');
  for (const bad of ['null', '[]', '"wrong"', '42']) {
    await pool.query('UPDATE guilds SET config=$2::jsonb WHERE id=$1', [guild, bad]);
    await assert.rejects(patchGuildConfig(client, guild, { prefix: '?' }), e => e.type === 'database');
    assert.deepEqual((await pool.query('SELECT config FROM guilds WHERE id=$1', [guild])).rows[0].config, JSON.parse(bad));
  }
  await pool.query('UPDATE guilds SET config=NULL WHERE id=$1', [guild]);
  await assert.rejects(getGuildConfig(client, guild), e => e.type === 'database');
  backend.isConnected = false;
  await assert.rejects(backend.get(key, null), { code: 'CONFIG_DB_UNAVAILABLE' });
});
