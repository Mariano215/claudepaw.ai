#!/usr/bin/env tsx
/**
 * Manual newsletter trigger
 * Usage: tsx scripts/trigger-newsletter.ts
 */

import { generateAndSendNewsletter, initNewsletter } from '../src/newsletter/index.js'
import { ALLOWED_CHAT_ID } from '../src/config.js'
import { logger } from '../src/logger.js'

async function main() {
  logger.info('Manually triggering newsletter generation...')

  // Initialize newsletter tables
  initNewsletter()

  // Simple send function that just logs
  const sendFn = async (chatId: string, text: string) => {
    logger.info({ chatId, text }, 'Newsletter notification')
    console.log(`\n${text}\n`)
  }

  try {
    const result = await generateAndSendNewsletter(ALLOWED_CHAT_ID, sendFn)
    logger.info({ result }, 'Newsletter generation complete')
    process.exit(0)
  } catch (err) {
    logger.error({ err }, 'Newsletter generation failed')
    process.exit(1)
  }
}

main()
