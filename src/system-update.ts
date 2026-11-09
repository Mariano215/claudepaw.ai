import { spawn } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync, openSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { logger } from './logger.js'

export interface UpgradeResult {
  behind: number
  upgraded: boolean
}

const GITHUB_REPO = 'YourGitHubUser/claudepaw.ai'

export async function getCommitsBehind(gitHash: string): Promise<number> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/compare/main...${gitHash}`,
      { headers: { 'User-Agent': 'ClaudePaw-Bot' } }
    )
    if (!res.ok) return 0
    const data = await res.json() as { behind_by?: number }
    return data.behind_by ?? 0
  } catch {
    return 0
  }
}

function spawnUpgradeScript(): void {
  const projectRoot = process.cwd()
  const upgradePath = join(projectRoot, 'scripts', 'upgrade.sh')

  if (!existsSync(upgradePath)) {
    logger.error('upgrade.sh not found, skipping auto-upgrade')
    return
  }

  const scriptHash = createHash('sha256').update(readFileSync(upgradePath)).digest('hex')
  logger.info({ scriptHash }, 'Auto-upgrade: executing upgrade.sh')

  const logsDir = join(projectRoot, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const logFd = openSync(join(logsDir, 'upgrade.log'), 'a')
  const child = spawn('bash', [upgradePath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: projectRoot,
  })
  child.unref()
}

export async function checkAndUpgrade(
  gitHash: string,
  runUpgrade: () => void = spawnUpgradeScript
): Promise<UpgradeResult> {
  if (process.env.DISABLE_AUTO_UPGRADE === 'true') {
    logger.info('Auto-upgrade disabled via DISABLE_AUTO_UPGRADE env var')
    return { behind: 0, upgraded: false }
  }

  try {
    const behind = await getCommitsBehind(gitHash)
    if (behind > 0) {
      logger.info({ behind }, 'Auto-upgrade: behind main, running upgrade script')
      runUpgrade()
      return { behind, upgraded: true }
    }
    return { behind: 0, upgraded: false }
  } catch (err) {
    logger.error({ err }, 'checkAndUpgrade failed')
    return { behind: 0, upgraded: false }
  }
}
