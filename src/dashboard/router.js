import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { isHomeGuild } from '../utils/singleGuild.js';
import { createBotApiRouter } from './botApi.js';
import { createGoodbyeApi } from './goodbyeApi.js';
import { createBirthdayApi } from './birthdayApi.js';
import { createCoreApi } from './coreApi.js';
import { createGiveawayApi } from './giveawayApi.js';
import { createModulesApi } from './modulesApi.js';
import { createOperationsApi } from './operationsApi.js';
import { createHostingApi } from './hostingApi.js';
import { createAIApi } from './aiApi.js';

const preview = fileURLToPath(new URL('../../dashboard-preview/', import.meta.url));
const random = () => crypto.randomBytes(32).toString('hex');
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(x => x.trim().split('=')).find(x => x[0] === name)?.[1];
const NO_CACHE = 'no-store';

// Sessions are process-local: deployment with multiple workers needs a shared session store.
export function createDashboardRouter(client, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const router = express.Router();
  const states = new Map(), sessions = new Map();
  let origin = null;
  try {
    const u = new URL(env.DASHBOARD_URL);
    if ((u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash) origin = u.origin;
  } catch { /* disabled until correctly configured */ }
  const configured = Boolean(origin && /^\d{17,20}$/.test(env.CLIENT_ID || '') && env.DISCORD_CLIENT_SECRET && client.homeGuildId);
  const options = { httpOnly: true, secure: origin?.startsWith('https:') || false, sameSite: 'lax', path: '/dashboard' };
  const clear = (res, name) => res.clearCookie(name, options);
  const purge = () => { const now = Date.now(); for (const [k,v] of states) if (v < now) states.delete(k); for (const [k,v] of sessions) if (v.expires < now) sessions.delete(k); };
  async function authorize(userId) {
    if (!client.isReady?.()) return { status: 503, error: 'Bot belum siap memverifikasi server.' };
    const guild = client.guilds.cache.get(client.homeGuildId);
    if (!guild || !isHomeGuild(client, guild.id)) return { status: 503, error: 'Bot belum tersedia di server yang dikonfigurasi.' };
    try {
      const member = await guild.members.fetch({ user: userId, force: true });
      if (guild.ownerId !== userId && !member.permissions.has(PermissionFlagsBits.Administrator)) return { status: 403, error: 'Akses hanya untuk owner atau administrator server.' };
      return { guild, member };
    } catch { return { status: 403, error: 'Keanggotaan atau izin server tidak dapat diverifikasi.' }; }
  }
  router.use((req,res,next) => { res.set({'Cache-Control': NO_CACHE, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY'}); next(); });
  router.get('/login', (req,res) => {
    if (!configured) return res.status(503).send('Login belum dikonfigurasi. Atur CLIENT_ID, DISCORD_CLIENT_SECRET, DASHBOARD_URL dan GUILD_ID.');
    purge(); if (states.size >= 5000) return res.status(503).send('Terlalu banyak login yang menunggu.');
    const state = random(); states.set(state, Date.now() + 600000);
    res.cookie('zx_state', state, { ...options, maxAge: 600000 });
    const q = new URLSearchParams({ client_id: env.CLIENT_ID, redirect_uri: origin + '/dashboard/callback', response_type: 'code', scope: 'identify', state });
    res.redirect('https://discord.com/oauth2/authorize?' + q);
  });
  router.get('/callback', async (req,res) => {
    purge(); const state = req.query.state;
    const valid = configured && typeof state === 'string' && state === cookie(req, 'zx_state') && states.has(state);
    if (typeof state === 'string') states.delete(state); clear(res, 'zx_state');
    if (!valid || typeof req.query.code !== 'string' || req.query.code.length > 2048) return res.status(400).send('Login tidak valid atau kedaluwarsa.');
    try {
      const tokenResponse = await fetchImpl('https://discord.com/api/v10/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:env.CLIENT_ID,client_secret:env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code:req.query.code,redirect_uri:origin+'/dashboard/callback'}), signal:AbortSignal.timeout(10000) });
      if (!tokenResponse.ok) throw new Error('token exchange');
      const token = await tokenResponse.json();
      if (!token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('invalid token');
      const userResponse = await fetchImpl('https://discord.com/api/v10/users/@me', { headers:{Authorization:`Bearer ${token.access_token}`}, signal:AbortSignal.timeout(10000) });
      if (!userResponse.ok) throw new Error('identity');
      const user = await userResponse.json();
      if (!/^\d{17,20}$/.test(user.id || '')) throw new Error('invalid identity');
      const access = await authorize(user.id);
      if (access.error) return res.status(access.status).send(access.error);
      if (sessions.size >= 5000) return res.status(503).send('Terlalu banyak sesi aktif.');
      const id=random(); sessions.set(id,{ user: {id:user.id, username:user.global_name || user.username || 'Discord'}, csrf:random(), expires:Date.now()+Math.min(token.expires_in*1000,8*3600*1000) });
      res.cookie('zx_session', id, {...options, maxAge:Math.min(token.expires_in*1000,8*3600*1000)});
      res.redirect('/dashboard/');
    } catch { res.status(502).send('Login Discord gagal. Coba lagi.'); }
  });
  async function auth(req,res,next) {
    purge(); const session = sessions.get(cookie(req,'zx_session'));
    if (!session) return res.status(401).json({error:'Silakan login Discord.'});
    const access = await authorize(session.user.id);
    if (access.error) return res.status(access.status).json({error:access.error});
    req.session = session; req.guild = access.guild; req.member = access.member; next();
  }
  const csrf = (req,res,next) => {
    if (req.get('origin') !== origin || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({error:'Permintaan tidak valid.'});
    next();
  };
  router.use('/api/bot', createBotApiRouter(client, {auth, csrf}));
  router.use('/api/bot', createGoodbyeApi(client, {auth, csrf}));
  router.use('/api/bot', createBirthdayApi(client, {auth, csrf}));
  router.use('/api/bot', createCoreApi(client, {auth, csrf}));
  router.use('/api/bot', createGiveawayApi(client, {auth}));
  router.use('/api/bot', createModulesApi(client, {auth, csrf}));
  router.use('/api/bot', createOperationsApi(client, {auth, csrf}));
  router.use('/api/bot', createHostingApi({auth, env}));
  router.use('/api/ai', createAIApi(client, {auth, csrf, env}));
  router.get('/api/me', auth, (req,res) => res.json({user:req.session.user, guild:{id:req.guild.id,name:req.guild.name}, csrf:req.session.csrf, botReady:client.isReady()}));
  router.post('/api/logout', auth, (req,res) => {
    if (req.get('origin') !== origin || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({error:'Permintaan tidak valid.'});
    sessions.delete(cookie(req,'zx_session')); clear(res,'zx_session'); res.json({ok:true});
  });
  router.get(['/', '/index.html'], (req,res,next) => {
    if (!configured) return res.status(503).send('Dashboard belum dikonfigurasi. Lihat DOKUMENTASI-TAHAP-5.md.');
    purge(); if (!sessions.has(cookie(req,'zx_session'))) return res.redirect('/dashboard/login');
    auth(req,res,() => res.sendFile(path.join(preview,'index.html')));
  });
  router.use(express.static(preview, { index:false, dotfiles:'deny', extensions:false }));
  return router;
}
