import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
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

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Configured home guild: ${client.homeGuildId}; connected guilds: ${client.guilds.cache.size} (others ignored)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      if (client.config?.features?.music) {
        initRiffyAfterReady(client);
      }

      if (!client.guilds.cache.has(client.homeGuildId)) {
        logger.warn('Configured home guild is not available; startup reconciliation skipped.');
        return;
      }
      const ticketPanelSummary = await reconcileTicketPanels(client);
      startupLog(
        `Ticket panel health: scanned ${ticketPanelSummary.scannedGuilds} guilds, healthy ${ticketPanelSummary.healthyPanels}, deleted ${ticketPanelSummary.deletedPanels}, missing channel ${ticketPanelSummary.missingChannels}, recovered ${ticketPanelSummary.recoveredIds}, errors ${ticketPanelSummary.errors}`
      );

      const verificationPanelSummary = await reconcileVerificationPanels(client);
      startupLog(
        `Verification panel health: scanned ${verificationPanelSummary.scannedGuilds} guilds, healthy ${verificationPanelSummary.healthyPanels}, deleted ${verificationPanelSummary.deletedPanels}, missing channel ${verificationPanelSummary.missingChannels}, recovered ${verificationPanelSummary.recoveredIds}, errors ${verificationPanelSummary.errors}`
      );

      // Reads only: a panel whose message is missing stays stored so that it can be reposted.
      const reactionRolePanelSummary = await reconcileReactionRolePanelHealth(client);
      startupLog(
        `Reaction role panels: stored ${reactionRolePanelSummary.scannedPanels}, healthy ${reactionRolePanelSummary.healthyPanels}, message missing ${reactionRolePanelSummary.deletedPanels}, ` +
        `channel missing ${reactionRolePanelSummary.missingChannels}, not checkable ${reactionRolePanelSummary.uncheckedPanels}, unreadable records ${reactionRolePanelSummary.unreadableRecords}, errors ${reactionRolePanelSummary.errors}`
      );

      const levelRoleSummary = await reconcileLevelRoles(client, client.homeGuildId);
      startupLog(
        `Level role sync: scanned ${levelRoleSummary.scannedGuilds} guilds, checked ${levelRoleSummary.membersChecked} members, ` +
        `missing ${levelRoleSummary.missingRewardEntries} reward roles and ${levelRoleSummary.unusableRewardEntries} the bot may not give (config preserved), ` +
        `re-awarded ${levelRoleSummary.rolesReAwarded} roles, errors ${levelRoleSummary.errors}`
      );

      // Last and isolated: it may wait for an interrupted channel create to
      // become checkable, and its failure must not hide the summaries above.
      try {
        const jtc = await reconcileJoinToCreate(client, client.homeGuildId);
        startupLog(
          `Join to Create reconciliation: interrupted creates ${jtc.pendingSettled}, stale records ${jtc.recordsRemoved}, empty channels deleted ${jtc.channelsDeleted}, owners transferred ${jtc.ownersTransferred}, missing triggers ${jtc.triggersRemoved}, waiting members served ${jtc.membersServed}, errors ${jtc.errors}`
        );
      } catch (error) {
        logger.warn(`Join to Create reconciliation skipped (${error?.code ?? error?.name ?? 'error'}): ${error?.message}`);
      }
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};