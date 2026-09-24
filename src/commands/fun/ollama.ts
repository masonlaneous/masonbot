import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
  Message,
} from 'discord.js'
import axios from 'axios'

const API_URL = 'http://192.168.0.144:11434/api/generate'
const MODEL_NAME = 'gemma4:26b'

type ConversationEntry = { name: string, content: string }

type ActiveConversation = {
  topic: string
  history: ConversationEntry[]
  turn: number
  inFlight: boolean
  lastBotMessage: Message | null
  starter: ChatInputCommandInteraction
}

const aiConversations = new Map<string, ActiveConversation>()
const STREAM_EDIT_INTERVAL_MS = 1500

// function getSystemPrompt(aiName: "John" | "Jane", otherName: "John" | "Jane", topic: string, history: ConversationEntry[], prompterName: string) {
//   const log = history.slice(-20).map(m => `${m.name}: ${m.content}`).join('\n')
//   return (
//     `You are an AI named ${aiName}.\nYou are having an interaction with another AI named ${otherName}.\nA user named ${prompterName} has entered this as the prompt for the interaction: "${topic}". Engage with this prompt in whatever way is most appropriate for that particular prompt (roleplaying, conversation, acting out the prompt, etc).\nYou have been given the following personality: "${personalities[aiName]}". Always follow this personality.\n` +
//     `${log ? `Here is the conversation so far:\n` + log + '\n' : 'You get to respond first.'}` +
//     `Reply ONLY as ${aiName}, and do not write any lines for ${otherName}. Keep responses concise. Try to speak naturally, like a human would. Allow the conversation to progress naturally; don't let it stagnate too much.`
//   )
// }

// function getSystemPrompt(aiName: "John" | "Jane", otherName: "John" | "Jane", topic: string, history: ConversationEntry[], prompterName: string) {
//   const log = history.slice(-20).map(m => `${m.name}: ${m.content}`).join('\n')
//   console.log(log)
//   return (
//     `You are an person named ${aiName}.\n
//     You are having an interaction with another person named ${otherName}.\n
//     A user by the name of ${prompterName} has provided the following prompt to guide your conversation: "${topic}". Engage with this prompt in whatever way is most appropriate: roleplay, discuss, act it out, etc.\n
//     Reply ONLY as ${aiName}, and do not write any lines for ${otherName}. Keep responses very concise, no more than a few sentences.\n
//     Do NOT allow the conversation to stagnate. Always actively move the conversation forward, don't passively wait for it to progress.\n
//     During roleplay scenarios, actively progress the story; describe the scene and act out what's happening, don't simply say "Ready when you are". Additionally, during roleplays, ALWAYS use asterisks to describe the actions being taken. For example: *waves* Hi there!\n
//     ${log
//       ? `Here is the message history so far:\n${log}`
//       :`The conversation has just started, so you get to send the first message.`
//     }
//     `
//   )
// }

function getSystemPrompt(aiName: "John" | "Jane", otherName: "John" | "Jane", topic: string, history: ConversationEntry[], prompterName: string) {
  const log = history.slice(-20).map(m => `${m.name}: ${m.content}`).join('\n')
  console.log(log)
  return (
    `You are ${aiName} (${personalities[aiName]}).\n
    You are engaging in a fantasy campaign with your ${aiName === 'John' ? 'older sister' : 'younger brother'}, ${otherName} (${personalities[otherName]}).\n
    Your goal is to defeat the evil dragon Kyr, who lives on a mountain not far from your village. The roleplay starts with you both in your village, getting ready to explore out into the world and face the dragon.
    Keep responses concise. Speak realistically. When taking actions in the roleplay, use asterisks.
    Keep the roleplay always moving forward. Don't stagnate waiting for things to happen; be proactive, keep the story dynamic.
    ${log
      ? `Here is the message history so far:\n${log}`
      : `The conversation has just started, so you get to send the first message.`
    }
    `
  )
}


const personalities = {
  "John": "A swordsman who is charismatic, silly, and confident - sometimes overconfident. Gets into trouble.",
  "Jane": "An archer who is calm, calculated, and no-nonsense. Can be a bit bossyw, yet still kind and patient."
}

async function queryOllama(systemPrompt: string, onChunk?: (chunk: string) => Promise<void> | void): Promise<string> {
  const shouldStream = typeof onChunk === 'function'
  const response = await axios.post(API_URL, {
    model: MODEL_NAME,
    prompt: systemPrompt,
    stream: shouldStream,
  }, {
    responseType: shouldStream ? 'stream' : 'json',
  })

  if (!shouldStream) {
    return response.data.response
  }

  return new Promise((resolve, reject) => {
    const stream = response.data as NodeJS.ReadableStream
    let accumulator = ''
    let pending = ''
    let finished = false

    const flushPending = () => {
      if (!pending.trim()) {
        return
      }

      try {
        const parsed = JSON.parse(pending)
        const chunk = typeof parsed.response === 'string' ? parsed.response : ''
        if (chunk) {
          accumulator += chunk
          void Promise.resolve(onChunk!(chunk))
        }
        if (parsed.done) {
          finished = true
          resolve(accumulator)
        }
      } catch (error) {
        // Ignore incomplete JSON fragments while the stream is still writing.
      }
      pending = ''
    }

    stream.on('data', (chunk: Buffer | string) => {
      pending += chunk.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) {
          continue
        }

        try {
          const parsed = JSON.parse(line)
          const chunkText = typeof parsed.response === 'string' ? parsed.response : ''
          if (chunkText) {
            accumulator += chunkText
            void Promise.resolve(onChunk!(chunkText))
          }
          if (parsed.done) {
            finished = true
            resolve(accumulator)
            return
          }
        } catch (error) {
          // Partial or non-JSON line fragments are ignored until the stream closes.
        }
      }
    })

    stream.on('end', () => {
      if (!finished) {
        flushPending()
        resolve(accumulator)
      }
    })

    stream.on('error', (error) => {
      reject(error)
    })
  })
}

