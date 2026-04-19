#!/usr/bin/env node
import { initDatabase } from './db.js'
import { initTelemetryDatabase } from './telemetry-db.js'
import { initNewsletter, generateAndSendNewsletter } from './newsletter/index.js'
import { initCredentialStore } from './credentials.js'
import { logger } from './logger.js'

async function main() {
  const command = process.argv[2]

  if (!command || command === 'help') {
    console.log('Usage: newsletter-cli.ts <command>')
    console.log('')
    console.log('Commands:')
    console.log('  generate    Generate and send newsletter edition')
    console.log('  help        Show this help message')
    process.exit(0)
  }

  if (command !== 'generate') {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }

  // Initialize required systems
  const db = initDatabase()
  initTelemetryDatabase()
  initCredentialStore(db)
  initNewsletter()

  logger.info('Starting manual newsletter generation...')

  try {
    // Use a dummy chat ID for manual runs (won't send Telegram notification)
    const dummyChatId = 'manual-cli'
    const dummySendFn = async (_chatId: string, text: string) => {
      console.log(`[Newsletter result] ${text}`)
    }

    const result = await generateAndSendNewsletter(dummyChatId, dummySendFn)
    logger.info({ result }, 'Newsletter generation complete')
    console.log('\n✅ Newsletter generation complete')
    console.log(`Result: ${result}`)
  } catch (err) {
    logger.error({ err }, 'Newsletter generation failed')
    console.error('\n❌ Newsletter generation failed')
    console.error(err)
    process.exit(1)
  }
}

main()
