// src/guard/layers/l4-ml-input.ts
import type { L4Result } from '../types.js'
import { GUARD_CONFIG } from '../config.js'
import { logger } from '../../logger.js'

const ML_TIMEOUT_MS = 10_000 // 10s for ML inference

export async function scanMLInput(text: string): Promise<L4Result> {
  const url = `${GUARD_CONFIG.sidecarUrl}/scan/input`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ML_TIMEOUT_MS)

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      logger.warn({ status: response.status }, 'ML input sidecar returned non-OK status')
      return degradedResult(`HTTP ${response.status}`)
    }

    const data = await response.json() as {
      injectionScore: number
      toxicityScore: number
      invisibleTextDetected: boolean
      isBlocked: boolean
      blocker: string | null
    }

    return {
      layer: 'l4-ml-input',
      injectionScore: data.injectionScore,
      toxicityScore: data.toxicityScore,
      invisibleTextDetected: data.invisibleTextDetected,
      isBlocked: data.isBlocked,
      blocker: data.blocker,
      degraded: false,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, 'ML input sidecar unreachable, degraded mode')
    return degradedResult(message)
  }
}

function degradedResult(_error: string): L4Result {
  return {
    layer: 'l4-ml-input',
    injectionScore: 0,
    toxicityScore: 0,
    invisibleTextDetected: false,
    isBlocked: false,
    blocker: null,
    degraded: true,
  }
}
