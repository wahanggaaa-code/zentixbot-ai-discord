import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import { describeCheck, describeServer } from "../utils/startupReport.js";
import config from "../config/application.js";
import { reconcileTicketPanels, reconcileVerificationPanels, reconcileReactionRolePanelHealth } from "../services/panelHealthService.js";
import { reconcileLevelRoles } from "../services/leveling/levelRoleSyncService.js";
import { initRiffyAfterReady } from "../services/music/riffySetup.js";
import { reconcileJoinToCreate } from "../services/joinToCreateRuntime.js";

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);

      startupLog(`Discord: logged in as ${client.user.tag}`);
      startupLog(describeServer({ id: client.homeGuildId, name: client.guilds.cache.get(client.homeGuildId)?.name ?? null, connected: client.guilds.cache.size }));

      if (client.config?.features?.music) {
        initRiffyAfterReady(client);
      }

      if (!client.guilds.cache.has(client.homeGuildId)) {
        logger.warn('Configured home guild is not available; startup reconciliation skipped.');
        return;
      }
      // A check that met errors is printed as a warning, so that it stands out among the others.
      const report = (title, counts) => {
        const failed = counts.some(([label, count]) => label === 'errors' && count > 0);
        for (const line of describeCheck(title, counts)) failed ? logger.warn(line) : startupLog(line);
      };

      const tickets = await reconcileTicketPanels(client);
      report('ticket panels', [
        ['healthy', tickets.healthyPanels], ['deleted', tickets.deletedPanels], ['channel missing', tickets.missingChannels],
        ['recovered', tickets.recoveredIds], ['errors', tickets.errors],
      ]);

      const verification = await reconcileVerificationPanels(client);
      report('verification panels', [
        ['healthy', verification.healthyPanels], ['deleted', verification.deletedPanels], ['channel missing', verification.missingChannels],
        ['recovered', verification.recoveredIds], ['errors', verification.errors],
      ]);

      // Reads only: a panel whose message is missing stays stored so that it can be reposted.
      const reactionRoles = await reconcileReactionRolePanelHealth(client);
      report('reaction role panels', [
        ['stored', reactionRoles.scannedPanels], ['healthy', reactionRoles.healthyPanels], ['message missing', reactionRoles.deletedPanels],
        ['channel missing', reactionRoles.missingChannels], ['not checkable', reactionRoles.uncheckedPanels],
        ['unreadable records', reactionRoles.unreadableRecords], ['errors', reactionRoles.errors],
      ]);

      const levelRoles = await reconcileLevelRoles(client, client.homeGuildId);
      report('level roles', [
        ['members checked', levelRoles.membersChecked], ['roles given again', levelRoles.rolesReAwarded],
        ['reward roles missing', levelRoles.missingRewardEntries], ['reward roles the bot may not give', levelRoles.unusableRewardEntries],
        ['errors', levelRoles.errors],
      ]);

      // Last and isolated: it may wait for an interrupted channel create to
      // become checkable, and its failure must not hide the summaries above.
      try {
        const jtc = await reconcileJoinToCreate(client, client.homeGuildId);
        report('Join to Create', [
          ['interrupted creates', jtc.pendingSettled], ['stale records', jtc.recordsRemoved], ['empty channels deleted', jtc.channelsDeleted],
          ['owners transferred', jtc.ownersTransferred], ['missing triggers', jtc.triggersRemoved],
          ['waiting members served', jtc.membersServed], ['errors', jtc.errors],
        ]);
      } catch (error) {
        logger.warn(`Check, Join to Create: skipped (${error?.code ?? error?.name ?? 'error'}): ${error?.message}`);
      }
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};