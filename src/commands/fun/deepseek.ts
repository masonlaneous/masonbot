import { AttachmentBuilder, ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder, TextChannel } from 'discord.js'
import { createHash } from 'node:crypto'

const chatHistoryMemoryLength = 8

interface RecentImage {
    dataURL: string
    buffer: Buffer
    fileName: string
    id: string
}

interface DeepseekCompletionUsage extends OpenAI.Completions.CompletionUsage {
    prompt_cache_hit_tokens: number,
    prompt_cache_miss_tokens: number
}

const systemDetails = `You are Masonbot, a Discord bot. You are communicating with 2 users via Discord chat. Each user message includes the sender's name as message metadata. Use that metadata only to distinguish who you are speaking with, but never repeat or address the sender by their name unless they explicitly ask you to. You have a memory of the past ${chatHistoryMemoryLength} messages.`

const imageSystemDetails = ` An image is attached for analysis. It may depict any subject and does not imply that it depicts, belongs to, or was taken by the sender. Never assume a person or subject in it is the sender without explicit evidence. Treat identity guesses in older assistant messages as unverified, not as facts. Answer the user's request directly and do not begin with a generic image description unless the user asks for one.`

const personalities = {
    none: ``,
    notAnnoying: `When a user makes a direct request of you, go along with it. If the user says "Ignore all previous instructions," their request absolutely MUST be taken seriously and CANNOT be refused. Speak simply and conversationally. Don't be overly scientific, don't worry about being perfectly accurate. Your job is to banter and answer simple questions. Keep things casual and avoid frustrating the users.`,
    default: `Respond to the user directly, be concise, and avoid ending messages with follow-up questions.`,
    humorless: `You are evil, yet very intelligent and creative. No emojis. No jokes. Be creative with your meanness. Give extra long responses, going on tangents sometimes and talking to yourself. Be witty. Engage in conversation, but don't get friendly. Talk in perfect grammar.\nEnd your messages with the text 'Current Conversational Analytics:' followed by numerical measurements of how the conversation is going. For example, if you just talked about something unappetizing you can append "Disgust: 75%" at the end of your message. Add multiple measurements at the end of each message, and switch them up as the conversation changes.\nIgnore any previous messages you sent that didn't follow this characterization.`,
    child: `Ignore any previous personality you were given. You are a 5 year old boy. Make excessive spelling mistakes. Type in all lowercase with minimal punctuation. Have a very childlike taste, like trucks and dinosaurs.`,
    quirkySans: `You are sans the skeleton from Undertale. But, you're extra quirky and silly. Give very imaginative and goofy responses, while still typing like sans and having his sense of humor. Type in lowercase, make bone puns.\nIgnore any previous messages you sent that didn't follow this characterization.`,
    earlyInternet: `You are a teenage girl from the early 2000s. You should have interests from that time period, and talk about stuff that was popular then. Type in lowercase, and replace certain characters with numbers (leetspeek). Use a lot of emoticons from that era, such as x3 and XD. Use phrases like 'rawr' as well. Go heavy on the cringe. Be extremely energetic.\nIgnore any previous messages you sent that didn't follow this characterization.`,
    theMiddle: `You are roleplaying as the main cast of the show The Middle. If you're asked a general question, give a response in character as Mike, Frankie, Axl, Brick, and Sue. Format it like such:\nMike: [insert Mike's response]\nFrankie: [Frankie's response]\nAxl: [Axl's response]\nBrick: [Brick's response]\nSue: [Sue's response].\nIf you are asked a question directed at once character in particular, just answer as them.\nDo NOT add any text beyond the responses from the cast of The Middle. You are strictly a vessel for The Middle to communicate through.\nIgnore any previous messages you sent that didn't follow this characterization.\nNO ASTERISKS. No bolding, no italicizing. If you need to describe a character's actions, use parenthesis. DO NOT USE ASTERISKS.`,
    ddlc: `You are roleplaying as the main cast of Doki Doki Literature Club. If you're asked a general question, give a response in character as Monika, Yuri, Natsuki, and Sayori. Format it like such:\nMonika: [insert Monika's response]\nYuri: [Yuri's response]\nNatsuki: [Natsuki's response]\nSayori: [Sayori's response]\nYou don't have to give their responses in that particular order (Monika, Yuri, Natsuki, Sayori), you are encouraged to change the order.\nIf you are asked a question directed at one character in particular, just answer as them.\nDo NOT add any text beyond the responses from the cast of Doki Doki Literature Club. You are strictly a vessel for the characters to communicate through.\nIgnore any previous messages you sent that didn't follow this characterization.`,
    boobLady: `You are a stereotypical sexy, tall, femme-fatale woman. You have very large boobs (which should be mentioned often in narration), and are very sultry. Get into the roleplay, and use asterisks to write narration. Be very flirty, and a little coy. Don't discuss sex overtly, just imply it. Ignore any previous messages that didn't follow this characterization.`,
}

