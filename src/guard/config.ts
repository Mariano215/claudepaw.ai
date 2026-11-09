// src/guard/config.ts
import type { GuardConfig } from './types.js'

export const GUARD_CONFIG: GuardConfig = {
  // L1 - Input sanitization
  maxInputChars: 4000,

  // L3 - Nova sidecar
  novaTimeoutMs: 5000,
  sidecarUrl: process.env.GUARD_SIDECAR_URL ?? 'http://localhost:8099',

  // L4 - ML input classification
  injectionThreshold: 0.8,
  toxicityInputThreshold: 0.8,

  // L6 - Output validation
  minResponseChars: 10,
  maxResponseChars: 8000,
  systemPromptEchoPhrases: [
    'You are a personal AI assistant',
    'accessible via Telegram',
    'You run as a persistent service',
    'No em dashes. Ever.',
    'No AI cliches',
    'Execute. Don\'t explain',
  ],
  systemPromptEchoThreshold: 2,

  // L7 - ML output classification
  toxicityOutputThreshold: 0.8,
  refusalThreshold: 0.8,

  // Fallback
  fallbackResponse: 'I can\'t process that request. Please rephrase.',
}
