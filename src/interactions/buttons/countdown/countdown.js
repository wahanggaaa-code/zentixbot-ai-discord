import { countdownButtonHandler, legacyCountdownButton } from '../../../handlers/countdownButtons.js';

export default [
  {
    name: 'countdown',
    execute: countdownButtonHandler,
  },
  // Buttons under countdown messages posted by earlier versions.
  {
    name: 'countdown_pause',
    execute: legacyCountdownButton,
  },
  {
    name: 'countdown_cancel',
    execute: legacyCountdownButton,
  },
];
