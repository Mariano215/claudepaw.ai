// src/guard/index.ts
import crypto from 'node:crypto'
import type {
  PreProcessResult,
  PostProcessResult,
  HardenedPrompt,
  RequestContext,
  LayerResult,
} from './types.js'
import { GUARD_CONFIG } from './config.js'
import { sanitize } from './layers/l1-sanitize.js'
import { scanRegex } from './layers/l2-regex.js'
import { scanNova } from './layers/l3-nova.js'
import { scanMLInput } from './layers/l4-ml-input.js'
import { hardenPrompt as hardenPromptL5 } from './layers/l5-canary.js'
import { validateOutput } from './layers/l6-output-validate.js'
import { scanMLOutput } from './layers/l7-ml-output.js'

export class GuardChain {
  /**
   * Pre-LLM pipeline: L1 sanitize -> L2 regex -> L3 nova -> L4 ML input.
   * Returns sanitized text or block decision.
   */
  async preProcess(message: string, chatId: string): Promise<PreProcessResult> {
    const startMs = Date.now()
    const requestId = crypto.randomUUID()
    const layerResults: LayerResult[] = []
    const triggeredLayers: string[] = []
    let blocked = false
    let flagged = false
    let blockReason: string | null = null

    // L1: Sanitize (pure TS, always runs, never blocks)
    const l1 = sanitize(message)
    layerResults.push(l1)
    const sanitizedText = l1.cleanedText

    // L2: Regex (pure TS, always runs)
    const l2 = scanRegex(sanitizedText)
    layerResults.push(l2)
    if (l2.isFlagged) {
      blocked = true
      flagged = true
      blockReason = l2.flagReason
      triggeredLayers.push('l2-regex')
    }

    // If already blocked by L2, skip expensive sidecar calls
    if (!blocked) {
      // L3: Nova (sidecar, graceful degradation)
      try {
        const l3 = await scanNova(sanitizedText)
        layerResults.push(l3)
        if (l3.severity === 'high') {
          blocked = true
          blockReason = `Nova rule scan: ${l3.rulesTriggered.join(', ')}`
          triggeredLayers.push('l3-nova')
        } else if (l3.severity === 'low') {
          flagged = true
          triggeredLayers.push('l3-nova')
        }
      } catch {
        // L3 failure is non-fatal
      }

      // L4: ML input (sidecar, graceful degradation)
      if (!blocked) {
        try {
          const l4 = await scanMLInput(sanitizedText)
          layerResults.push(l4)
          if (l4.isBlocked) {
            blocked = true
            blockReason = `ML input scanner: ${l4.blocker}`
            triggeredLayers.push('l4-ml-input')
          }
        } catch {
          // L4 failure is non-fatal
        }
      }
    }

    return {
      allowed: !blocked,
      sanitizedText,
      blocked,
      flagged,
      triggeredLayers,
      blockReason,
      layerResults,
      latencyMs: Date.now() - startMs,
      requestId,
    }
  }

  /**
   * Prompt hardening: inject canary + delimiters into system/user prompts.
   */
  hardenPrompt(systemPrompt: string, userMessage: string): HardenedPrompt {
    const result = hardenPromptL5(systemPrompt, userMessage)
    return {
      systemPrompt: result.systemPrompt,
      userMessage: result.userMessage,
      canary: result.canary,
      delimiterID: result.delimiterID,
    }
  }

  /**
   * Post-LLM pipeline: L6 output validation -> L7 ML output scan.
   * Returns validated response or block decision.
   */
  async postProcess(
    response: string,
    originalPrompt: string,
    ctx: RequestContext,
  ): Promise<PostProcessResult> {
    const startMs = Date.now()
    const layerResults: LayerResult[] = []
    const triggeredLayers: string[] = []
    let blocked = false
    let flagged = false
    let blockReason: string | null = null

    // L6: Output validation (pure TS, always runs)
    const l6 = validateOutput(response, {
      canary: ctx.canary,
    })
    layerResults.push(l6)
    if (l6.isBlocked) {
      blocked = true
      blockReason = l6.blockReason
      triggeredLayers.push('l6-output-validate')
    }

    // L7: ML output scan (sidecar, graceful degradation)
    if (!blocked) {
      try {
        const l7 = await scanMLOutput(response, originalPrompt)
        layerResults.push(l7)
        if (l7.isBlocked) {
          blocked = true
          blockReason = `ML output scanner: ${l7.blocker}`
          triggeredLayers.push('l7-ml-output')
        }
        if (l7.refusalDetected) {
          flagged = true
          triggeredLayers.push('l7-ml-output')
        }
      } catch {
        // L7 failure is non-fatal
      }
    }

    return {
      response: blocked ? GUARD_CONFIG.fallbackResponse : response,
      blocked,
      flagged,
      triggeredLayers,
      blockReason,
      layerResults,
      latencyMs: Date.now() - startMs,
      requestId: ctx.requestId,
    }
  }
}

// Singleton for use across the app
export const guardChain = new GuardChain()
