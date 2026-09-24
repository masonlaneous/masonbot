import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  ComponentType,
  EmbedBuilder,
  SlashCommandBuilder
} from 'discord.js'
import { ChatCompletionMessageParam, ChatCompletionSystemMessageParam } from 'openai/resources.mjs'
import OpenAI from 'openai'
import config from '../../../config.json' with { type: 'json' }

const { base_url, token } = config.deepseek
const openai = new OpenAI({ baseURL: base_url, apiKey: token })

const optionsRegex = /\[OPTION\s*\d+:\s*(.*?)\]/g
const storyRegex = /^(.*?)\[OPTION/ms

const adventures: {
  user: string
  channel: string
  history: ChatCompletionMessageParam[]
  optionMap: Record<string, string>
  isLocked?: boolean
  lastInteraction: number
}[] = []

const getResponse = async (history: ChatCompletionMessageParam[]) => {
  console.log(history)
  const completion = await openai.chat.completions.create({
    model: 'deepseek-chat',
    temperature: 1.5,
    messages: history
  })
  if (!completion || completion.choices.length === 0) return null
  return completion.choices[0].message.content
}

const createSystemPrompt = (startingPrompt?: string): string => {
  return `You are hosting a text-based adventure${startingPrompt ? ` based on the starting prompt: "${startingPrompt}"` : ''}. Describe situations and offer 2-3 choices for what the user can do next.

  Rules:
  - The description of the situation should always be at least 1 paragraph long.
  - Always end your responses with 2-3 options in this exact format (one per line):
    [OPTION 1: Description of the first action]
    [OPTION 2: Description of the second action]
  - Never deviate from the [OPTION 1: Description] format for options. Absolutely no asterisks are allowed in the list of options - no bold, no italics. An option should never exceed 70 characters. If you want to give more context to an option, do it in the main description, not the option text.
  - Avoid cliche stories. Adventures should not be boring and predictable.
  - Give the user fun and enticing options. Being able to do interesting stuff is what makes the adventure fun for the user.

  Example:
  You find yourself at a clearing. In the distance, there's a wizard tower. To your right, there's a dark forest.

  [OPTION 1: Start walking to the wizard tower]
  [OPTION 2: Head into the forest]`.trim()
}

const startAdventure = async (startingPrompt: string | null, user: string, channel: string | undefined): Promise<string> => {
  const systemPrompt = createSystemPrompt()

  const initialSystemMessage: ChatCompletionSystemMessageParam = {
    role: 'system',
    content: `${systemPrompt}\nThis is the beginning of a new adventure. Introduce the user to this new scenario. Be imaginative and descriptive.${startingPrompt ? ` The user has supplied this prompt: \"${startingPrompt}\".` : ''}`
  }

  const response = await getResponse([initialSystemMessage])
  if (!response) throw 'No response from AI.'

  const optionMatches = [...response.matchAll(optionsRegex)]
  const optionMap = Object.fromEntries(optionMatches.map((m, i) => [`opt_${i + 1}`, m[1]]))

  adventures.push({
    user,
    channel: channel || 'unknown',
    history: [
      { role: 'system', content: startingPrompt ? createSystemPrompt(startingPrompt) : systemPrompt },
      { role: 'assistant', content: response }
    ],
    optionMap,
    lastInteraction: Date.now()
  })

  return response
}

const createEmbed = (text: string) => new EmbedBuilder().setColor('#e7e7e7').setDescription(text)

const createActionRow = (
  optionMap: Record<string, string>,
  disabled = false,
  clickedId?: string
) => {
  const row = new ActionRowBuilder<ButtonBuilder>()
  for (const [id, label] of Object.entries(optionMap).slice(0, 5)) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(id)
        .setLabel(label.slice(0, 80))
        .setStyle(id === clickedId ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(disabled)
    )
  }
  return row
}


