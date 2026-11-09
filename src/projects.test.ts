import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

// vi.mock factories are hoisted, so use a getter pattern
const TEST_DIR = join(tmpdir(), `claudepaw-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  initDatabase,
  createProject,
  getProject,
  getProjectBySlug,
  getProjectByName,
  listProjects,
  updateProject,
  deleteProject,
  getProjectSettings,
  upsertProjectSettings,
  getChatProject,
  setChatProject,
  insertMemory,
  getRecentMemories,
  createTask,
  listTasks,
} from './db.js'

describe('multi-project support', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    initDatabase()
  })

  afterAll(() => {
    try { rmSync(TEST_DIR, { recursive: true }) } catch { /* ignore */ }
  })

  describe('projects CRUD', () => {
    it('seeds default project on init', () => {
      const def = getProject('default')
      expect(def).toBeDefined()
      expect(def!.display_name).toBe('Personal Assistant')
    })

    it('creates a new project', () => {
      createProject({
        id: 'example-company',
        name: 'example-company',
        slug: 'example-company',
        display_name: 'Example Company',
        icon: '🫒',
      })
      const p = getProject('example-company')
      expect(p).toBeDefined()
      expect(p!.display_name).toBe('Example Company')
      expect(p!.icon).toBe('🫒')
    })

    it('finds project by slug', () => {
      const p = getProjectBySlug('example-company')
      expect(p).toBeDefined()
      expect(p!.id).toBe('example-company')
    })

    it('finds project by name', () => {
      const p = getProjectByName('example-company')
      expect(p).toBeDefined()
      expect(p!.id).toBe('example-company')
    })

    it('lists all projects', () => {
      const all = listProjects()
      expect(all.length).toBeGreaterThanOrEqual(2)
      const ids = all.map((p) => p.id)
      expect(ids).toContain('default')
      expect(ids).toContain('example-company')
    })

    it('updates a project', () => {
      updateProject('example-company', { display_name: 'Example Co' })
      const p = getProject('example-company')
      expect(p!.display_name).toBe('Example Co')
    })

    it('refuses to delete default project', () => {
      const deleted = deleteProject('default')
      expect(deleted).toBe(false)
      expect(getProject('default')).toBeDefined()
    })

    it('deletes a non-default project', () => {
      createProject({ id: 'temp', name: 'temp', slug: 'temp', display_name: 'Temp' })
      const deleted = deleteProject('temp')
      expect(deleted).toBe(true)
      expect(getProject('temp')).toBeUndefined()
    })
  })

  describe('project settings', () => {
    it('returns undefined for project with no settings', () => {
      const s = getProjectSettings('default')
      expect(s).toBeUndefined()
    })

    it('upserts project settings', () => {
      upsertProjectSettings({
        project_id: 'example-company',
        primary_color: '#2d5a27',
        accent_color: '#8bc34a',
        sidebar_color: '#1b3617',
      })
      const s = getProjectSettings('example-company')
      expect(s).toBeDefined()
      expect(s!.primary_color).toBe('#2d5a27')
    })

    it('updates existing settings without overwriting nulls', () => {
      upsertProjectSettings({
        project_id: 'example-company',
        logo_path: '/img/example.png',
      })
      const s = getProjectSettings('example-company')
      expect(s!.primary_color).toBe('#2d5a27')
      expect(s!.logo_path).toBe('/img/example.png')
    })
  })

  describe('chat-project mapping', () => {
    it('defaults to default project', () => {
      const pid = getChatProject('unknown-chat')
      expect(pid).toBe('default')
    })

    it('sets and retrieves chat project', () => {
      setChatProject('chat-123', 'example-company')
      expect(getChatProject('chat-123')).toBe('example-company')
    })

    it('switches project for same chat', () => {
      setChatProject('chat-123', 'default')
      expect(getChatProject('chat-123')).toBe('default')
    })

    it('falls back to legacy raw chat id when channel-qualified key is not mapped yet', () => {
      setChatProject('legacy-chat', 'example-company')
      expect(getChatProject('telegram:legacy-chat', 'legacy-chat')).toBe('example-company')
    })
  })

  describe('project-scoped queries', () => {
    it('insertMemory with projectId scopes memory', () => {
      insertMemory('chat-1', 'test memory for example', 'semantic', undefined, 'example-company')
      insertMemory('chat-1', 'test memory for default project', 'semantic', undefined, 'default')

      const exampleMemories = getRecentMemories('chat-1', 10, 'example-company')
      const defaultMemories = getRecentMemories('chat-1', 10, 'default')

      expect(exampleMemories.length).toBe(1)
      expect(exampleMemories[0].content).toContain('example')
      expect(defaultMemories.length).toBe(1)
      expect(defaultMemories[0].content).toContain('default')
    })

    it('listTasks with projectId scopes tasks', () => {
      createTask('task-example', 'chat-1', 'example task', '0 9 * * *', Date.now() + 86400000, 'example-company')
      createTask('task-default', 'chat-1', 'default task', '0 9 * * *', Date.now() + 86400000, 'default')

      const exampleTasks = listTasks('chat-1', 'example-company')
      const defaultTasks = listTasks('chat-1', 'default')

      expect(exampleTasks.length).toBe(1)
      expect(exampleTasks[0].id).toBe('task-example')
      expect(defaultTasks.length).toBe(1)
      expect(defaultTasks[0].id).toBe('task-default')
    })

    it('listTasks without projectId returns all', () => {
      const allTasks = listTasks('chat-1')
      expect(allTasks.length).toBe(2)
    })
  })
})
