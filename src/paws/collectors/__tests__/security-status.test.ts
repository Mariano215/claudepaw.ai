import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { securityStatusCollector } from '../security-status.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE security_findings (id TEXT PRIMARY KEY, scanner_id TEXT, severity TEXT, title TEXT,
    status TEXT DEFAULT 'open', first_seen INTEGER, last_seen INTEGER)`)
  db.prepare(`INSERT INTO security_findings VALUES ('f1','npm','high','lodash CVE','open',1,1)`).run()
  return db
}

describe('security-status collector', () => {
  it('returns open findings grouped by severity and a stable fingerprint', async () => {
    const db = makeDb()
    const a = await securityStatusCollector({ pawId: 'p', projectId: 'default', db } as never)
    const b = await securityStatusCollector({ pawId: 'p', projectId: 'default', db } as never)
    const raw = a.raw_data as { open: number; bySeverity: Record<string, number>; fingerprint: string }
    expect(raw.open).toBe(1)
    expect(raw.bySeverity.high).toBe(1)
    expect(raw.fingerprint).toBe((b.raw_data as { fingerprint: string }).fingerprint)
  })
})
