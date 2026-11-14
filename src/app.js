import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import { mountDashboard } from './dashboard/router.js';
import { createAIFoundation } from './services/ai/foundation.js';
import { createAudioService } from './services/ai/audio.js';
import { createImageService } from './services/ai/images.js';
import { createSearchService } from './services/ai/search.js';
import { describeExtraProviders } from './services/ai/extraProviders.js';
import { runProactiveAgent } from './services/ai/chat.js';
import { createInteractive } from './services/ai/interactive.js';
import { getCommandPrefix } from './config/bot.js';
import { runScheduledActivity } from './services/ai/activities.js';
import { requireHomeGuildId, isHomeGuild } from './utils/singleGuild.js';
import cron from 'node-cron';

import config from './config/application.js';
import { resolveWebPort, WEB_PORT_VARIABLES } from './utils/webPort.js';
import { createWebRateLimit } from './utils/webRateLimit.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { maintainCounters } from './services/serverStats/manage.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { describeDashboard, onlineSummary } from './utils/startupReport.js';
import { dashboardLoginStatus } from './dashboard/origin.js';
import { tokenLoginStatus } from './dashboard/tokenLogin.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { createReadinessHandler } from './services/storage/databaseReadiness.js';

const DATABASE_NAMES = { postgresql: 'PostgreSQL' };

