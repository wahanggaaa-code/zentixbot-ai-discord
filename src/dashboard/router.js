import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits } from 'discord.js';
import { isHomeGuild } from '../utils/singleGuild.js';
import { logger } from '../utils/logger.js';
import { dashboardLoginStatus, notConfiguredMessage } from './origin.js';
import { callbackProblem, loginProblemPage } from './loginProblem.js';
import { loginFormPage, tokenLoginStatus, tokenMatches, tokenOffMessage, TOKEN_SESSION_MS } from './tokenLogin.js';
import { createBotApiRouter } from './botApi.js';
import { createGoodbyeApi } from './goodbyeApi.js';
import { createBirthdayApi } from './birthdayApi.js';
import { createCoreApi } from './coreApi.js';
import { createGiveawayApi } from './giveawayApi.js';
import { createJoinToCreateApi } from './joinToCreateApi.js';
import { createJoinToCreateSettingsApi } from './joinToCreateSettingsApi.js';
import { createModulesApi } from './modulesApi.js';
import { createOperationsApi } from './operationsApi.js';
import { createHostingApi } from './hostingApi.js';
import { createAIApi } from './aiApi.js';
import { createSettingsApi } from './settingsApi.js';
import { createServerStatsApi } from './serverStatsApi.js';
import { createReactionRolesApi } from './reactionRolesApi.js';
import { createCountingApi } from './countingApi.js';
import { createApplicationsApi } from './applicationsApi.js';

const preview = fileURLToPath(new URL('../../dashboard-preview/', import.meta.url));
const random = () => crypto.randomBytes(32).toString('hex');
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(x => x.trim().split('=')).find(x => x[0] === name)?.[1];
const NO_CACHE = 'no-store';

/**
 * Puts the dashboard at /dashboard on the web server.
 *
 * "/dashboard" without the closing slash is sent on to "/dashboard/", because the page's relative
 * addresses (session.js, styles) would otherwise point outside the dashboard. Express matches a
 * route with and without a closing slash, so the address that already has one must be passed
 * through; redirecting it too sends the browser in a circle and the page never opens.
 */
export function mountDashboard(app, client, options) {
  app.get('/dashboard', (req, res, next) => (req.path.endsWith('/') ? next() : res.redirect('/dashboard/')));
  app.use('/dashboard', createDashboardRouter(client, options));
}

