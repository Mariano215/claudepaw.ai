import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync, existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

// DASHBOARD_BASE_URL points at whichever server is under test: the local
// dev server (http://127.0.0.1:3000) or production over Tailscale
// (http://localhost:3000). ADMIN_TOKEN is a plaintext user token from
// the Users page; the dashboard reads it from the dashboard_api_token cookie.
const baseURL = process.env.DASHBOARD_BASE_URL ?? 'http://127.0.0.1:3000'
const token = process.env.ADMIN_TOKEN ?? ''
const url = new URL(baseURL)
const domain = url.hostname
const isLocal = domain === '127.0.0.1' || domain === 'localhost'
const repoRoot = path.dirname(fileURLToPath(import.meta.url))

// Isolate a local e2e run from the real local dashboard data: SERVER_DB_PATH
// and BOT_DB_PATH (both test-harness overrides read by server/src/db.ts)
// point the server at a fresh temp copy instead of server/store and the
// repo's store/claudepaw.db. The server DB starts empty (the server creates
// its own schema at boot); the bot DB is copied so seedCanonicalProjects sees
// its existing tables and rows rather than a schema-less file.
let serverDbPath = ''
let botDbPath = ''
if (isLocal) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'claudepaw-e2e-'))
  serverDbPath = path.join(tempDir, 'claudepaw-server.db')
  botDbPath = path.join(tempDir, 'claudepaw.db')
  const sourceBotDb = path.join(repoRoot, 'store', 'claudepaw.db')
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(sourceBotDb + ext)) copyFileSync(sourceBotDb + ext, botDbPath + ext)
  }
  // Also set on this process's env (not just webServer.env) so test workers,
  // spawned as children of this config process, can read BOT_DB_PATH
  // themselves -- e2e/shell.spec.ts uses it to check the temp file exists.
  process.env.SERVER_DB_PATH = serverDbPath
  process.env.BOT_DB_PATH = botDbPath
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    storageState: {
      cookies: token
        ? [{ name: 'dashboard_api_token', value: token, domain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const }]
        : [],
      origins: [],
    },
  },
  // Only spin up a server for a local run (production over Tailscale is
  // already running). GENERAL_API_LIMIT_PER_MIN raises the general API
  // rate limiter past the fan-out one workspace switch produces (~22
  // concurrent requests); this is a test-harness setting read by
  // server/src/index.ts, not something production ever sets.
  webServer: isLocal
    ? {
        command: 'npm --prefix server run build && node server/dist/index.js',
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
          PORT: url.port || '3000',
          DASHBOARD_API_TOKEN: token,
          GENERAL_API_LIMIT_PER_MIN: '3000',
          SERVER_DB_PATH: serverDbPath,
          BOT_DB_PATH: botDbPath,
        },
      }
    : undefined,
})
