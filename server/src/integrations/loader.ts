import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { manifestSchema, type IntegrationManifest } from './schema.js'

let cache: Map<string, IntegrationManifest> = new Map()

export function loadCatalog(catalogDir: string): void {
  cache = new Map()
  if (!existsSync(catalogDir)) {
    console.warn(`[integrations] catalog dir does not exist: ${catalogDir}`)
    return
  }
  let files: string[]
  try {
    files = readdirSync(catalogDir).filter(f => f.endsWith('.json'))
  } catch (err) {
    console.warn(`[integrations] failed to read catalog dir`, err)
    return
  }
  for (const file of files) {
    const fullPath = path.join(catalogDir, file)
    try {
      const raw = readFileSync(fullPath, 'utf8')
      const parsed = JSON.parse(raw)
      const result = manifestSchema.safeParse(parsed)
      if (!result.success) {
        console.warn(`[integrations] invalid manifest ${file}:`, result.error.issues)
        continue
      }
      if (cache.has(result.data.id)) {
        console.warn(`[integrations] duplicate manifest id ${result.data.id} in ${file}, skipping`)
        continue
      }
      cache.set(result.data.id, result.data)
    } catch (err) {
      console.warn(`[integrations] failed to load ${file}:`, err)
    }
  }
  console.info(`[integrations] loaded ${cache.size} catalog entries`)
}

export function getCatalogEntry(id: string): IntegrationManifest | undefined {
  return cache.get(id)
}

export function getAllCatalogEntries(): IntegrationManifest[] {
  return Array.from(cache.values()).sort((a, b) => a.name.localeCompare(b.name))
}