async function respondToInteraction(interaction: ChatInputCommandInteraction | ButtonInteraction) {
  const userId = interaction.user.id
  const channelId = interaction.channelId

  let adventure = adventures.find(adv => adv.user === userId && adv.channel === channelId)

  if (interaction instanceof ChatInputCommandInteraction) {
    const prompt = interaction.options.getString('prompt')
    try {
      const response = await startAdventure(prompt, userId, channelId)
      const storyText = response.match(storyRegex)?.[1]?.trim() || 'Error parsing story.'
      adventure = adventures.find(adv => adv.user === userId && adv.channel === channelId)!
      await interaction.editReply({
        embeds: [createEmbed(storyText)],
        components: [createActionRow(adventure.optionMap)]
      })
      await listenForButton(interaction)
    } catch (err) {
      console.error(err)
      await interaction.editReply('An error occurred.')
    }
    return
  }

  if (interaction instanceof ButtonInteraction) {
    try {
      if (!adventure) {
        await interaction.deferUpdate()
        await interaction.message.edit({ components: [] })
        await interaction.followUp({ content: "That adventure doesn't exist!", ephemeral: true })
        return
      }

      if (adventure.user !== userId) {
        await interaction.deferUpdate()
        await interaction.followUp({ content: "This isn't your adventure!", ephemeral: true })
        return
      }

      if (adventure.isLocked) return

      const userChoice = adventure.optionMap[interaction.customId]
      if (!userChoice) return

      adventure.isLocked = true
      await interaction.deferUpdate()

      await interaction.message.edit({
        components: [createActionRow(adventure.optionMap, true, interaction.customId)]
      })


      adventure.history.push({ role: 'user', content: userChoice })

      // only pass the last 8 messages to the AI, to avoid it getting out of hand
      const aiResponse = await getResponse(adventure.history.slice(-8))
      if (!aiResponse) {
        await interaction.followUp('AI did not respond. Try again.')
        return
      }

      const storyText = aiResponse.match(storyRegex)?.[1]?.trim() || 'Error parsing story.'
      const optionMatches = [...aiResponse.matchAll(optionsRegex)]
      const newOptionMap = Object.fromEntries(optionMatches.map((m, i) => [`opt_${i + 1}`, m[1]]))

      adventure.history.push({ role: 'assistant', content: aiResponse })
      adventure.optionMap = newOptionMap
      adventure.lastInteraction = Date.now()
      adventure.isLocked = false

      const msg = await interaction.followUp({
        embeds: [createEmbed(storyText)],
        components: [createActionRow(adventure.optionMap)]
      })

      await listenForButton(msg)
    } catch (err) {
      console.error('Button interaction error:', err)
      try {
        await interaction.reply({ content: 'An error occurred handling this choice.', ephemeral: true })
      } catch (_) { }
    }
  }
}

async function listenForButton(interactionOrMessage: ChatInputCommandInteraction | ButtonInteraction | any) {
  try {
    const message = interactionOrMessage instanceof ButtonInteraction || interactionOrMessage instanceof ChatInputCommandInteraction
      ? await interactionOrMessage.fetchReply()
      : interactionOrMessage

    const buttonInteraction = await message.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 120000
    })

    if (buttonInteraction) await respondToInteraction(buttonInteraction)
  } catch (_) { }
}

export const data = new SlashCommandBuilder()
  .setName('adventure')
  .setDescription('Go on a text-based adventure with Deepseek')
  .addSubcommand(sub =>
    sub
      .setName('start')
      .setDescription('Start a new adventure')
      .addStringOption(opt =>
        opt.setName('prompt').setDescription('A custom starting prompt for your adventure')
      )
  )
  .addSubcommand(sub =>
    sub.setName('stop').setDescription('Stop your ongoing adventure')
  )

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply()
  const sub = interaction.options.getSubcommand()

  if (sub === 'start') {
    await respondToInteraction(interaction)
  } else if (sub === 'stop') {
    const idx = adventures.findIndex(adv => adv.user === interaction.user.id && adv.channel === interaction.channelId)
    if (idx !== -1) {
      adventures.splice(idx, 1)
      await interaction.editReply('Your adventure has been stopped.')
    } else {
      await interaction.editReply('No ongoing adventure found.')
    }
  }
}
