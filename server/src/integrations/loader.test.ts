import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { loadCatalog, getCatalogEntry, getAllCatalogEntries } from './loader.js'

describe('catalog loader', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'catalog-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const validManifest = (id: string) => ({
    id, name: id, category: 'other', icon: 'x', description: 'd',
    kind: 'api_key',
    api_key: { credential_key: `${id}.api_key`, test_endpoint: 'https://example.com', test_header: 'Authorization: Bearer {api_key}' },
    setup: { credentials_required: [{ service: id, key: 'api_key', label: 'Key', input_type: 'password' }] },
    verify: { kind: 'http_get', endpoint: 'https://example.com', header_template: 'Authorization: Bearer {api_key}', expect_status: 200 },
  })

  it('loads valid manifests from a directory', () => {
    writeFileSync(path.join(dir, 'one.json'), JSON.stringify(validManifest('one')))
    writeFileSync(path.join(dir, 'two.json'), JSON.stringify(validManifest('two')))
    loadCatalog(dir)
    expect(getAllCatalogEntries().map(m => m.id).sort()).toEqual(['one', 'two'])
  })

  it('skips invalid manifests but continues loading the rest', () => {
    writeFileSync(path.join(dir, 'good.json'), JSON.stringify(validManifest('good')))
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'bad' }))
    loadCatalog(dir)
    expect(getAllCatalogEntries().map(m => m.id)).toEqual(['good'])
  })

  it('returns undefined for unknown ids', () => {
    loadCatalog(dir)
    expect(getCatalogEntry('nope')).toBeUndefined()
  })

  it('handles non-json files gracefully', () => {
    writeFileSync(path.join(dir, 'README.md'), '# notes')
    writeFileSync(path.join(dir, 'good.json'), JSON.stringify(validManifest('good')))
    loadCatalog(dir)
    expect(getAllCatalogEntries().map(m => m.id)).toEqual(['good'])
  })

  it('handles missing directory without throwing', () => {
    expect(() => loadCatalog(path.join(dir, 'does-not-exist'))).not.toThrow()
    expect(getAllCatalogEntries()).toEqual([])
  })
})
