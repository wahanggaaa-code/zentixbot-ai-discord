import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger, startupLog } from '../../utils/logger.js';
import { describeEvents } from '../../utils/startupReport.js';
import { mayDispatchEvent } from '../../utils/singleGuild.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @param {string} [eventsPath] directory of the event files; the bot's own by default */
export default async function loadEvents(client, eventsPath = join(__dirname, '../../events')) {
    const eventFiles = await readdir(eventsPath).then(files => files.filter(file => file.endsWith('.js')));

    logger.debug(`Found ${eventFiles.length} event files to load`);
    let registered = 0, failed = 0;

    for (const file of eventFiles) {
        const filePath = join(eventsPath, file);
        try {
            const { default: event } = await import(`file://${filePath}`);

            if (!event?.name || typeof event.execute !== 'function') {
                logger.warn(`Event ${file} is missing required "name" or "execute" properties.`);
                failed += 1;
                continue;
            }

            const safeExecute = async (...args) => {
                try {
                    if (!mayDispatchEvent(client, event.name, args)) {
                        const interaction = event.name === 'interactionCreate' ? args[0] : null;
                        if (interaction?.isAutocomplete?.()) await interaction.respond([]).catch(() => {});
                        else if (interaction?.isRepliable?.() && !interaction.replied && !interaction.deferred) {
                            await interaction.reply({ content: 'Bot ini hanya aktif di server yang dikonfigurasi.', ephemeral: true }).catch(() => {});
                        }
                        return;
                    }
                    await event.execute(...args, client);
                } catch (error) {
                    logger.error(`Error executing event ${event.name}:`, error);
                }
            };

            if (event.once) client.once(event.name, safeExecute);
            else client.on(event.name, safeExecute);
            registered += 1;
            logger.debug(`Event ${event.name}${event.once ? ' (once)' : ''}`);
        } catch (error) {
            failed += 1;
            logger.error(`Error loading event ${file}:`, error);
        }
    }

    startupLog(describeEvents(registered, { failed }));
}