import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger, startupLog } from '../../utils/logger.js';
import { describeCommands, summarizeCommands } from '../../utils/startupReport.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

function getSubcommandInfo(commandData) {
    const subcommands = [];
    
    if (commandData.options) {
        for (const option of commandData.options) {
if (option.type === 1) {
                subcommands.push(option.name);
} else if (option.type === 2) {
                if (option.options) {
                    for (const subOption of option.options) {
if (subOption.type === 1) {
                            subcommands.push(`${option.name}/${subOption.name}`);
                        }
                    }
                }
            }
        }
    }
    
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        
        if (file.isDirectory()) {
            if (file.name === 'modules') {
                continue;
            }
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    
    return fileList;
}

/** @param {string} [commandsPath] directory holding one folder per category; the bot's own by default */
export async function loadCommands(client, commandsPath = path.join(__dirname, '../../commands')) {
    client.commands = new Collection();
    const commandFiles = await getAllFiles(commandsPath);
    
    logger.debug(`Found ${commandFiles.length} command files to load`);
    
    const uniqueCommandNames = new Set();
    let failed = 0;
    
    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            
            const commandName = path.basename(filePath, '.js');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            
            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;
            
            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                failed += 1;
                continue;
            }
            
            command.category = category;
            command.filePath = normalizedPath;
            
            const primaryCommandName = command.data.name;
            
            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                
                client.commands.set(primaryCommandName, command);
            }
            
            const subcommands = getSubcommandInfo(command.data.toJSON());
            
            // One line per file is for LOG_LEVEL=debug; the summary below is always shown.
            logger.debug(`Command ${primaryCommandName} [${category}]${subcommands.length > 0 ? `, subcommands: ${subcommands.join(', ')}` : ''}`);
            
        } catch (error) {
            failed += 1;
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }
    
    const summary = summarizeCommands(Array.from(client.commands.values(), (command) => ({
        category: command.category,
        subcommands: getSubcommandInfo(command.data.toJSON()).length,
    })));
    for (const line of describeCommands(summary, { failed })) startupLog(line);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn(`Command missing data or toJSON method: ${command}`);
            continue;
        }

        const commandName = command.data.name;
        logger.debug(`Processing command for registration: ${commandName}`);

        if (registeredNames.has(commandName)) {
            logger.debug(`Skipping duplicate command: ${commandName}`);
            continue;
        }

        registeredNames.add(commandName);
        const commandJson = command.data.toJSON();
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;

        if (process.env.NODE_ENV !== 'production') {
            logger.debug(`Registering command: ${commandName}`);
        }
    }

    return { commands, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];

    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) {
            validationErrors.push(`Command ${cmd.name} has name longer than 32 chars: "${cmd.name}" (${cmd.name.length} chars)`);
        }
        if (cmd.description && cmd.description.length > 110) {
            validationErrors.push(`Command ${cmd.name} has description longer than 110 chars: "${cmd.description}" (${cmd.description.length} chars)`);
        }

        if (!cmd.options) {
            continue;
        }

        for (const option of cmd.options) {
            if (option.name && option.name.length > 32) {
                validationErrors.push(`Command ${cmd.name} option ${option.name} has name longer than 32 chars: "${option.name}" (${option.name.length} chars)`);
            }
            if (option.description && option.description.length > 110) {
                validationErrors.push(`Command ${cmd.name} option ${option.name} has description longer than 110 chars: "${option.description}" (${option.description.length} chars)`);
            }

            if (option.choices) {
                for (const choice of option.choices) {
                    if (choice.name && choice.name.length > 110) {
                        validationErrors.push(`Command ${cmd.name} option ${option.name} choice ${choice.name} has name longer than 110 chars: "${choice.name}" (${choice.name.length} chars)`);
                    }
                    if (choice.value && choice.value.length > 100) {
                        validationErrors.push(`Command ${cmd.name} option ${option.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`);
                    }
                }
            }

            if (!option.options) {
                continue;
            }

            for (const subOption of option.options) {
                if (subOption.name && subOption.name.length > 32) {
                    validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has name longer than 32 chars: "${subOption.name}" (${subOption.name.length} chars)`);
                }
                if (subOption.description && subOption.description.length > 110) {
                    validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} has description longer than 110 chars: "${subOption.description}" (${subOption.description.length} chars)`);
                }

                if (!subOption.choices) {
                    continue;
                }

                for (const choice of subOption.choices) {
                    if (choice.name && choice.name.length > 110) {
                        validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has name longer than 110 chars: "${choice.name}" (${choice.name.length} chars)`);
                    }
                    if (choice.value && choice.value.length > 100) {
                        validationErrors.push(`Command ${cmd.name} subcommand ${option.name} option ${subOption.name} choice ${choice.name} has value longer than 100 chars: "${choice.value}" (${choice.value.length} chars)`);
                    }
                }
            }
        }
    }

    if (validationErrors.length > 0) {
        logger.error('Command validation failed. Errors:');
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(commands.length >= MAX_COMMANDS
            ? `Slash commands: ${commands.length} loaded, and Discord registers at most ${MAX_COMMANDS} per server. A further command would be left out.`
            : `Slash commands: ${commands.length} loaded; Discord registers at most ${MAX_COMMANDS} per server.`);
    }

    if (commands.length <= MAX_COMMANDS) {
        return commands;
    }

    logger.warn(`Command count (${commands.length}) exceeds Discord limit (${MAX_COMMANDS}), truncating...`);
    const truncated = commands.slice(0, MAX_COMMANDS);
    logger.info(`Truncated to ${truncated.length} commands for registration`);
    return truncated;
}

// Discord's "primary entry point" command belongs to an app's Activity; Discord manages it.
const ENTRY_POINT_COMMAND_TYPE = 4;

/**
 * Removes the application's global commands.
 *
 * This bot registers its commands for one server only, so it has no handler for a global command:
 * a global command is what another program left behind while it ran with the same application, and
 * Discord keeps offering it (answer: "that command does not exist"). KEEP_GLOBAL_COMMANDS=true
 * leaves them alone. A failure here never stops the bot.
 *
 * @returns {Promise<string[]>} names of the commands removed
 */
export async function removeGlobalCommands(client, clientId, env = process.env) {
    if (String(env.KEEP_GLOBAL_COMMANDS || '').trim().toLowerCase() === 'true') return [];
    const rest = client?.rest;
    if (typeof rest?.get !== 'function' || typeof rest?.delete !== 'function') return [];

    const removed = [];
    try {
        const found = await rest.get(`/applications/${clientId}/commands`);
        const leftovers = (Array.isArray(found) ? found : [])
            .filter((command) => /^\d{17,20}$/.test(String(command?.id || '')) && command.type !== ENTRY_POINT_COMMAND_TYPE);

        for (const command of leftovers) {
            await rest.delete(`/applications/${clientId}/commands/${command.id}`);
            removed.push(`/${command.name}`);
        }
    } catch (error) {
        logger.warn(`Slash commands: global commands left by another program could not be removed (${error?.message || 'unknown error'}). They answer "that command does not exist".`);
    }

    if (removed.length > 0) {
        const shown = removed.slice(0, 10).join(', ') + (removed.length > 10 ? `, and ${removed.length - 10} more` : '');
        startupLog(`Slash commands: ${removed.length} global ${removed.length === 1 ? 'command' : 'commands'} left by another program removed (${shown})`);
    }
    return removed;
}

const MAX_MESSAGE_MENUS = 5;

/** The message-menu commands to register, if the bot offers any. A failure to read them registers none. */
async function messageMenuPayloads(client) {
    if (typeof client.messageMenus !== 'function') return [];
    try {
        const menus = await client.messageMenus();
        return Array.isArray(menus) ? menus.slice(0, MAX_MESSAGE_MENUS) : [];
    } catch (error) {
        logger.warn(`Message menu: settings could not be read, none registered (${error.message})`);
        return [];
    }
}

async function registerGuildCommands(client, clientId, guildId, commands, totalSubcommands, env) {
    if (!clientId) {
        throw new Error('CLIENT_ID is required for slash command registration');
    }

    if (!/^\d{17,20}$/.test(String(guildId || ''))) throw new Error('Valid GUILD_ID is required for slash command registration');

    if (!client.rest) {
        throw new Error('Discord REST client is not available for slash command registration');
    }

    logger.debug(`Validating ${commands.length} commands (${totalSubcommands} subcommands) before registration...`);
    validateCommands(commands);

    const commandsToRegister = prepareCommandsForRegistration(commands);

    if (botConfig.commands?.deleteCommands) {
        logger.info('Clearing existing guild commands before registration...');
        await client.rest.put(`/applications/${clientId}/guilds/${guildId}/commands`, { body: [] });
    }

    // Message-menu entries (AI Studio → Fitur pintar) travel in the same request. Discord counts them apart
    // from the slash commands: at most five per server.
    const menus = await messageMenuPayloads(client);
    logger.debug(`Registering ${commandsToRegister.length} commands for server ${guildId}...`);
    await client.rest.put(`/applications/${clientId}/guilds/${guildId}/commands`, { body: [...commandsToRegister, ...menus] });
    startupLog(`Slash commands: ${commandsToRegister.length} registered for server ${guildId}${menus.length ? ` (+${menus.length} message menu)` : ''}`);
    await removeGlobalCommands(client, clientId, env);
}

export async function registerCommands(client, options = {}) {
    const { clientId = null, guildId = null, env = process.env } = options;

    try {
        const { commands, totalSubcommands } = collectCommandPayloads(client);
        await registerGuildCommands(client, clientId, guildId, commands, totalSubcommands, env);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    
    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }
    
    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());

        const newCommand = (await import(moduleUrl.href)).default;
        
        client.commands.set(commandName, newCommand);
        
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}