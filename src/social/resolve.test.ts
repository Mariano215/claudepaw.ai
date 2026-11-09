import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-resolve-test-${process.pid}`)

vi.mock('../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const crypto = require('node:crypto')
  const dir = path.join(os.tmpdir(), `claudepaw-resolve-test-${process.pid}`)
  return {
    STORE_DIR: dir,
    PROJECT_ROOT: dir,
    CREDENTIAL_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  }
})

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, createProject } from '../db.js'
import { initCredentialStore, setCredential } from '../credentials.js'
import { resolveTwitterConfig, resolveLinkedInConfig } from './resolve.js'

describe('social credential resolution', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    const db = initDatabase()
    initCredentialStore(db)
    createProject({
      id: 'proj-a',
      name: 'proj-a',
      slug: 'proj-a',
      display_name: 'Project A',
    })
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('returns null when twitter creds are missing', () => {
    expect(resolveTwitterConfig('proj-a')).toBeNull()
  })

  it('returns null when twitter creds are incomplete', () => {
    setCredential('proj-a', 'twitter', 'api_key', 'k1')
    setCredential('proj-a', 'twitter', 'api_secret', 'k2')
    expect(resolveTwitterConfig('proj-a')).toBeNull()
  })

  it('returns twitter config when all creds present', () => {
    setCredential('proj-a', 'twitter', 'access_token', 'k3')
    setCredential('proj-a', 'twitter', 'access_secret', 'k4')
    const cfg = resolveTwitterConfig('proj-a')
    expect(cfg).toEqual({ apiKey: 'k1', apiSecret: 'k2', accessToken: 'k3', accessSecret: 'k4' })
  })

  it('returns null when linkedin creds are missing', () => {
    expect(resolveLinkedInConfig('proj-a')).toBeNull()
  })

  it('returns linkedin config when all creds present', () => {
    setCredential('proj-a', 'linkedin', 'access_token', 'tok')
    setCredential('proj-a', 'linkedin', 'person_urn', 'urn:li:person:123')
    const cfg = resolveLinkedInConfig('proj-a')
    expect(cfg).toEqual({ accessToken: 'tok', personUrn: 'urn:li:person:123' })
  })
})
