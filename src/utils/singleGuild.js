/** A single bot instance serves only its configured home guild. */
export function requireHomeGuildId(value) {
  const id = String(value || '').trim();
  if (!/^\d{17,20}$/.test(id)) throw new Error('GUILD_ID must be the 17–20 digit Discord server ID.');
  return id;
}
export function isHomeGuild(client, guildId) {
  return Boolean(client?.homeGuildId && typeof guildId === 'string' && guildId === client.homeGuildId);
}
/** Fail closed on events without guild context; ready and userUpdate are intentionally scoped separately. */
export function mayDispatchEvent(client, eventName, args) {
  if (eventName === 'clientReady' || eventName === 'ready' || eventName === 'userUpdate') return Boolean(client?.homeGuildId);
  if (eventName === 'guildCreate' || eventName === 'guildDelete' || eventName === 'guildUpdate') {
    return args.some(x => isHomeGuild(client, x?.id));
  }
  return args.some(x => isHomeGuild(client, x?.guildId || x?.guild?.id));
}
