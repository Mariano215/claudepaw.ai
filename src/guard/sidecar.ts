// src/guard/sidecar.ts
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { logger } from '../logger.js'
import { GUARD_CONFIG } from './config.js'
import { PROJECT_ROOT } from '../config.js'

let sidecarProcess: ChildProcess | null = null
let restartCount = 0
const MAX_RESTARTS = 5
const RESTART_DELAY_MS = 3000

export async function startSidecar(): Promise<boolean> {
  const sidecarDir = path.join(PROJECT_ROOT, 'guard-sidecar')
  const startScript = path.join(sidecarDir, 'start.sh')

  logger.info({ dir: sidecarDir }, 'Starting guard sidecar...')

  return new Promise((resolve) => {
    sidecarProcess = spawn('bash', [startScript], {
      cwd: sidecarDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    sidecarProcess.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) logger.debug({ source: 'sidecar' }, line)
    })

    sidecarProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim()
      if (line) logger.warn({ source: 'sidecar' }, line)
    })

    sidecarProcess.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'Guard sidecar exited')
      sidecarProcess = null

      if (restartCount < MAX_RESTARTS) {
        restartCount++
        logger.info({ attempt: restartCount }, 'Restarting sidecar...')
        setTimeout(() => { startSidecar() }, RESTART_DELAY_MS)
      } else {
        logger.error('Guard sidecar exceeded max restarts, running without ML layers')
      }
    })

    // Wait for health check
    waitForHealth(30_000).then((healthy) => {
      if (healthy) {
        restartCount = 0
        logger.info('Guard sidecar is healthy and ready')
      } else {
        logger.warn('Guard sidecar did not become healthy in time, continuing without ML layers')
      }
      resolve(healthy)
    })
  })
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const url = `${GUARD_CONFIG.sidecarUrl}/health`
  const deadline = Date.now() + timeoutMs
  const pollInterval = 2000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        const data = await response.json() as { status: string; ml_models_loaded: boolean }
        if (data.status === 'ready' && data.ml_models_loaded) {
          return true
        }
      }
    } catch {
      // Sidecar not ready yet
    }
    await new Promise((r) => setTimeout(r, pollInterval))
  }

  return false
}

export function stopSidecar(): void {
  if (sidecarProcess) {
    logger.info('Stopping guard sidecar...')
    sidecarProcess.kill('SIGTERM')
    sidecarProcess = null
  }
}

export function isSidecarRunning(): boolean {
  return sidecarProcess !== null && !sidecarProcess.killed
}