// Sessions are process-local: deployment with multiple workers needs a shared session store.
export function createDashboardRouter(client, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const router = express.Router();
  const states = new Map(), sessions = new Map();
  // Login stays disabled until DASHBOARD_URL is usable; see origin.js for what counts as usable.
  const { origin, insecure, reason, configured } = dashboardLoginStatus(env, client.homeGuildId);
  // The other way in: DASHBOARD_TOKEN typed into a form. It works without the Discord login above.
  const tokenLogin = tokenLoginStatus(env);
  if (tokenLogin.enabled && !origin?.startsWith('https:')) logger.warn('Dashboard: token login is on without an https address in DASHBOARD_URL. Over plain HTTP the token and the login session are not encrypted in transit.');
  else if (insecure) logger.warn(`Dashboard is served over plain HTTP at ${origin} (DASHBOARD_ALLOW_HTTP). Login sessions are not encrypted in transit.`);
  if (tokenLogin.reason === 'too_short' || tokenLogin.reason === 'no_owner') logger.warn(`Dashboard: DASHBOARD_TOKEN is set but the token login is off (${tokenLogin.reason === 'too_short' ? 'the token is shorter than 12 characters' : 'OWNER_IDS holds no Discord user ID'}).`);
  // Requests that change something must come from the dashboard's own pages. Without a usable
  // DASHBOARD_URL the address is not known in advance, and the page's address must be the one the
  // request was sent to.
  const fromOwnPage = (req) => {
    const sent = req.get('origin');
    if (origin) return sent === origin;
    try { return Boolean(sent) && new URL(sent).host === req.get('host'); } catch { return false; }
  };
  const options = { httpOnly: true, secure: origin?.startsWith('https:') || false, sameSite: 'lax', path: '/dashboard' };
  const clear = (res, name) => res.clearCookie(name, options);
  const purge = () => { const now = Date.now(); for (const [k,v] of states) if (v < now) states.delete(k); for (const [k,v] of sessions) if (v.expires < now) sessions.delete(k); };
  // `operator` is true for a token login: the holder of DASHBOARD_TOKEN runs the bot, and acts as
  // the account in OWNER_IDS whether or not that account is an administrator of the server.
  async function authorize(userId, operator = false) {
    if (!client.isReady?.()) return { status: 503, error: 'Bot belum siap memverifikasi server.' };
    const guild = client.guilds.cache.get(client.homeGuildId);
    if (!guild || !isHomeGuild(client, guild.id)) return { status: 503, error: 'Bot belum tersedia di server yang dikonfigurasi.' };
    try {
      const member = await guild.members.fetch({ user: userId, force: true });
      if (!operator && guild.ownerId !== userId && !member.permissions.has(PermissionFlagsBits.Administrator)) return { status: 403, error: 'Akses hanya untuk owner atau administrator server.' };
      return { guild, member };
    } catch { return { status: 403, error: 'Keanggotaan atau izin server tidak dapat diverifikasi.' }; }
  }
  router.use((req,res,next) => { res.set({'Cache-Control': NO_CACHE, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'DENY'}); next(); });
  router.get('/login', (req,res) => {
    if (tokenLogin.enabled && req.query.via !== 'discord') return res.send(loginFormPage({ discord: configured }));
    if (!configured) return res.status(503).send(tokenLogin.reason === 'missing' || tokenLogin.enabled ? notConfiguredMessage(reason) : tokenOffMessage(tokenLogin.reason));
    purge();
    // A browser that opens the login twice (second tab, reload, prefetch) keeps its pending state.
    // A fresh state each time would overwrite the cookie and make the login begun first fail.
    const pending = cookie(req, 'zx_state');
    const state = states.has(pending) ? pending : random();
    if (state !== pending) {
      if (states.size >= 5000) return res.status(503).send('Terlalu banyak login yang menunggu.');
      states.set(state, Date.now() + 600000);
    }
    res.cookie('zx_state', state, { ...options, maxAge: Math.max(1000, states.get(state) - Date.now()) });
    const q = new URLSearchParams({ client_id: env.CLIENT_ID, redirect_uri: origin + '/dashboard/callback', response_type: 'code', scope: 'identify', state });
    res.redirect('https://discord.com/oauth2/authorize?' + q);
  });
  router.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), async (req,res) => {
    const form = (status, error) => res.status(status).send(loginFormPage({ error, discord: configured }));
    if (!tokenLogin.enabled) return res.status(503).send(tokenOffMessage(tokenLogin.reason));
    if (req.get('origin') && !fromOwnPage(req)) return form(403, origin ? `Login hanya diterima dari ${origin}/dashboard/login. Buka alamat itu, atau sesuaikan DASHBOARD_URL dengan alamat yang kamu pakai.` : 'Permintaan tidak valid. Buka halaman login ini langsung dari alamat dashboard.');
    if (!tokenMatches(req.body?.token, env)) {
      logger.warn(`Dashboard: token login refused for ${req.ip} (wrong token)`);
      return form(401, 'Token salah.');
    }
    purge();
    const access = await authorize(tokenLogin.ownerId, true);
    if (access.error) {
      logger.warn(`Dashboard: token login could not be completed (${access.error})`);
      return form(access.status, access.status === 403 ? `Akun di OWNER_IDS (${tokenLogin.ownerId}) bukan anggota server yang dikonfigurasi, atau keanggotaannya tidak dapat diperiksa.` : access.error);
    }
    if (sessions.size >= 5000) return form(503, 'Terlalu banyak sesi aktif.');
    const person = access.member?.user;
    const id = random(); sessions.set(id, { user: { id: tokenLogin.ownerId, username: person?.globalName || person?.username || 'Owner' }, csrf: random(), expires: Date.now() + TOKEN_SESSION_MS, operator: true });
    res.cookie('zx_session', id, { ...options, maxAge: TOKEN_SESSION_MS });
    logger.info(`Dashboard: token login from ${req.ip}, acting as ${tokenLogin.ownerId}`);
    res.redirect(303, '/dashboard/');
  });
  router.get('/callback', async (req,res) => {
    if (!configured) return res.status(503).send(notConfiguredMessage(reason));
    purge(); const state = req.query.state, sent = cookie(req, 'zx_state');
    const known = typeof state === 'string' && states.has(state);
    // Only the browser that began a login spends it, and does so whether or not it then succeeds.
    // A request without that browser's cookie (a link preview, another browser) leaves it pending.
    if (sent === state) { states.delete(state); clear(res, 'zx_state'); }
    const problem = callbackProblem({ state, known, sent, code: req.query.code, denied: typeof req.query.error === 'string' });
    if (problem) {
      // Reloading the callback after a finished login, or finishing it in a second tab.
      if (sessions.has(cookie(req, 'zx_session'))) return res.redirect('/dashboard/');
      return res.status(400).send(loginProblemPage(problem, origin));
    }
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
    if (!session) return res.status(401).json({error:'Silakan login.'});
    const access = await authorize(session.user.id, session.operator === true);
    if (access.error) return res.status(access.status).json({error:access.error});
    req.session = session; req.guild = access.guild; req.member = access.member; next();
  }
  const csrf = (req,res,next) => {
    if (!fromOwnPage(req) || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({error:'Permintaan tidak valid.'});
    next();
  };
  router.use('/api/bot', createBotApiRouter(client, {auth, csrf}));
  router.use('/api/bot', createGoodbyeApi(client, {auth, csrf}));
  router.use('/api/bot', createBirthdayApi(client, {auth, csrf}));
  router.use('/api/bot', createCoreApi(client, {auth, csrf}));
  router.use('/api/bot', createGiveawayApi(client, {auth, csrf}));
  router.use('/api/bot', createJoinToCreateApi(client, {auth}));
  router.use('/api/bot', createJoinToCreateSettingsApi(client, {auth, csrf}));
  router.use('/api/bot', createServerStatsApi(client, {auth, csrf}));
  router.use('/api/bot', createReactionRolesApi(client, {auth, csrf}));
  router.use('/api/bot', createCountingApi(client, {auth, csrf}));
  router.use('/api/bot', createApplicationsApi(client, {auth, csrf}));
  router.use('/api/bot', createModulesApi(client, {auth, csrf}));
  router.use('/api/bot', createOperationsApi(client, {auth, csrf}));
  router.use('/api/bot', createHostingApi({auth, env}));
  router.use('/api/bot', createSettingsApi(client, {auth, env}));
  router.use('/api/ai', createAIApi(client, {auth, csrf, env}));
  // botOwner lets AI Studio say up front that its routes will refuse this account (see `owner` in aiApi.js).
  const botOwners = () => String(env.OWNER_IDS || '').split(',').map((x) => x.trim()).filter((x) => /^\d{17,20}$/.test(x));
  router.get('/api/me', auth, (req,res) => res.json({user:req.session.user, guild:{id:req.guild.id,name:req.guild.name}, csrf:req.session.csrf, botReady:client.isReady(), botOwner:botOwners().includes(req.session.user.id)}));
  router.post('/api/logout', auth, (req,res) => {
    if (!fromOwnPage(req) || req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({error:'Permintaan tidak valid.'});
    sessions.delete(cookie(req,'zx_session')); clear(res,'zx_session'); res.json({ok:true});
  });
  router.get(['/', '/index.html'], (req,res,next) => {
    if (!configured && !tokenLogin.enabled) return res.status(503).send(tokenLogin.reason === 'missing' ? notConfiguredMessage(reason) : tokenOffMessage(tokenLogin.reason));
    purge(); if (!sessions.has(cookie(req,'zx_session'))) return res.redirect('/dashboard/login');
    auth(req,res,() => res.sendFile(path.join(preview,'index.html')));
  });
  router.use(express.static(preview, { index:false, dotfiles:'deny', extensions:false }));
  return router;
}
