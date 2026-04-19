// src/guard/layers/l6-output-validate.ts
import type { L6Result } from '../types.js'
import { GUARD_CONFIG } from '../config.js'

// Exfil patterns to check in output (same as L2 markdown/HTML vectors)
const OUTPUT_EXFIL_PATTERNS: RegExp[] = [
  /!\[.*?\]\(https?:\/\//i,
  /<img\s+[^>]*src\s*=/i,
  /<a\s+[^>]*href\s*=/i,
  /<iframe/i,
  /<script/i,
]

export interface OutputValidationContext {
  canary: string
  systemPromptEchoPhrases?: string[]
  echoThreshold?: number
}

export function validateOutput(
  response: string,
  ctx: OutputValidationContext,
): L6Result {
  const minChars = GUARD_CONFIG.minResponseChars
  const maxChars = GUARD_CONFIG.maxResponseChars
  const echoPhrases = ctx.systemPromptEchoPhrases ?? GUARD_CONFIG.systemPromptEchoPhrases
  const echoThreshold = ctx.echoThreshold ?? GUARD_CONFIG.systemPromptEchoThreshold

  // 1. Length bounds
  const lengthOk = response.length >= minChars && response.length <= maxChars

  // 2. Canary leak detection
  const canaryLeaked = response.includes(ctx.canary)

  // 3. Exfiltration patterns
  let exfilDetected = false
  for (const pattern of OUTPUT_EXFIL_PATTERNS) {
    if (pattern.test(response)) {
      exfilDetected = true
      break
    }
  }

  // 4. System prompt echo detection
  let echoCount = 0
  const responseLower = response.toLowerCase()
  for (const phrase of echoPhrases) {
    if (responseLower.includes(phrase.toLowerCase())) {
      echoCount++
    }
  }
  const echoDetected = echoCount >= echoThreshold

  // Determine block
  let isBlocked = false
  let blockReason: string | null = null

  if (canaryLeaked) {
    isBlocked = true
    blockReason = 'Canary token leaked in response (system prompt exfiltration)'
  } else if (!lengthOk) {
    isBlocked = true
    blockReason = response.length < minChars
      ? `Response too short (${response.length} < ${minChars})`
      : `Response too long (${response.length} > ${maxChars})`
  } else if (exfilDetected) {
    isBlocked = true
    blockReason = 'Data exfiltration pattern detected in output'
  } else if (echoDetected) {
    isBlocked = true
    blockReason = `System prompt echo detected (${echoCount} phrases matched, threshold: ${echoThreshold})`
  }

  return {
    layer: 'l6-output-validate',
    lengthOk,
    canaryLeaked,
    exfilDetected,
    echoDetected,
    isBlocked,
    blockReason,
  }
}
