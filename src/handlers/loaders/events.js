import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';
import { mayDispatchEvent } from '../../utils/singleGuild.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async function loadEvents(client) {
    const eventsPath = join(__dirname, '../../events');
    const eventFiles = await readdir(eventsPath).then(files => files.filter(file => file.endsWith('.js')));

    logger.info(`Found ${eventFiles.length} event files to load`);

    for (const file of eventFiles) {
        const filePath = join(eventsPath, file);
        try {
            const { default: event } = await import(`file://${filePath}`);

            if (!event?.name || typeof event.execute !== 'function') {
                logger.warn(`Event ${file} is missing required "name" or "execute" properties.`);
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

            if (event.once) {
                client.once(event.name, safeExecute);
                logger.info(`✅ Registered once event: ${event.name}`);
            } else {
                client.on(event.name, safeExecute);
                logger.info(`✅ Registered event: ${event.name}`);
            }
        } catch (error) {
            logger.error(`Error loading event ${file}:`, error);
        }
    }
}