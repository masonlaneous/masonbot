import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder
} from 'discord.js'

type PigPlayer = { id: string, name: string, tempScore: number, score: number }

const rollButtonId = 'pig:roll'
const stopButtonId = 'pig:stop'
const forfeitButtonId = 'pig:forfeit'
const joinButtonId = 'pig:join'

function rollDie(sides = 6) {
  return Math.floor(Math.random() * sides) + 1
}

export class PigGame {
  public readonly channelId: string
  public readonly player1: PigPlayer
  public player2: PigPlayer | null
  public currentPlayer: PigPlayer

  constructor(channelId: string, player1Id: string, player1Name: string, player2Id?: string, player2Name?: string) {
    this.channelId = channelId
    this.player1 = {
      id: player1Id,
      name: player1Name,
      tempScore: 0,
      score: 0
    }
    this.player2 = player2Id && player2Name
      ? { id: player2Id, name: player2Name, tempScore: 0, score: 0 }
      : null
    this.currentPlayer = this.player1
  }

  public nextPlayersTurn() {
    if (!this.player2) throw new Error('The second player has not joined yet.')
    this.currentPlayer = this.currentPlayer === this.player1 ? this.player2 : this.player1
  }

  public join(playerId: string, playerName: string) {
    if (this.player2) throw new Error('This game already has two players.')
    if (playerId === this.player1.id) throw new Error('The game creator is already player one.')

    this.player2 = { id: playerId, name: playerName, tempScore: 0, score: 0 }
  }

  public getScoreboard() {
    const player2Score = this.player2 ? `${this.player2.name}'s score: ${this.player2.score}` : 'Waiting for player two to join'
    return `\`\`\`${this.player1.name}'s score: ${this.player1.score}\n${player2Score}\`\`\``
  }

  public getResponseEmbed(content: string) {
    return new EmbedBuilder()
      .setTitle(`${this.currentPlayer.name}'s turn`)
      .setColor('#e7e7e7')
      .setDescription(content + '\n' + this.getScoreboard())
    // .setFields([{
    //   name: `${this.player1.name}'s score:`,
    //   value: `${this.player1.score}`,
    //   inline: true
    // }, {
    //   name: `${this.player2.name}'s score:`,
    //   value: `${this.player2.score}`,
    //   inline: true
    // }])
  }

  public roll() {
    if (!this.player2) throw new Error('Waiting for player two to join.')
    const number = rollDie()

    if (number === 1) {
      this.currentPlayer.tempScore = 0
      this.nextPlayersTurn()
    } else {
      this.currentPlayer.tempScore += number
    }

    return number
  }

  public stop() {
    if (!this.player2) throw new Error('Waiting for player two to join.')
    const player = this.currentPlayer
    const tempScore = player.tempScore

    player.score += tempScore
    player.tempScore = 0
    this.nextPlayersTurn()

    return {
      playerName: player.name,
      pointsAdded: tempScore,
      newScore: player.score
    }
  }

  public forfeit() {

  }
}

const ongoingGames = new Map<string, PigGame>()

async function getOtherPlayer(interaction: ChatInputCommandInteraction): Promise<[string, string] | null> {
  const authorizedUserId = interaction.authorizingIntegrationOwners.userId
  if (authorizedUserId && authorizedUserId !== interaction.user.id) {
    const player2 = await interaction.client.users.fetch(authorizedUserId)
    return [player2.id, player2.displayName]
  }

  if (interaction.context === InteractionContextType.BotDM) {
    return [interaction.client.user.id, interaction.client.user.displayName]
  }

  return null
}

async function createGame(interaction: ChatInputCommandInteraction) {
  if (ongoingGames.has(interaction.channelId)) return null

  const player2Info = await getOtherPlayer(interaction)

  const game = player2Info
    ? new PigGame(interaction.channelId, interaction.user.id, interaction.user.displayName, ...player2Info)
    : new PigGame(interaction.channelId, interaction.user.id, interaction.user.displayName)
  ongoingGames.set(game.channelId, game)
  return game
}