class ZentixBot extends Client {
  constructor() {
    super({
      intents: [
        
        GatewayIntentBits.Guilds,                        
        GatewayIntentBits.GuildMembers,                 

        GatewayIntentBits.GuildMessages,                
        GatewayIntentBits.GuildMessageReactions,        
        GatewayIntentBits.MessageContent,               
        GatewayIntentBits.DirectMessages,

        GatewayIntentBits.GuildVoiceStates,             

        GatewayIntentBits.GuildBans,                    
      ],
    });

    this.config = config;
    this.homeGuildId = requireHomeGuildId(process.env.GUILD_ID);
    this.aiFoundation = createAIFoundation({client:this});
    // The prefix is looked up per message: a server can change it, and those messages are commands, not chat.
    this.aiInteractive = createInteractive({
      client: this,
      prefix: async (message) => {
        try { return (await getGuildConfig(this, message.guild.id))?.prefix || getCommandPrefix(); } catch { return getCommandPrefix(); }
      },
    });
    this.aiImageService = createImageService({client:this});
    this.aiAudioService = createAudioService({client:this});
    this.aiSearchService = createSearchService({client:this});
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog(`ZentixBot ${pkg.version} starting (Node ${process.version}, ${process.env.NODE_ENV || 'development'} mode, log level ${logger.level})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;

      const dbStatus = this.db.getStatus();
      if (!dbStatus.isAvailable || dbStatus.isDegraded) {
        throw Object.assign(new Error('Persistent database is unavailable; startup aborted.'), {code:'POSTGRES_UNAVAILABLE'});
      }
      startupLog(`Database: ${DATABASE_NAMES[dbStatus.connectionType] ?? dbStatus.connectionType} connected, data is persistent`);

      for (const line of describeExtraProviders(process.env)) {
        if (line.level === 'warn') logger.warn(line.text);
        else startupLog(line.text);
      }

      this.startWebServer();
      
      await loadCommands(this);
      await this.loadHandlers();

      initializeMusic(this);
      
      startupLog('Discord: logging in...');
      await this.login(this.config.bot.token);
      
      const registered = await this.registerCommands();
      
      for (const line of onlineSummary({
        version: pkg.version,
        seconds: process.uptime(),
        botTag: this.user?.tag ?? null,
        guildId: this.homeGuildId,
        guildName: this.guilds.cache.get(this.homeGuildId)?.name ?? null,
        loaded: { commands: this.commands.size, buttons: this.buttons.size, selectMenus: this.selectMenus.size, modals: this.modals.size },
        registered,
        database: `${DATABASE_NAMES[dbStatus.connectionType] ?? dbStatus.connectionType}, persistent`,
        port: this.webServer?.address()?.port ?? null,
        dashboard: describeDashboard(dashboardLoginStatus(process.env, this.homeGuildId), tokenLoginStatus(process.env)),
        memoryBytes: process.memoryUsage().rss,
      })) startupLog(line);
      
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    const { port: configuredPort, source: portSource, ignored: ignoredPortVariables } = resolveWebPort(process.env);
    if (ignoredPortVariables.length) logger.warn(`Ignored ${ignoredPortVariables.join(', ')}: not a port number between 1 and 65535.`);
    startupLog(portSource ? `Web port ${configuredPort} taken from ${portSource}` : `Web port ${configuredPort} (default; none of ${WEB_PORT_VARIABLES.join(', ')} is set)`);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';
    
    app.use((req, res, next) => {
      if (req.path === '/dashboard' || req.path.startsWith('/dashboard/')) return next();
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || '*');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    // Dashboard pages and login have their own budgets; the configured numbers apply to the rest.
    app.use(createWebRateLimit({ general: this.config.api?.rateLimit }));

    mountDashboard(app, this);

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: Boolean(dbStatus.isAvailable),
          liveCheck: false,
          degraded: dbStatus.isDegraded,
          type: dbStatus.connectionType
        }
      };
      res.status(200).json(status);
    });

    app.get('/ready', createReadinessHandler(this));

    app.get('/', (req, res) => {
      res.status(200).json({ 
        message: 'ZentixBot System Online',
        version: pkg.version,
        timestamp: new Date().toISOString()
      });
    });

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`Web server: listening on ${host}:${port} (/health, /ready, /dashboard/)`);
      });

      server.on('error', (error) => {
        const errorCode = error?.code || 'UNKNOWN_ERROR';
        const errorMessage = error?.message || 'Unknown server error';

        if (!hasStartedListening && errorCode === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }

        if (hasStartedListening && errorCode === 'EADDRINUSE') {
          logger.warn(`Web server reported a duplicate bind warning on ${host}:${port}, but the bot remains online.`);
          return;
        }

        logger.error(`Web server error on port ${port} (${errorCode}): ${errorMessage}`);

        if (!hasStartedListening) {
          process.exit(1);
        }
      });
    };

    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    // Birthdays are matched against the UTC date, so the daily run is pinned
    // to UTC as well; otherwise a host in another timezone could announce
    // the previous day's birthdays.
    cron.schedule('0 6 * * *', runSafeTask('birthday_check', () => checkBirthdays(this)), { timezone: 'UTC' });
    cron.schedule('* * * * *', runSafeTask('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('* * * * *', runSafeTask('ai_activity', () => runScheduledActivity(this)));
    cron.schedule('* * * * *', runSafeTask('ai_proactive', () => runProactiveAgent(this)));
    cron.schedule('* * * * *', runSafeTask('ai_interactive_idle', () => this.aiInteractive.runIdle()));
    cron.schedule('*/15 * * * *', runSafeTask('counter_update', () => this.updateAllCounters()));
  }

  async updateAllCounters() {
    if (!this.db) {
      logger.warn('Database not available for counter updates');
      return;
    }
    
    for (const [guildId, guild] of this.guilds.cache) {
      if (!isHomeGuild(this, guildId)) continue;
      try {
        const { removed } = await maintainCounters(this, guild);
        if (removed.length > 0) {
          logger.info(`Cleaned up ${removed.length} counter(s) without a channel from guild ${guildId} during scheduled update`);
        }
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true }
    ];

    for (const handler of handlers) {
      try {
        const module = await import(`./handlers/loaders/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:')
          ? module[handler.type.split(':')[1]]
          : module.default;

        if (typeof loaderFn === 'function') {
          await loaderFn(this);
        } else {
          throw new Error(`Invalid loader export from ${handler.path}`);
        }
      } catch (error) {
        if (handler.required) {
          logger.error(`Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        } else if (error.code !== 'MODULE_NOT_FOUND') {
          logger.warn(`Failed to load optional handler ${handler.path}:`, error.message);
        }
      }
    }
  }

  /** Registers the slash commands; a failure is logged by the loader and does not stop the bot. */
  async registerCommands() {
    try {
      await registerSlashCommands(this, { clientId: this.config.bot.clientId, guildId: this.homeGuildId });
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Shutting down (${reason})...`);
    const stopped = [];

    try {
      cron.getTasks().forEach(task => task.stop());
      stopped.push('scheduled jobs');

      await shutdownMusic(this);
      stopped.push('music players');

      if (this.webServer) {
        await new Promise((resolve) => this.webServer.close(resolve));
        stopped.push('web server');
      }

      if (this.db && this.db.db) {
        try {
          if (this.db.db.pool) {
            await this.db.db.pool.end();
            stopped.push('database connection');
          } else if (this.db.db.sqlite?.isOpen?.()) {
            this.db.db.sqlite.close();
            stopped.push('database connection');
          }
        } catch (error) {
          logger.warn('Error closing database pool:', error.message);
        }
      }

      if (this.isReady()) {
        try {
          this.destroy();
          stopped.push('Discord connection');
        } catch (error) {
          logger.warn('Discord client destroy warning (non-critical):', error.message);
        }
      }

      shutdownLog(`Stopped cleanly: ${stopped.join(', ')}.`);
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }
}

try {
  const bot = new ZentixBot();
  
  const setupShutdown = () => {
    process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
    process.on('SIGINT', () => bot.shutdown('SIGINT'));
    
    process.on('uncaughtException', (error) => {
      // Process state may be corrupt after an uncaught throw; log and shut down cleanly.
      handleTaskError('uncaught_exception', error, { fatal: true });
      bot.shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', (reason) => {
      const code = reason?.code;
      if (code === 10062 || code === 40060 || code === 50027) {
        logger.warn('Recoverable Discord interaction rejection:', reason?.message || reason);
        return;
      }
      if (reason?.message?.includes('Queue is empty')) {
        return;
      }

      // A stray rejection is a bug to fix, not a reason to take the bot down.
      // Log loudly with full context; the central task handler categorizes it.
      handleTaskError('unhandled_rejection', reason instanceof Error ? reason : new Error(String(reason)), {
        errorCode: ErrorCodes.UNHANDLED_REJECTION,
      });
    });
  };
  
  setupShutdown();
  bot.start().catch((error) => {
    logger.error('Fatal error during bot startup:', error);
    bot.shutdown('STARTUP_ERROR');
  });
} catch (error) {
  logger.error('Fatal error during bot startup:', error);
  process.exit(1);
}

export default ZentixBot;