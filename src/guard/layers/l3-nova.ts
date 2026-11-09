// src/guard/layers/l3-nova.ts
import type { L3Result } from '../types.js'
import { GUARD_CONFIG } from '../config.js'
import { logger } from '../../logger.js'

export async function scanNova(text: string): Promise<L3Result> {
  const url = `${GUARD_CONFIG.sidecarUrl}/scan/nova`

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), GUARD_CONFIG.novaTimeoutMs)

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Nova sidecar returned non-OK status')
      return {
        layer: 'l3-nova',
        rulesTriggered: [],
        severity: 'none',
        timedOut: false,
        error: `HTTP ${response.status} ${response.statusText}`,
        degraded: true,
      }
    }

    const data = await response.json() as {
      rulesTriggered: string[]
      severity: 'none' | 'low' | 'high'
      timedOut: boolean
      error: string | null
    }

    return {
      layer: 'l3-nova',
      rulesTriggered: data.rulesTriggered,
      severity: data.severity,
      timedOut: data.timedOut,
      error: data.error,
      degraded: false,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn({ err: message }, 'Nova sidecar unreachable, running in degraded mode')
    return {
      layer: 'l3-nova',
      rulesTriggered: [],
      severity: 'none',
      timedOut: false,
      error: message,
      degraded: true,
    }
  }
}
