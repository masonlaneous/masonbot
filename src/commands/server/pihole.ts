import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const data = new SlashCommandBuilder()
  .setName('pihole')
  .setDescription('Manage Pi-hole')
  .addSubcommand(sub =>
    sub
      .setName('block')
      .setDescription('Start blocking distracting websites')
  )
  .addSubcommand(sub =>
    sub
      .setName('unblock')
      .setDescription('Stop blocking distracting websites')
  )
  .addSubcommand(sub =>
    sub
      .setName('temp')
      .setDescription('Temporarily stop blocking distracting websites for 5 minutes')
  )

const startBlocking = async () => {
  try {
    const { stdout, stderr } = await execFileAsync('/home/mason/pihole_group.sh', ['enable'], { timeout: 30_000 })
    console.log('pihole enable stdout:', stdout, 'stderr:', stderr)
    return true
  } catch (error) {
    console.error('startBlocking error:', error)
    return false
  }
}

const stopBlocking = async () => {
  try {
    const { stdout, stderr } = await execFileAsync('/home/mason/pihole_group.sh', ['disable'], { timeout: 30_000 })
    console.log('pihole disable stdout:', stdout, 'stderr:', stderr)
    return true
  } catch (error) {
    console.error('stopBlocking error:', error)
    return false
  }
}

export async function execute(interaction: ChatInputCommandInteraction) {
  // auth check before deferring, so we can return an ephemeral reply
  if (interaction.user.id !== '264590999479648268') {
    return interaction.reply({ content: 'piss off mate', ephemeral: true });
  }

  await interaction.deferReply()

  const sub = interaction.options.getSubcommand()

  if (sub === 'block') {
    const success = await startBlocking()
    if (success) {
      return interaction.editReply('Started blocking')
    } else {
      return interaction.editReply('Error enabling blocking')
    }
  } else if (sub === 'unblock') {
    const success = await stopBlocking()
    if (success) {
      return interaction.editReply('Stopped blocking')
    } else {
      return interaction.editReply('Error disabling blocking')
    }
  } else if (sub === 'temp') {
    const success = await stopBlocking()

    if (success) {
      await interaction.editReply('Stopped blocking for 5 minutes')
      setTimeout(() => {
        startBlocking().then(res => {
          if (!res) console.error('Failed to re-enable blocking after temp window')
          else console.log('Re-enabled blocking after temp window')
        })
      }, 300_000)
      return
    } else {
      return interaction.editReply('Error disabling blocking for temp')
    }
  }
}