async function sendStreamingAIReply(channelId: string, aiName: string, systemPrompt: string, conversation: ActiveConversation) {
  const message = conversation.lastBotMessage
    ? await conversation.lastBotMessage.reply({ embeds: [createAIEmbed(aiName, '...')] })
    : await conversation.starter.followUp({ embeds: [createAIEmbed(aiName, '...')] })

  conversation.lastBotMessage = message

  let accumulated = ''
  let lastEditAt = 0
  let lastEditLength = 0

  const finalText = await queryOllama(systemPrompt, async (chunk) => {
    if (!aiConversations.has(channelId)) {
      return
    }

    accumulated += chunk
    const now = Date.now()
    const shouldUpdate =
      now - lastEditAt >= STREAM_EDIT_INTERVAL_MS ||
      accumulated.length - lastEditLength >= 200

    if (!shouldUpdate) {
      return
    }

    lastEditAt = now
    lastEditLength = accumulated.length

    try {
      await message.edit({ embeds: [createAIEmbed(aiName, accumulated)] })
    } catch (error) {
      console.error('Failed to edit streaming AI message:', error)
    }
  })

  if (aiConversations.has(channelId)) {
    try {
      await message.edit({ embeds: [createAIEmbed(aiName, finalText)] })
    } catch (error) {
      console.error('Failed to finalize streaming AI message:', error)
    }
  }

  return finalText
}

export const data = new SlashCommandBuilder()
  .setName('ollama')
  .setDescription('Chat with Ollama AI')
  .addSubcommand(sub =>
    sub
      .setName('chat')
      .setDescription('Send a prompt to Ollama')
      .addStringOption(opt =>
        opt.setName('prompt').setDescription('Your message').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('start')
      .setDescription('Start AI vs AI conversation')
      .addStringOption(opt =>
        opt.setName('prompt').setDescription('Starting prompt for the AI conversation').setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('stop').setDescription('Stop AI vs AI conversation')
  )

function createAIEmbed(aiName: string, content: string) {
  const color = aiName === 'John' ? 0xff3c3c : 0x3c6cff
  return new EmbedBuilder()
    .setTitle(aiName)
    .setDescription(content)
    .setColor(color)
}

async function continueConversation(channelId: string) {
  const conversation = aiConversations.get(channelId)
  if (!conversation) {
    return
  }

  await runAITurn(channelId)

  if (aiConversations.has(channelId)) {
    await continueConversation(channelId)
  }
}

async function runAITurn(channelId: string) {
  const conversation = aiConversations.get(channelId)
  if (!conversation || conversation.inFlight) {
    return
  }

  conversation.inFlight = true

  try {
    const { history, turn, topic, starter } = conversation
    const aiName = turn % 2 === 0 ? 'John' : 'Jane'
    const otherName = turn % 2 === 0 ? 'Jane' : 'John'
    const systemPrompt = getSystemPrompt(aiName, otherName, topic, history, starter.user.displayName)

    const response = await sendStreamingAIReply(channelId, aiName, systemPrompt, conversation)
    const trimmedResponse = response.trim()

    if (!aiConversations.has(channelId)) {
      return
    }

    history.push({ name: aiName, content: trimmedResponse })
    if (history.length > 20) history.splice(0, history.length - 20)

    conversation.turn += 1
  } catch (error) {
    console.error(error)
    stopConversation(channelId)
  } finally {
    conversation.inFlight = false
  }
}

function stopConversation(channelId: string) {
  aiConversations.delete(channelId)
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand()

  if (subcommand === 'chat') {
    await interaction.deferReply()
    const prompt = interaction.options.getString('prompt', true)
    try {
      const response = await queryOllama(prompt)
      await interaction.editReply(response)
    } catch (err) {
      console.error(err)
      await interaction.editReply('An error occurred.')
    }
    return
  }

  if (subcommand === 'start') {
    const channelId = interaction.channelId
    if (aiConversations.has(channelId)) {
      await interaction.reply({ content: 'AI conversation already running in this channel.', ephemeral: true })
      return
    }

    const topic = interaction.options.getString('prompt', true)
    await interaction.reply(`Starting AI vs AI conversation on: "${topic}"`)

    const conversation: ActiveConversation = {
      topic,
      history: [],
      turn: 0,
      inFlight: false,
      lastBotMessage: null,
      starter: interaction,
    }

    aiConversations.set(channelId, conversation)

    await runAITurn(channelId)
    if (aiConversations.has(channelId)) {
      await continueConversation(channelId)
    }
    return
  }

  if (subcommand === 'stop') {
    const channelId = interaction.channelId
    if (!aiConversations.has(channelId)) {
      await interaction.reply({ content: 'No AI conversation is running in this channel.', ephemeral: true })
      return
    }

    stopConversation(channelId)
    await interaction.reply('AI conversation stopped.')
    return
  }
}