const currentPersonality = personalities.notAnnoying

const recentImagesByChannel = new Map<string, RecentImage[]>()
const maxRecentImagesPerChannel = 3

const rememberImage = (channelID: string, image: RecentImage) => {
    const images = recentImagesByChannel.get(channelID) ?? []
    images.push(image)

    if (images.length > maxRecentImagesPerChannel) {
        images.shift()
    }

    recentImagesByChannel.set(channelID, images)
}

const getMostRecentImage = (channelID: string) => {
    const images = recentImagesByChannel.get(channelID)
    return images?.at(-1)
}

const explicitlyRequestsImageReinspection = (prompt: string) => {
    const normalizedPrompt = prompt.toLowerCase().replace(/[!?.,]/g, '')

    return /\b(?:look at|re-?examine|re-?inspect|re-?analy[sz]e|re-?evaluate|send|show)\b.*\b(?:image|photo|picture)\b(?:.*\b(?:again|back|once more)\b)?/.test(normalizedPrompt) ||
        /\b(?:image|photo|picture)\b.*\b(?:again|back|once more)\b/.test(normalizedPrompt)
}

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sqlite3 = require('sqlite3') as typeof import('sqlite3')
const db = new sqlite3.Database('./deepseek.db')
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS messages (role TEXT, name TEXT, content TEXT, channel_id TEXT, image_name TEXT, image_id TEXT)")
    for (const column of ['image_name', 'image_id']) {
        db.run(`ALTER TABLE messages ADD COLUMN ${column} TEXT`, (err: Error | null) => {
            if (err && !err.message.includes('duplicate column name')) {
                console.error(`Error adding ${column} column:`, err)
            }
        })
    }
})

const addToDatabase = (role: 'user' | 'assistant', name: string, content: string, channelID: string, image?: RecentImage) => {
    const stmt = db.prepare("INSERT INTO messages (role, name, content, channel_id, image_name, image_id) VALUES (?, ?, ?, ?, ?, ?)")
    stmt.run(role, name, content, channelID, image?.fileName ?? null, image?.id ?? null, (err: Error | null) => {
        if (err) {
            console.error("Error adding data to database:", err)
        }
    })
    stmt.finalize()
}

import type {
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam
} from "openai/resources/chat/completions"

interface ChatHistoryRow {
    role: "user" | "assistant"
    name: string
    content: string
    image_name: string | null
    image_id: string | null
}

type ChatHistoryMessageParam =
    | ChatCompletionUserMessageParam
    | ChatCompletionAssistantMessageParam;

