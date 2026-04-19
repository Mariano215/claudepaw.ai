import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import crypto from 'node:crypto'

const TEST_DIR = join(tmpdir(), `claudepaw-engine-test-${process.pid}`)
const TEST_KEY = crypto.randomBytes(32).toString('hex')

vi.mock('../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const cry = require('node:crypto')
  const dir = path.join(os.tmpdir(), `claudepaw-engine-test-${process.pid}`)
  return {
    STORE_DIR: dir,
    PROJECT_ROOT: dir,
    CREDENTIAL_ENCRYPTION_KEY: cry.randomBytes(32).toString('hex'),
  }
})

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, createProject } from '../db.js'
import { initCredentialStore, setCredential, getCredential } from '../credentials.js'
import { IntegrationEngine } from './engine.js'
import type { ServiceManifest } from './types.js'

const mockManifest: ServiceManifest = {
  name: 'test-service',
  displayName: 'Test Service',
  authType: 'oauth2',
  oauth: {
    authUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    availableScopes: ['read', 'write'],
    requiredScopes: ['read'],
  },
  requiredKeys: ['access_token', 'refresh_token'],
  healthCheck: async () => true,
}

describe('IntegrationEngine', () => {
  let engine: IntegrationEngine

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    const db = initDatabase()
    initCredentialStore(db)
    createProject({ id: 'test-proj', name: 'test-proj', slug: 'test-proj', display_name: 'Test' })
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  beforeEach(() => {
    engine = new IntegrationEngine(TEST_KEY)
  })

  it('registers a service manifest', () => {
    engine.register(mockManifest)
    const services = engine.listServices()
    expect(services).toHaveLength(1)
    expect(services[0].name).toBe('test-service')
  })

  it('throws on duplicate registration', () => {
    engine.register(mockManifest)
    expect(() => engine.register(mockManifest)).toThrow('already registered')
  })

  it('generates OAuth URL with signed state', () => {
    engine.register(mockManifest)
    const result = engine.startOAuth('test-proj', 'test-service', {
      returnUrl: 'http://localhost:3000/settings',
    })
    expect(result.url).toContain('https://example.com/auth')
    expect(result.url).toContain('state=')
    expect(result.state).toBeTruthy()
  })

  it('verifies valid state token', () => {
    engine.register(mockManifest)
    const { state } = engine.startOAuth('test-proj', 'test-service', {
      returnUrl: 'http://localhost:3000/settings',
    })
    const decoded = engine.verifyState(state)
    expect(decoded.projectId).toBe('test-proj')
    expect(decoded.service).toBe('test-service')
    expect(decoded.returnUrl).toBe('http://localhost:3000/settings')
  })

  it('rejects tampered state token', () => {
    expect(() => engine.verifyState('invalid.jwt.token')).toThrow()
  })

  it('returns empty status for project with no integrations', () => {
    engine.register(mockManifest)
    const status = engine.getStatus('test-proj')
    expect(status).toEqual([])
  })

  it('returns status for project with stored credentials', () => {
    engine.register(mockManifest)
    setCredential('test-proj', 'test-service:user@test.com', 'access_token', 'tok123')
    setCredential('test-proj', 'test-service:user@test.com', 'refresh_token', 'ref123')
    setCredential('test-proj', 'test-service:user@test.com', 'expiry', String(Date.now() + 3600000))
    setCredential('test-proj', 'test-service:user@test.com', 'scopes', 'read,write')
    setCredential('test-proj', 'test-service:user@test.com', 'account_email', 'user@test.com')
    setCredential('test-proj', 'test-service:user@test.com', 'status', 'connected')

    const status = engine.getStatus('test-proj')
    expect(status).toHaveLength(1)
    expect(status[0].service).toBe('test-service')
    expect(status[0].account).toBe('user@test.com')
    expect(status[0].status).toBe('connected')
    expect(status[0].scopes).toEqual(['read', 'write'])
  })

  it('disconnects an integration', () => {
    engine.register(mockManifest)
    setCredential('test-proj', 'test-service:user@test.com', 'status', 'connected')
    engine.disconnect('test-proj', 'test-service', 'user@test.com')
    const statusVal = getCredential('test-proj', 'test-service:user@test.com', 'status')
    expect(statusVal).toBeNull()
  })
})
