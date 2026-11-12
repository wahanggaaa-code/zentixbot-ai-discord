import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { pgConfig } from '../config/database/postgres.js';
import { sqliteBackend } from '../services/storage/sqlite.js';
import { normalizeWelcomeConfig } from '../utils/database.js';
import { unwrapReplitData } from '../utils/database/guildConfigStorage.js';
import { buildWelcomePayload } from '../services/welcomePayload.js';
import { assertOnboardingCompatible, assertOnboardingShape } from '../services/config/onboardingConflict.js';

function persistentPool(client) {
  const db = client.db;
  if (!db || db.getStatus?.().isDegraded || !db.isAvailable?.() || !db.db?.isAvailable?.() || !db.db.pool) throw new Error('Database tidak tersedia atau dalam mode sementara.');
  return db.db.pool;
}
function createStore(client) {
  const t = pgConfig.tables;
  return {
    async read(id) {
      const sqlite=sqliteBackend(client);if(sqlite)return {welcome:unwrapReplitData(sqlite.botGet(`guild:${id}:welcome`)||{}),guild:unwrapReplitData(sqlite.botGet(`guild:${id}:config`)||{})};
      const pool = persistentPool(client);
      const [welcome,guild] = await Promise.all([
        pool.query(`SELECT config FROM ${t.welcome_configs} WHERE guild_id = $1`,[id]),
        pool.query(`SELECT config FROM ${t.guilds} WHERE id = $1`,[id])
      ]);
      return {welcome:unwrapReplitData(welcome.rows[0]?.config || {}), guild:unwrapReplitData(guild.rows[0]?.config || {})};
    },
    async update(id, patch) {
      const sqlite=sqliteBackend(client);if(sqlite)return sqlite.transaction(tx=>{
        const cfg=unwrapReplitData(tx.botGet(`guild:${id}:config`)||{});
        if(patch.roleIds.length&&(cfg.verification?.enabled||cfg.verification?.autoVerify?.enabled)){const e=new Error('Autorole tidak dapat diaktifkan saat verification atau auto-verify aktif.');e.status=409;throw e;}
        const raw=tx.botGet(`guild:${id}:welcome`)||{};if(raw.ok!==undefined&&raw.value!==undefined)throw new Error('Format welcome lama perlu dimigrasikan sebelum diubah.');
        const merged={...raw,...patch,welcomeEmbed:{...(raw.welcomeEmbed||{}),...patch.welcomeEmbed}};tx.botSet(`guild:${id}:welcome`,merged);return normalizeWelcomeConfig(merged);
      });
      const pool = persistentPool(client); const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(`INSERT INTO ${t.guilds} (id, created_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,[id]);
        const guild = await db.query(`SELECT config FROM ${t.guilds} WHERE id = $1 FOR UPDATE`,[id]);
        const cfg = guild.rows[0]?.config;
        if (patch.roleIds.length && (cfg?.verification?.enabled || cfg?.verification?.autoVerify?.enabled)) {
          const error = new Error('Autorole tidak dapat diaktifkan saat verification atau auto-verify aktif.'); error.status=409; throw error;
        }
        await db.query(`INSERT INTO ${t.welcome_configs} (guild_id, config) VALUES ($1, '{}'::jsonb) ON CONFLICT (guild_id) DO NOTHING`,[id]);
        const old = await db.query(`SELECT config FROM ${t.welcome_configs} WHERE guild_id = $1 FOR UPDATE`,[id]);
        const raw = old.rows[0]?.config;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { const error=new Error('Pengaturan welcome perlu diperiksa.'); error.status=409; throw error; }
        if (raw.ok !== undefined && raw.value !== undefined) throw new Error('Format welcome lama perlu dimigrasikan sebelum diubah.');
        assertOnboardingShape(cfg, raw);
        const merged = {...raw,...patch,welcomeEmbed:{...(raw.welcomeEmbed || {}), ...patch.welcomeEmbed}};
        assertOnboardingCompatible(cfg, merged);
        await db.query(`UPDATE ${t.welcome_configs} SET config = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE guild_id = $1`,[id,JSON.stringify(merged)]);
        await db.query('COMMIT'); return normalizeWelcomeConfig(merged);
      } catch (err) { await db.query('ROLLBACK').catch(()=>{}); throw err; }
      finally { db.release(); }
    }
  };
}
const allowed = ['enabled','channelId','welcomeMessage','welcomePing','welcomeImage','roleIds','welcomeEmbed'];
function validate(body,guild) {
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==allowed.length || Object.keys(body).some(k=>!allowed.includes(k))) throw new Error('Pengaturan welcome tidak valid.');
  if (typeof body.enabled!=='boolean' || typeof body.welcomePing!=='boolean') throw new Error('Nilai aktif dan ping harus boolean.');
  if (typeof body.welcomeMessage!=='string' || !body.welcomeMessage.trim() || body.welcomeMessage.length>1500) throw new Error('Pesan harus berisi 1–1500 karakter.');
  if (body.channelId !== null && (typeof body.channelId !== 'string' || guild.channels.cache.get(body.channelId)?.type !== ChannelType.GuildText)) throw new Error('Pilih channel teks dari server ini.');
  if (body.enabled && !body.channelId) throw new Error('Pilih channel untuk mengaktifkan welcome.');
  if (!Array.isArray(body.roleIds) || body.roleIds.length>1 || body.roleIds.some(id=>typeof id!=='string')) throw new Error('Pilih maksimal satu autorole.');
  if (body.roleIds.length) {
    const role=guild.roles.cache.get(body.roleIds[0]), me=guild.members.me;
    if (!role || !me || role.id===guild.id || role.managed || !me.permissions.has(PermissionFlagsBits.ManageRoles) || me.roles.highest.comparePositionTo(role)<=0) throw new Error('Autorole tidak tersedia atau tidak dapat dikelola bot.');
  }
  if (body.welcomeImage !== null) {
    if (typeof body.welcomeImage !== 'string' || body.welcomeImage.length>1000) throw new Error('URL gambar tidak valid.');
    let url; try {url=new URL(body.welcomeImage);} catch {throw new Error('URL gambar tidak valid.');}
    if (url.protocol!=='https:' || url.username || url.password) throw new Error('URL gambar harus HTTPS.');
  }
  const e=body.welcomeEmbed;
  if (!e || typeof e!=='object' || Array.isArray(e) || Object.keys(e).sort().join(',')!=='color,footer,title' || typeof e.title!=='string' || !e.title.trim() || e.title.length>256 || typeof e.footer!=='string' || e.footer.length>1024 || !Number.isInteger(e.color) || e.color<0 || e.color>0xffffff) throw new Error('Judul, footer atau warna embed tidak valid.');
  return body;
}
export function createBotApiRouter(client, {auth, csrf, store = createStore(client)}) {
  const router=express.Router();
  router.use(express.json({limit:'16kb'}));
  router.get('/overview',auth,(req,res)=>{
    const ping=client.ws?.ping;
    res.json({guild:{id:req.guild.id,name:req.guild.name,memberCount:Number.isFinite(req.guild.memberCount)?req.guild.memberCount:null},online:client.isReady(),ping:Number.isFinite(ping)&&ping>=0?Math.round(ping):null,uptime:Number.isFinite(client.uptime)?client.uptime:null,database:client.db?.getStatus?.().isDegraded===false && !!client.db.db?.isAvailable?.()?'connected':'unavailable'});
  });
  router.get('/welcome',auth,async(req,res)=>{
    try {
      const data=await store.read(req.guild.id), welcome=normalizeWelcomeConfig(data.welcome);
      const channels=[...req.guild.channels.cache.values()].filter(c=>c.type===ChannelType.GuildText).map(c=>({id:c.id,name:c.name}));
      const me=req.guild.members.me;
      const roles=[...req.guild.roles.cache.values()].filter(r=>r.id!==req.guild.id && !r.managed && me?.permissions.has(PermissionFlagsBits.ManageRoles) && me.roles.highest.comparePositionTo(r)>0).map(r=>({id:r.id,name:r.name}));
      res.json({welcome,channels,roles,verificationActive:!!(data.guild.verification?.enabled || data.guild.verification?.autoVerify?.enabled)});
    } catch {res.status(503).json({error:'Tidak dapat membaca database persisten.'});}
  });
  router.patch('/welcome',auth,csrf,async(req,res)=>{
    let data; try{data=validate(req.body,req.guild);} catch(e){return res.status(400).json({error:e.message});}
    try {const welcome=await store.update(req.guild.id,data);res.json({ok:true,welcome});}
    catch(e){res.status(e.status || 503).json({error:e.status?e.message:'Gagal menyimpan ke database persisten.'});}
  });
  router.post('/welcome/test',auth,csrf,async(req,res)=>{
    if (req.body?.confirmed!==true || Object.keys(req.body).length!==1) return res.status(400).json({error:'Konfirmasi pengiriman diperlukan.'});
    try {
      const {welcome:raw}=await store.read(req.guild.id), config=normalizeWelcomeConfig(raw);
      const channel=req.guild.channels.cache.get(config.channelId), me=req.guild.members.me;
      if (!channel || channel.type!==ChannelType.GuildText || !me) return res.status(400).json({error:'Channel welcome tersimpan tidak tersedia.'});
      const perms=channel.permissionsFor(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages])) return res.status(403).json({error:'Bot tidak memiliki izin melihat dan mengirim pesan di channel.'});
      await channel.send(buildWelcomePayload({member:req.member,config,canEmbed:perms.has(PermissionFlagsBits.EmbedLinks),test:true}));
      res.json({ok:true});
    } catch {res.status(503).json({error:'Gagal mengirim pesan percobaan atau membaca database.'});}
  });
  return router;
}
