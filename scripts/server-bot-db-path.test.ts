import { describe, it, expect } from 'vitest'
import { resolveBotDbPath } from '../server/src/db.js'

describe('resolveBotDbPath', () => {
  it('honors explicit BOT_DB_PATH overrides', () => {
    expect(resolveBotDbPath('/tmp/custom-bot.db')).toBe('/tmp/custom-bot.db')
  })

  it('defaults to the repo-level bot database path', () => {
    expect(resolveBotDbPath(undefined)).toMatch(/\/store\/claudepaw\.db$/)
    expect(resolveBotDbPath(undefined)).not.toMatch(/\/server\/store\/claudepaw\.db$/)
  })
})
