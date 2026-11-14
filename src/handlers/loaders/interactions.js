import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { logger, startupLog } from '../../utils/logger.js';
import { describeInteractions } from '../../utils/startupReport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const interactionTypes = ['buttons', 'selectMenus', 'modals'];
const LABELS = { buttons: 'Button', selectMenus: 'Select menu', modals: 'Modal' };

async function getAllInteractionFiles(directory, fileList = []) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      await getAllInteractionFiles(entryPath, fileList);
    } else if (entry.name.endsWith('.js')) {
      fileList.push(entryPath);
    }
  }

  return fileList;
}

/** @param {string} [interactionsPath] directory holding buttons/, selectMenus/ and modals/; the bot's own by default */
export default async (client, interactionsPath = join(__dirname, '../../interactions')) => {
  try {
    const loaded = { buttons: 0, selectMenus: 0, modals: 0 };
    let failed = 0;

    for (const type of interactionTypes) {
      const typePath = join(interactionsPath, type);

      try {
        const interactionFiles = await getAllInteractionFiles(typePath);

        for (const filePath of interactionFiles) {
          const relativePath = filePath.slice(interactionsPath.length + 1).replace(/\\/g, '/');
          const fileName = relativePath.split('/').pop();

          try {
            const module = await import(pathToFileURL(filePath).href);
            const moduleExport = module.default;
            const interactions = Array.isArray(moduleExport) ? moduleExport : [moduleExport];

            for (const interaction of interactions) {
              if (!interaction?.name || !interaction?.execute) {
                logger.warn(`Interaction ${relativePath} in ${type} is missing required properties.`);
                failed += 1;
                continue;
              }

              client[type].set(interaction.name, interaction);
              loaded[type] += 1;
              logger.debug(`${LABELS[type]} ${interaction.name} (${fileName})`);
            }
          } catch (error) {
            failed += 1;
            logger.error(`Error loading interaction ${relativePath} in ${type}:`, error);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`Error loading ${type}:`, error);
        } else {
          logger.debug(`No ${type} directory found, skipping...`);
        }
      }
    }

    startupLog(describeInteractions(loaded, { failed }));
  } catch (error) {
    logger.error('Error loading interactions:', error);
  }
};
