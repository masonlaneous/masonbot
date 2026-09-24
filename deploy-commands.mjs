import { REST, Routes } from 'discord.js';
import config from './config.json' with { type: 'json' };
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { clientId, token } = config;

async function deployCommands() {
    const commands = [];
    const foldersPath = path.join(__dirname, 'dist', 'commands');
    const commandFolders = fs.readdirSync(foldersPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles = fs.readdirSync(commandsPath, { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
            .map(entry => entry.name);

        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = await import(pathToFileURL(filePath).href);
            if ('data' in command && 'execute' in command) {
                const commandData = command.data.toJSON();

                commandData.integration_types = [0, 1];
                commandData.contexts = [0, 1, 2];

                commands.push(commandData);
            } else {
                console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
            }
        }
    }

    // Construct and prepare an instance of the REST module
    const rest = new REST().setToken(token);

    // Deploy the commands
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    // The put method is used to fully refresh all commands globally
    const data = await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands },
    );

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    process.exit(0);
}

try {
    await deployCommands();
} catch (error) {
    console.error(error);
    process.exit(1);
}