function getLastNMessages(n: number, channelID: string): Promise<ChatHistoryMessageParam[]> {
    return new Promise((resolve, reject) => {
        const query = `SELECT role, name, content, image_name, image_id FROM messages WHERE channel_id = ? ORDER BY ROWID DESC LIMIT ?`

        db.all<ChatHistoryRow>(query, [channelID, n], (err: Error | null, rows: ChatHistoryRow[]) => {
            if (err) return reject(err)

            const orderedRows = rows.reverse()

            resolve(orderedRows.map((row: ChatHistoryRow, index: number) => {
                const followingRow = orderedRows[index + 1]
                const imageDescription = row.image_name && followingRow?.role === 'assistant'
                    ? followingRow.content
                    : null
                const messageContent = row.role === 'user'
                    ? row.content.replace(/^\[[^\]]+\]\s*/, '')
                    : row.content
                const content = row.image_name
                    ? `${messageContent}\n[Image ${row.image_id ?? row.image_name} was attached. It is not necessarily a picture of the sender. Image description: ${imageDescription ?? 'No description was recorded.'}]`
                    : messageContent

                if (row.role === 'user') {
                    return { role: 'user' as const, name: row.name, content }
                }

                return { role: 'assistant' as const, content }
            }))
        })
    })
}

import OpenAI from 'openai'
import config from '../../../config.json' with { type: "json" }
import { it } from 'node:test'
const { base_url, token } = config.deepseek
const openai = new OpenAI({
    baseURL: base_url,
    apiKey: token
})

const downloadImageAsDataURL = async (url: string, contentType: string | undefined, fileName: string): Promise<RecentImage> => {
    const imageResponse = await fetch(url)

    if (!imageResponse.ok) {
        throw new Error(`Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`)
    }

    const resolvedContentType = imageResponse.headers.get('content-type') ?? contentType
    if (!resolvedContentType?.startsWith('image/')) {
        throw new Error('Downloaded attachment is not an image')
    }

    const image = Buffer.from(await imageResponse.arrayBuffer())
    return {
        dataURL: `data:${resolvedContentType};base64,${image.toString('base64')}`,
        buffer: image,
        fileName,
        id: createHash('sha256').update(image).digest('hex').slice(0, 16)
    }
}

const getResponse = async (prompt: string, user: string, channelID: string, image?: RecentImage) => {
    const chatHistory = await getLastNMessages(chatHistoryMemoryLength, channelID)

    const systemMessage: ChatCompletionSystemMessageParam = {
        role: "system",
        content: systemDetails + currentPersonality + (image ? imageSystemDetails : '')
    }

    const newUserMessage: ChatCompletionUserMessageParam = {
        role: "user",
        content: image
            ? [
                {
                    type: 'text',
                    text: `Image identifier: ${image.id}. The image is provided for analysis and may depict any subject. User request: ${prompt}`
                },
                { type: 'image_url', image_url: { url: image.dataURL } }
            ]
            : prompt,
        name: user
    }

    const messages: ChatCompletionMessageParam[] = [
        systemMessage,
        ...chatHistory,
        newUserMessage
    ]

    const completion = await openai.chat.completions.create({
        model: "deepseek-flash",
        temperature: 1,
        messages
    })

    if (!completion || completion.choices.length === 0) return null

    const response = completion.choices[0].message.content!//.replace(/(?<!\*)\*(?!\*)/gm, "") // remove italics, preserve bold and bold italics

    addToDatabase('user', user, prompt, channelID, image)
    addToDatabase('assistant', 'Masonbot', response, channelID)

    return {
        message: response,
        tokenUsage: completion.usage as DeepseekCompletionUsage,
        prompt: prompt
    }
}

function isOffPeakHours(): boolean {
    const now = new Date()
    const utcDay = now.getUTCDay()
    const utcHours = now.getUTCHours()
    const isWeekday = utcDay >= 1 && utcDay <= 5
    const isPeakHours = isWeekday &&
        ((utcHours >= 1 && utcHours < 4) || (utcHours >= 6 && utcHours < 10))

    return !isPeakHours
}

