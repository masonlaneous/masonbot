import fs from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))
import { Client, Collection, Events, GatewayIntentBits, EmbedBuilder, MessageFlags, ActivityType, TextChannel } from 'discord.js'
import config from '../config.json' with { type: "json" }
import cron from 'node-cron'
import { arrayBuffer } from 'node:stream/consumers'


const client = new Client({ intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] })

client.commands = new Collection()

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

async function loadCommands() {
	for (const folder of commandFolders) {
		const commandsPath = path.join(foldersPath, folder);
		const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js') || file.endsWith('ts'));
		for (const file of commandFiles) {
			const filePath = path.join(commandsPath, file);
			const command = await import(`file://${filePath}`);
			// Set a new item in the Collection with the key as the command name and the value as the exported module
			if ('data' in command && 'execute' in command) {
				client.commands.set(command.data.name, command);
			} else {
				console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
			}
		}
	}
}

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
let chores = ['towels + living room', 'counters + shower', 'sweep + mop', 'towels + living room', 'upstairs bathroom', 'counters + sweep', 'halls + stairs']
let payment = [12, 15, 27, 12, 15, 12, 20]
let choreHasBeenCompleted = false

const createChoreWeek = (dayOfWeek: number) => {
	let weekString = ''

	for (let i = 0; i < chores.length; i++) {
		weekString += `${i === dayOfWeek ? '__' : ''}\`${daysOfWeek[i]} ($${payment[i]})\`: ${chores[i]} ${i === dayOfWeek ? '__' : ''}\n`
	}

	return weekString
}

client.once(Events.ClientReady, async readyClient => {
	await loadCommands()
	const mason = await client.users.fetch('264590999479648268')

	// Send a ping to activate the DM channel
	await mason.send('Masonbot is online.')

	// client.user.setActivity({
	//     type: ActivityType.Custom,
	//     name: 'customstatus',
	//     state: 'hi!! :3'
	// })


	// cron.schedule('0 0 * * *', () => {
	// 	if (!choreHasBeenCompleted) {
	// 		mason.send('You failed to finish your chore for today!')
	// 	}

	// 	choreHasBeenCompleted = false
	// })

	// cron.schedule('0 9 * * *', () => {
	// 	let dayOfWeek = new Date().getDay()

	// 	mason.send(createChoreWeek(dayOfWeek))
	// })

	// cron.schedule('0 12,14,16,18 * * *', () => {
	// 	if (choreHasBeenCompleted) return
	// 	let dayOfWeek = new Date().getDay()

	// 	mason.send(`Have you done today's chore (${chores[dayOfWeek]}) yet?`)
	// })

	console.log(`logged in as ${readyClient.user.tag}`)

})

client.on('messageCreate', async (message) => {
	console.log('message received')
	if (message.author.bot) return
	let dayOfWeek = new Date().getDay()

	if (message.channel.id === '483368914588532746') {
		let response = message.content.toLowerCase().replace(/[^a-z]/gm, '')

		if (response === 'yes' || response === 'done') {
			if (choreHasBeenCompleted) {
				message.channel.send('You already completed the chore, silly!')
			} else {
				message.channel.send(`Good job! You just earned $${payment[dayOfWeek]}! Marking chore as done.`)
				choreHasBeenCompleted = true
			}
		} else if (response === "no" || response === 'not yet') {
			message.channel.send(`Well get to it! That's $${payment[dayOfWeek]}!`)
		} else if (response === "week") {
			message.channel.send(createChoreWeek(dayOfWeek))
		}
	}
})

client.on(Events.InteractionCreate, async interaction => {
	if (interaction.isButton()) {
		const [commandName] = interaction.customId.split(':')
		const command = interaction.client.commands.get(commandName)

		if (!command?.handleButton) {
			await interaction.reply({
				content: 'This button is no longer available.',
				flags: MessageFlags.Ephemeral
			})
			return
		}

		try {
			await command.handleButton(interaction)
		} catch (error) {
			console.error(error)
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: 'There was an error handling that button.', flags: MessageFlags.Ephemeral })
			} else {
				await interaction.reply({ content: 'There was an error handling that button.', flags: MessageFlags.Ephemeral })
			}
		}
		return
	}

	if (!interaction.isChatInputCommand()) return

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
		} else {
			await interaction.reply({ content: 'There was an error while executing this command!', flags: MessageFlags.Ephemeral });
		}
	}
})

client.login(config.token)

// import express from "express"

// const app = express()
// const port = 3005

// app.get('/', (req, res) => {
// 	console.log('got a request!')
// 	const channel = client.channels.cache.get('1397331517033812048') as TextChannel
// 	if (!channel) return
// 	channel.send('balls')
// })

// app.listen(port, () => {
// 	console.log(`Example app listening on port ${port}`)
// })
