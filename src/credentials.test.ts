import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-cred-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const crypto = require('node:crypto')
  const dir = path.join(os.tmpdir(), `claudepaw-cred-test-${process.pid}`)
  return {
    STORE_DIR: dir,
    PROJECT_ROOT: dir,
    CREDENTIAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, createProject } from './db.js'
import {
  initCredentialStore,
  setCredential,
  getCredential,
  getServiceCredentials,
  listServices,
  listAllProjectServices,
  deleteCredential,
  deleteService,
} from './credentials.js'

describe('credential store', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    const db = initDatabase()
    initCredentialStore(db)
    createProject({
      id: 'test-project',
      name: 'test-project',
      slug: 'test-project',
      display_name: 'Test Project',
    })
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('sets and gets a credential', () => {
    setCredential('default', 'twitter', 'api_key', 'my-secret-key-123')
    const value = getCredential('default', 'twitter', 'api_key')
    expect(value).toBe('my-secret-key-123')
  })

  it('returns null for missing credential', () => {
    const value = getCredential('default', 'nonexistent', 'key')
    expect(value).toBeNull()
  })

  it('overwrites existing credential', () => {
    setCredential('default', 'twitter', 'api_key', 'original')
    setCredential('default', 'twitter', 'api_key', 'updated')
    expect(getCredential('default', 'twitter', 'api_key')).toBe('updated')
  })

  it('isolates credentials between projects', () => {
    setCredential('default', 'twitter', 'api_key', 'default-key')
    setCredential('test-project', 'twitter', 'api_key', 'project-key')
    expect(getCredential('default', 'twitter', 'api_key')).toBe('default-key')
    expect(getCredential('test-project', 'twitter', 'api_key')).toBe('project-key')
  })

  it('gets all credentials for a service', () => {
    setCredential('default', 'linkedin', 'access_token', 'token-abc')
    setCredential('default', 'linkedin', 'person_urn', 'urn:li:person:123')
    const creds = getServiceCredentials('default', 'linkedin')
    expect(creds).toEqual({
      access_token: 'token-abc',
      person_urn: 'urn:li:person:123',
    })
  })

  it('lists services for a project', () => {
    setCredential('test-project', 'telegram', 'bot_token', 'tok123')
    setCredential('test-project', 'twitter', 'api_key', 'key456')
    const services = listServices('test-project')
    expect(services).toContain('telegram')
    expect(services).toContain('twitter')
  })

  it('lists all project services', () => {
    const all = listAllProjectServices()
    expect(all.length).toBeGreaterThanOrEqual(2)
    const defaultTwitter = all.find(
      (s) => s.projectId === 'default' && s.service === 'twitter',
    )
    expect(defaultTwitter).toBeDefined()
    expect(defaultTwitter!.keys).toContain('api_key')
  })

  it('deletes a specific credential', () => {
    setCredential('default', 'meta', 'app_id', 'deleteme')
    deleteCredential('default', 'meta', 'app_id')
    expect(getCredential('default', 'meta', 'app_id')).toBeNull()
  })

  it('deletes an entire service', () => {
    setCredential('default', 'shopify', 'api_key', 'k1')
    setCredential('default', 'shopify', 'api_secret', 'k2')
    deleteService('default', 'shopify')
    expect(getServiceCredentials('default', 'shopify')).toEqual({})
  })

  it('handles special characters in values', () => {
    const specialValue = 'p@$$w0rd!#%^&*()=+[]{}|;:,.<>?/~`"\'\\n\\t'
    setCredential('default', 'custom', 'special', specialValue)
    expect(getCredential('default', 'custom', 'special')).toBe(specialValue)
  })

  it('handles empty string values', () => {
    setCredential('default', 'custom', 'empty', '')
    expect(getCredential('default', 'custom', 'empty')).toBe('')
  })

  it('handles long values', () => {
    const longValue = 'x'.repeat(10000)
    setCredential('default', 'custom', 'long', longValue)
    expect(getCredential('default', 'custom', 'long')).toBe(longValue)
  })
})