function getGame(channelId: string) {
  return ongoingGames.get(channelId)
}

function removeGame(game: PigGame) {
  ongoingGames.delete(game.channelId)
}

function createActionRow(game: PigGame, disabled = false) {
  const row = new ActionRowBuilder<ButtonBuilder>()

  if (!game.player2) {
    return row.addComponents(
      new ButtonBuilder()
        .setCustomId(joinButtonId)
        .setLabel('Join game')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(forfeitButtonId)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
    )
  }

  return row.addComponents(
    new ButtonBuilder()
      .setCustomId(rollButtonId)
      .setLabel('Roll')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(stopButtonId)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(forfeitButtonId)
      .setLabel('Forfeit')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  )
}

export const data = new SlashCommandBuilder()
  .setName('pig')
  .setDescription('Play the game Pig in this DM')

export async function execute(interaction: ChatInputCommandInteraction) {
  if (ongoingGames.has(interaction.channelId)) {
    await interaction.reply({
      content: 'A Pig game is already running in this DM.',
      ephemeral: true
    })
    return
  }

  const game = await createGame(interaction)
  if (!game) return

  await interaction.reply({
    components: [createActionRow(game)],
    embeds: [game.getResponseEmbed(`\`\`\`Welcome to Pig! The rules are simple:\n\n- Roll a die, and whatever number you get is added to your ongoing score.\n- You can stop at any time, and your ongoing score gets added to your permanent score!\n- But don't be too greedy, because if you roll a 1, you lose ALL your ongoing score, and your opponent gets to take their turn!\`\`\``)]
  })
}

export async function handleButton(interaction: ButtonInteraction) {
  const game = getGame(interaction.channelId)
  if (!game) {
    await interaction.reply({ content: 'This game is no longer active.', ephemeral: true })
    return
  }

  try {
    if (interaction.customId === joinButtonId) {
      if (game.player2) {
        await interaction.reply({ content: 'This game already has two players.', ephemeral: true })
        return
      }

      game.join(interaction.user.id, interaction.user.displayName)
      await interaction.update({
        components: [createActionRow(game)],
        embeds: [game.getResponseEmbed(`${interaction.user.displayName} joined the game. It is now ${game.currentPlayer.name}'s turn.`)]
      })
      return
    }

    if (interaction.customId === forfeitButtonId) {
      removeGame(game)
      await interaction.update({ content: 'Game canceled.', components: [] })
      return
    }

    if (!game.player2) {
      await interaction.reply({ content: 'Waiting for player two to join.', ephemeral: true })
      return
    }

    if (interaction.user.id !== game.player1.id && interaction.user.id !== game.player2.id) {
      await interaction.reply({ content: 'You are not a player in this game.', ephemeral: true })
      return
    }

    if (interaction.user.id !== game.currentPlayer.id) {
      await interaction.reply({ content: 'Wait your damn turn!', ephemeral: true })
      return
    }

    if (interaction.customId === rollButtonId) {
      const roll = game.roll()

      const content = (roll !== 1)
        ? `# You're at ${game.currentPlayer.tempScore}.\nYou rolled a ${roll}. ${game.currentPlayer.tempScore >= 20 ? 'Do you DARE keep going?' : 'Roll again?'}`
        : `# You rolled a ${roll}... sucks to be you!\nIt is now ${game.currentPlayer.name}'s turn.`

      await interaction.update({
        embeds: [game.getResponseEmbed(content)]
      })
    } else if (interaction.customId === stopButtonId) {
      const result = game.stop()

      await interaction.update({
        embeds: [game.getResponseEmbed(`${result.playerName} stopped rolling. **${result.pointsAdded}** was added to their score.\nIt is now ${game.currentPlayer.name}'s turn.`)]
      })
    }
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : 'That move could not be made.',
      ephemeral: true
    })
  }
}