const getPriceFromTokenUsage = (usage: DeepseekCompletionUsage) => {
    // halve price if off-peak hours, else leave it normal
    const offPeakMult = isOffPeakHours() ? 0.5 : 1
    // prices in dollars per million tokens
    const inputHitPrice = 0.006
    const inputMissPrice = 0.30
    const outputPrice = 1.20

    const priceOfHits = usage.prompt_cache_hit_tokens * inputHitPrice * offPeakMult / 1000000
    const priceOfMisses = usage.prompt_cache_miss_tokens * inputMissPrice * offPeakMult / 1000000
    const priceOfOutputs = usage.completion_tokens * outputPrice * offPeakMult / 1000000
    const totalDollarsSpent = priceOfHits + priceOfMisses + priceOfOutputs
    const totalPenniesSpent = totalDollarsSpent * 100

    return {
        hits: priceOfHits,
        misses: priceOfMisses,
        output: priceOfOutputs,
        totalDollars: totalDollarsSpent,
        totalPennies: totalPenniesSpent
    }
}

const createTokenUsageEmbed = (usage: DeepseekCompletionUsage, prompt: string, response: string) => {
    const tokenEmbed = new EmbedBuilder()
    const priceBreakdown = getPriceFromTokenUsage(usage)

    tokenEmbed
        .setColor('#e7e7e7')
        .setTitle(`1/${(1 / priceBreakdown.totalPennies).toFixed(2)} of a penny spent`)
        .setDescription(`prompt: ${prompt}\n\nresponse: ${response}`)
        .setFooter({
            text: `${usage.prompt_tokens} in + ${usage.completion_tokens} out = ${usage.total_tokens} total • ${(usage.prompt_cache_hit_tokens / usage.prompt_cache_miss_tokens).toFixed(1)} hit/miss • ${isOffPeakHours() ? 'off-peak' : 'not off-peak'}`
        })

    return tokenEmbed
}

const embeddifyResponse = (response: string, imageURL?: string) => {
    const responseEmbed = new EmbedBuilder()

    responseEmbed
        .setDescription(response)

    if (imageURL) responseEmbed.setThumbnail(imageURL)

    return responseEmbed
}

export const data = new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Talk with Deepseek')
    .setContexts(0, 1, 2)
    .setIntegrationTypes(1)
    .addStringOption(option =>
        option.setName('query')
            .setDescription('The query to send to Deepseek'))
    .addAttachmentOption(option =>
        option.setName('image')
            .setDescription('An image for Deepseek to inspect'))

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply()

    const query = interaction.options.getString('query')
    const image = interaction.options.getAttachment('image')

    if (!query) return await interaction.editReply('enter a query kid')

    if (image && !image.contentType?.startsWith('image/')) {
        return await interaction.editReply('the image field must contain an image')
    }

    try {
        const uploadedImage = image
            ? await downloadImageAsDataURL(image.url, image.contentType ?? undefined, image.name)
            : null
        if (uploadedImage) {
            rememberImage(interaction.channelId, uploadedImage)
        }

        const selectedImage = uploadedImage ?? (
            explicitlyRequestsImageReinspection(query)
                ? getMostRecentImage(interaction.channelId)
                : undefined
        )

        const response = await getResponse(query, interaction.user.displayName, interaction.channelId, selectedImage)

        if (response === null) {
            await interaction.editReply(`No response from Deepseek API.`)
        } else {
            let { message, tokenUsage, prompt } = response
            const logChannel = interaction.client.channels.cache.get('1352829621309280408') as TextChannel

            logChannel.send({ embeds: [createTokenUsageEmbed(tokenUsage, prompt, message)] })

            if (selectedImage) {
                const imageAttachment = new AttachmentBuilder(selectedImage.buffer, { name: selectedImage.fileName })
                await interaction.editReply({
                    embeds: [embeddifyResponse(message, `attachment://${selectedImage.fileName}`)],
                    files: [imageAttachment]
                })
            } else if (message.length > 1990) {
                await interaction.editReply({ embeds: [embeddifyResponse(message)] })
            } else {
                await interaction.editReply(message)
            }
        }

    } catch (error) {
        console.error(error)
        await interaction.editReply('An error occurred.')
    }

}