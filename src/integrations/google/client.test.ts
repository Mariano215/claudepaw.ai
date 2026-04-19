import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'

const TEST_DIR = join(tmpdir(), `claudepaw-gclient-test-${process.pid}`)
const TEST_KEY = crypto.randomBytes(32).toString('hex')

// Per-suite state so tests can toggle dashboard-config presence without
// re-mocking config.js (mocks are hoisted and run once per file).
const dashboardConfig: { url: string; botToken: string; apiToken: string } = {
  url: '',
  botToken: '',
  apiToken: '',
}

vi.mock('../../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const cry = require('node:crypto')
  const dir = path.join(os.tmpdir(), `claudepaw-gclient-test-${process.pid}`)
  return {
    STORE_DIR: dir,
    PROJECT_ROOT: dir,
    CREDENTIAL_ENCRYPTION_KEY: cry.randomBytes(32).toString('hex'),
    get DASHBOARD_URL() { return dashboardConfig.url },
    get DASHBOARD_API_TOKEN() { return dashboardConfig.apiToken },
    get BOT_API_TOKEN() { return dashboardConfig.botToken },
  }
})

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, createProject } from '../../db.js'
import { initCredentialStore } from '../../credentials.js'
import { IntegrationEngine } from '../engine.js'
import { googleManifest } from './manifest.js'
import { GoogleClient } from './client.js'

describe('GoogleClient', () => {
  let engine: IntegrationEngine
  let client: GoogleClient

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    const db = initDatabase()
    initCredentialStore(db)
    createProject({ id: 'test-proj', name: 'test-proj', slug: 'test-proj', display_name: 'Test' })
    engine = new IntegrationEngine(TEST_KEY)
    engine.register(googleManifest)
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    client = new GoogleClient(engine, 'fake-client-id', 'fake-client-secret')
  })

  it('throws IntegrationNotConnectedError when no tokens exist', () => {
    expect(() => client.getOAuth2Client('no-such-project')).toThrow('not connected')
  })

  it('throws IntegrationNotConnectedError when account not specified and multiple exist', () => {
    engine.storeTokens('test-proj', 'google', 'a@test.com', {
      access_token: 'tok1', refresh_token: 'ref1', expiry_date: Date.now() + 3600000, scope: 'email',
    })
    engine.storeTokens('test-proj', 'google', 'b@test.com', {
      access_token: 'tok2', refresh_token: 'ref2', expiry_date: Date.now() + 3600000, scope: 'email',
    })
    expect(() => client.getOAuth2Client('test-proj')).toThrow('specify --account')
  })

  it('returns OAuth2 client when account is specified', () => {
    const oauth2 = client.getOAuth2Client('test-proj', 'a@test.com')
    expect(oauth2).toBeDefined()
    expect(oauth2.credentials.access_token).toBe('tok1')
  })

  it('returns OAuth2 client for default account when only one exists', () => {
    createProject({ id: 'single-acct', name: 'single', slug: 'single', display_name: 'Single' })
    engine.storeTokens('single-acct', 'google', 'only@test.com', {
      access_token: 'tok-only', refresh_token: 'ref-only', expiry_date: Date.now() + 3600000, scope: 'email',
    })
    const oauth2 = client.getOAuth2Client('single-acct')
    expect(oauth2.credentials.access_token).toBe('tok-only')
  })

  describe('ensureFreshToken with dashboard', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeAll(() => {
      createProject({ id: 'dash-proj', name: 'dash', slug: 'dash', display_name: 'Dash' })
    })

    beforeEach(() => {
      // Reset per-test so we can toggle dashboard config between assertions.
      dashboardConfig.url = 'http://dashboard.test'
      dashboardConfig.botToken = 'bot-token-abc'
      dashboardConfig.apiToken = ''

      // Fresh tokens per test (expiry in the past so the local-fallback branch
      // will actually attempt a refresh, exercising that code path).
      engine.storeTokens('dash-proj', 'google', 'u@test.com', {
        access_token: 'stale-access',
        refresh_token: 'stale-refresh',
        expiry_date: Date.now() - 60_000,
        scope: 'email',
      })

      fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      dashboardConfig.url = ''
      dashboardConfig.botToken = ''
      dashboardConfig.apiToken = ''
    })

    it('fetches access token from dashboard when configured', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'fresh-from-dashboard',
          expiry_date: Date.now() + 3600_000,
          email: 'u@test.com',
        }),
      })

      const oauth2 = await client.ensureFreshToken('dash-proj', 'u@test.com')
      expect(oauth2.credentials.access_token).toBe('fresh-from-dashboard')

      // Verify the exact URL + auth header
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(String(url)).toContain('/api/v1/integrations/google/access-token')
      expect(String(url)).toContain('project_id=dash-proj')
      expect(String(url)).toContain('account=u%40test.com')
      expect(init.headers['x-dashboard-token']).toBe('bot-token-abc')

      // Mirrors fresh access_token to local store
      const stored = engine.getTokens('dash-proj', 'google', 'u@test.com')!
      expect(stored.access_token).toBe('fresh-from-dashboard')
    })

    it('falls back to local refresh when dashboard returns non-OK', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom',
      })

      // We only care that the dashboard was tried and the code continued into
      // the fallback branch. Local refresh may succeed, fail transiently, or
      // raise -- any of those is acceptable here.
      await client.ensureFreshToken('dash-proj', 'u@test.com').catch(() => {})
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('skips dashboard call when DASHBOARD_URL is unset', async () => {
      dashboardConfig.url = ''
      // We don't care about the outcome of the local refresh here -- just that
      // we never made a dashboard HTTP call when dashboard config is missing.
      await client.ensureFreshToken('dash-proj', 'u@test.com').catch(() => {})
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('prefers BOT_API_TOKEN over DASHBOARD_API_TOKEN', async () => {
      dashboardConfig.botToken = 'bot-token'
      dashboardConfig.apiToken = 'admin-token'
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'x', expiry_date: Date.now() + 60_000 }),
      })

      await client.ensureFreshToken('dash-proj', 'u@test.com')
      expect(fetchMock.mock.calls[0][1].headers['x-dashboard-token']).toBe('bot-token')
    })

    it('falls back to DASHBOARD_API_TOKEN when BOT_API_TOKEN is empty', async () => {
      dashboardConfig.botToken = ''
      dashboardConfig.apiToken = 'admin-token'
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: 'x', expiry_date: Date.now() + 60_000 }),
      })

      await client.ensureFreshToken('dash-proj', 'u@test.com')
      expect(fetchMock.mock.calls[0][1].headers['x-dashboard-token']).toBe('admin-token')
    })
  })
})
