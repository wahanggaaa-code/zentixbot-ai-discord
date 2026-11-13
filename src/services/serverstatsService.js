// Labels and the channel name of server stats counters.
// Storage is in ./serverStats/store.js, renaming in ./serverStats/refresh.js,
// and create / change / delete in ./serverStats/manage.js.

import botConfig from '../config/bot.js';

export const COUNTER_TYPE_CONFIG = {
  members: {
    label: 'Members + Bots',
    baseName: 'Members & Bots',
    emoji: '👥'
  },
  members_only: {
    label: 'Members Only',
    baseName: 'Members',
    emoji: '👤'
  },
  bots: {
    label: 'Bots Only',
    baseName: 'Bots',
    emoji: '🤖'
  }
};

function getCounterConfig(type) {
  return COUNTER_TYPE_CONFIG[type] || {
    label: 'Unknown',
    baseName: 'Counter',
    emoji: '❓'
  };
}

export function getCounterTypeLabel(type) {
  return getCounterConfig(type).label;
}

export function getCounterBaseName(type) {
  return getCounterConfig(type).baseName;
}

export function getCounterEmoji(type) {
  return getCounterConfig(type).emoji;
}

export function formatCounterChannelName(type, count) {
  const template = botConfig.counters?.defaults?.channelName || '{name}-{count}';
  const baseName = getCounterBaseName(type);
  return template
    .replaceAll('{name}', baseName)
    .replaceAll('{count}', String(count));
}
