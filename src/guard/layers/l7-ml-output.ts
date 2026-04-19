// src/guard/layers/l7-ml-output.ts
import type { L7Result } from '../types.js'
import { GUARD_CONFIG } from '../config.js'
import { logger } from '../../logger.js'

const ML_TIMEOUT_MS = 10_000

export async function scanMLOutput(text: string, prompt: string): Promise<L7Result> {
  const url = `${GUARD_CONFIG.sidecarUrl}/scan/output`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS)

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, prompt }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      logger.warn({ status: response.status }, 'ML output sidecar returned non-OK status')
      return degradedResult()
    }

    const data = await response.json() as {
      toxicityScore: number
      refusalDetected: boolean
      isBlocked: boolean
      blocker: string | null
    }

    return {
      layer: 'l7-ml-output',
      toxicityScore: data.toxicityScore,
      refusalDetected: data.refusalDetected,
      isBlocked: data.isBlocked,
      blocker: data.blocker,
      degraded: false,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, 'ML output sidecar unreachable, degraded mode')
    return degradedResult()
  }
}

function degradedResult(): L7Result {
  return {
    layer: 'l7-ml-output',
    toxicityScore: 0,
    refusalDetected: false,
    isBlocked: false,
    blocker: null,
    degraded: true,
  }
}
