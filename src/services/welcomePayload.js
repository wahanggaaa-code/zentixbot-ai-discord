import { EmbedBuilder } from 'discord.js';
import { getColor, botConfig } from '../config/bot.js';
import { formatWelcomeMessage } from '../utils/welcome.js';

// Shared by real join and dashboard test so the test matches the bot's behavior.
export function buildWelcomePayload({member, config, canEmbed = true, test = false}) {
  const {user, guild} = member;
  const data = {user, guild, member};
  const message = formatWelcomeMessage(config.welcomeMessage || config.welcomeEmbed?.description || botConfig.welcome?.defaultWelcomeMessage || 'Welcome {user} to {server}!', data);
  const ping = config.welcomePing ? user.toString() : null;
  const allowedMentions = {parse:[], users: !test && config.welcomePing ? [user.id] : []};
  if (!canEmbed) return {content:ping ? `${ping} ${message}` : message, allowedMentions};
  const embed = new EmbedBuilder()
    .setColor(config.welcomeEmbed?.color ?? getColor('success'))
    .setTitle(formatWelcomeMessage(config.welcomeEmbed?.title || '🎉 Welcome!', data))
    .setDescription(message)
    .setThumbnail(user.displayAvatarURL())
    .addFields({name:'User',value:`${user.tag} (${user.id})`,inline:true},{name:'Member Count',value:String(guild.memberCount),inline:true})
    .setTimestamp()
    .setFooter({text:config.welcomeEmbed?.footer ? formatWelcomeMessage(config.welcomeEmbed.footer,data) : `Welcome to ${guild.name}!`});
  const image = config.welcomeImage || config.welcomeEmbed?.image?.url;
  if (image) embed.setImage(image);
  return {content:ping,embeds:[embed],allowedMentions};
}
