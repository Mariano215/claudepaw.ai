import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-todo-test-${process.pid}`)

vi.mock('../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-todo-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir }
})

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { handleTodoCommand } from './todo.js'
import { initDatabase } from '../db.js'

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  initDatabase()
})

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('handleTodoCommand', () => {
  it('add creates an item in approved state (human source)', async () => {
    const res = await handleTodoCommand({
      args: 'add Fix dashboard cache bust',
      projectId: 'default',
      actor: 'human',
    })
    expect(res.ok).toBe(true)
    expect(res.message).toMatch(/created/i)
    expect(res.itemId).toBeDefined()
  })

  it('list returns plain text', async () => {
    const res = await handleTodoCommand({
      args: 'list',
      projectId: 'default',
      actor: 'human',
    })
    expect(res.ok).toBe(true)
    expect(typeof res.message).toBe('string')
  })

  it('unknown subcommand returns help', async () => {
    const res = await handleTodoCommand({
      args: 'floof',
      projectId: 'default',
      actor: 'human',
    })
    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/usage/i)
  })
})
