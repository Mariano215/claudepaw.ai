import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

const TEST_DIR = join(tmpdir(), `claudepaw-users-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-users-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, createProject } from './db.js'
import {
  initUserStore,
  hashToken,
  generateRawToken,
  createUser,
  getUserById,
  getUserByEmail,
  listUsers,
  updateUser,
  deleteUser,
  touchUserLastSeen,
  createUserToken,
  listUserTokens,
  getUserTokenById,
  revokeUserToken,
  resolveUserByTokenHash,
  grantProjectMembership,
  revokeProjectMembership,
  listProjectMemberships,
  listProjectMembers,
  getUserProjectIds,
  getUserProjectRole,
  roleAtLeast,
} from './users.js'

describe('users module', () => {
  let db: Database.Database

  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    db = initDatabase()
    initUserStore(db)
    // Seed a test project for membership tests
    createProject({ id: 'proj-a', name: 'proj-a', slug: 'proj-a', display_name: 'Project A' })
    createProject({ id: 'proj-b', name: 'proj-b', slug: 'proj-b', display_name: 'Project B' })
  })

  afterAll(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------

  describe('hashToken', () => {
    it('returns lowercase hex of length 64', () => {
      const h = hashToken('hello')
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    })

    it('is deterministic', () => {
      expect(hashToken('abc')).toBe(hashToken('abc'))
    })

    it('produces different hashes for different inputs', () => {
      expect(hashToken('a')).not.toBe(hashToken('b'))
    })
  })

  describe('generateRawToken', () => {
    it('returns 43 characters (32 bytes base64url without padding)', () => {
      const t = generateRawToken()
      expect(t).toHaveLength(43)
    })

    it('contains only base64url characters (no + / =)', () => {
      const t = generateRawToken()
      expect(t).toMatch(/^[A-Za-z0-9\-_]+$/)
    })

    it('generates unique tokens', () => {
      const tokens = new Set(Array.from({ length: 10 }, generateRawToken))
      expect(tokens.size).toBe(10)
    })
  })

  // ---------------------------------------------------------------------------
  // Users CRUD
  // ---------------------------------------------------------------------------

  describe('createUser / getUserById / getUserByEmail', () => {
    it('creates a user and retrieves by id', () => {
      const u = createUser({ email: 'alice@example.com', name: 'Alice' })
      expect(u.id).toBeTypeOf('number')
      expect(u.email).toBe('alice@example.com')
      expect(u.name).toBe('Alice')
      expect(u.global_role).toBe('member')
      expect(u.created_at).toBeGreaterThan(0)
      expect(u.last_seen_at).toBeNull()

      const fetched = getUserById(u.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.email).toBe('alice@example.com')
    })

    it('creates a user with admin role', () => {
      const u = createUser({ email: 'admin@example.com', name: 'Admin', global_role: 'admin' })
      expect(u.global_role).toBe('admin')
    })

    it('retrieves user by email', () => {
      const u = getUserByEmail('alice@example.com')
      expect(u).not.toBeNull()
      expect(u!.name).toBe('Alice')
    })

    it('returns null for missing id', () => {
      expect(getUserById(999999)).toBeNull()
    })

    it('returns null for missing email', () => {
      expect(getUserByEmail('nobody@example.com')).toBeNull()
    })

    it('throws on duplicate email', () => {
      expect(() => createUser({ email: 'alice@example.com', name: 'Alice2' })).toThrow()
    })

    it('normalizes email to lowercase on create', () => {
      const u = createUser({ email: 'Norm@Example.COM', name: 'Norm' })
      expect(u.email).toBe('norm@example.com')
    })

    it('duplicate throws even when case differs', () => {
      // 'norm@example.com' was created just above
      expect(() => createUser({ email: 'NORM@EXAMPLE.COM', name: 'Norm2' })).toThrow()
    })

    it('getUserByEmail is case-insensitive', () => {
      const u = getUserByEmail('NORM@EXAMPLE.COM')
      expect(u).not.toBeNull()
      expect(u!.email).toBe('norm@example.com')
    })
  })

  describe('listUsers', () => {
    it('returns all created users', () => {
      const users = listUsers()
      const emails = users.map(u => u.email)
      expect(emails).toContain('alice@example.com')
      expect(emails).toContain('admin@example.com')
    })
  })

  describe('updateUser', () => {
    it('updates name', () => {
      const u = createUser({ email: 'bob@example.com', name: 'Bob' })
      const updated = updateUser(u.id, { name: 'Robert' })
      expect(updated.name).toBe('Robert')
      expect(getUserById(u.id)!.name).toBe('Robert')
    })

    it('updates email and normalizes case', () => {
      const u = createUser({ email: 'charlie@example.com', name: 'Charlie' })
      const updated = updateUser(u.id, { email: 'Charlie2@Example.COM' })
      expect(updated.email).toBe('charlie2@example.com')
    })

    it('updates global_role', () => {
      const u = createUser({ email: 'diana@example.com', name: 'Diana' })
      const updated = updateUser(u.id, { global_role: 'admin' })
      expect(updated.global_role).toBe('admin')
    })

    it('throws on non-existent user', () => {
      expect(() => updateUser(999999, { name: 'Ghost' })).toThrow()
    })

    it('empty patch returns unchanged user without throwing', () => {
      const u = createUser({ email: 'emptypatch@example.com', name: 'EmptyPatch' })
      const result = updateUser(u.id, {})
      expect(result.name).toBe('EmptyPatch')
      expect(result.id).toBe(u.id)
    })

    it('silently drops unknown keys and applies only whitelisted fields', () => {
      const u = createUser({ email: 'whitelist@example.com', name: 'Original' })
      // Passing an extra unknown field via type cast -- simulates a loose runtime caller
      const result = updateUser(u.id, { name: 'Updated', injected_col: 'x' } as any)
      expect(result.name).toBe('Updated')
      // Unknown key was dropped, not thrown as a SQL error
      expect((result as any).injected_col).toBeUndefined()
      // Re-fetch to confirm no schema corruption
      const fresh = getUserById(u.id)!
      expect(fresh.name).toBe('Updated')
    })
  })

  describe('deleteUser', () => {
    it('deletes user and cascades to tokens', () => {
      const u = createUser({ email: 'todelete@example.com', name: 'ToDelete' })
      const { record } = createUserToken({ user_id: u.id, label: 'test' })
      expect(getUserTokenById(record.id)).not.toBeNull()

      deleteUser(u.id)
      expect(getUserById(u.id)).toBeNull()
      // FK cascade: token should be gone
      expect(getUserTokenById(record.id)).toBeNull()
    })

    it('deletes user and cascades to memberships', () => {
      const u = createUser({ email: 'member-delete@example.com', name: 'MemberDelete' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'viewer' })
      expect(listProjectMemberships(u.id)).toHaveLength(1)

      deleteUser(u.id)
      expect(listProjectMemberships(u.id)).toHaveLength(0)
    })
  })

  describe('touchUserLastSeen', () => {
    it('updates last_seen_at', () => {
      const u = createUser({ email: 'seen@example.com', name: 'Seen' })
      expect(u.last_seen_at).toBeNull()

      const now = Date.now()
      touchUserLastSeen(u.id, now)
      expect(getUserById(u.id)!.last_seen_at).toBe(now)
    })

    it('uses Date.now() when no timestamp provided', () => {
      const u = createUser({ email: 'seen2@example.com', name: 'Seen2' })
      const before = Date.now()
      touchUserLastSeen(u.id)
      const after = Date.now()
      const ts = getUserById(u.id)!.last_seen_at
      expect(ts).not.toBeNull()
      expect(ts!).toBeGreaterThanOrEqual(before)
      expect(ts!).toBeLessThanOrEqual(after)
    })
  })

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  describe('token lifecycle', () => {
    it('createUserToken returns raw token and record', () => {
      const u = createUser({ email: 'token-user@example.com', name: 'TokenUser' })
      const { token, record } = createUserToken({ user_id: u.id, label: 'my-token' })
      expect(token).toHaveLength(43)
      expect(record.user_id).toBe(u.id)
      expect(record.label).toBe('my-token')
      expect(record.revoked_at).toBeNull()
      expect(record.last_used_at).toBeNull()
      // raw token is NOT the stored hash
      expect(token).not.toBe(record.token_hash)
      // hash of raw == stored hash
      expect(hashToken(token)).toBe(record.token_hash)
    })

    it('resolves user by token hash', () => {
      const u = createUser({ email: 'resolver@example.com', name: 'Resolver' })
      const { token } = createUserToken({ user_id: u.id })
      const resolved = resolveUserByTokenHash(hashToken(token))
      expect(resolved).not.toBeNull()
      expect(resolved!.id).toBe(u.id)
    })

    it('resolveUserByTokenHash updates last_used_at and last_seen_at', () => {
      const u = createUser({ email: 'tracker@example.com', name: 'Tracker' })
      const { token, record } = createUserToken({ user_id: u.id })

      expect(record.last_used_at).toBeNull()
      expect(u.last_seen_at).toBeNull()

      const before = Date.now()
      resolveUserByTokenHash(hashToken(token))
      const after = Date.now()

      const updatedToken = getUserTokenById(record.id)!
      expect(updatedToken.last_used_at).not.toBeNull()
      expect(updatedToken.last_used_at!).toBeGreaterThanOrEqual(before)
      expect(updatedToken.last_used_at!).toBeLessThanOrEqual(after)

      const updatedUser = getUserById(u.id)!
      expect(updatedUser.last_seen_at).not.toBeNull()
      expect(updatedUser.last_seen_at!).toBeGreaterThanOrEqual(before)
      expect(updatedUser.last_seen_at!).toBeLessThanOrEqual(after)
    })

    it('revokeUserToken blocks resolution', () => {
      const u = createUser({ email: 'revoke@example.com', name: 'Revoke' })
      const { token, record } = createUserToken({ user_id: u.id })

      expect(resolveUserByTokenHash(hashToken(token))).not.toBeNull()

      revokeUserToken(record.id)

      const revokedRecord = getUserTokenById(record.id)!
      expect(revokedRecord.revoked_at).not.toBeNull()

      expect(resolveUserByTokenHash(hashToken(token))).toBeNull()
    })

    it('resolveUserByTokenHash returns null for unknown hash', () => {
      expect(resolveUserByTokenHash('0'.repeat(64))).toBeNull()
    })

    it('listUserTokens returns all tokens including revoked', () => {
      const u = createUser({ email: 'list-tokens@example.com', name: 'ListTokens' })
      const { record: r1 } = createUserToken({ user_id: u.id, label: 'first' })
      const { record: r2 } = createUserToken({ user_id: u.id, label: 'second' })
      revokeUserToken(r1.id)
      const tokens = listUserTokens(u.id)
      expect(tokens).toHaveLength(2)
      const ids = tokens.map(t => t.id)
      expect(ids).toContain(r1.id)
      expect(ids).toContain(r2.id)
    })

    it('getUserTokenById returns null for missing id', () => {
      expect(getUserTokenById(999999)).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Memberships
  // ---------------------------------------------------------------------------

  describe('project memberships', () => {
    it('grants membership and retrieves role', () => {
      const u = createUser({ email: 'member@example.com', name: 'Member' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'editor' })
      expect(getUserProjectRole(u.id, 'proj-a')).toBe('editor')
    })

    it('upserts membership role', () => {
      const u = createUser({ email: 'upsert-member@example.com', name: 'UpsertMember' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'viewer' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'owner' })
      expect(getUserProjectRole(u.id, 'proj-a')).toBe('owner')
    })

    it('listProjectMemberships returns all projects for a user', () => {
      const u = createUser({ email: 'multi-member@example.com', name: 'MultiMember' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'viewer' })
      grantProjectMembership({ project_id: 'proj-b', user_id: u.id, role: 'editor' })
      const memberships = listProjectMemberships(u.id)
      expect(memberships).toHaveLength(2)
      const projectIds = memberships.map(m => m.project_id)
      expect(projectIds).toContain('proj-a')
      expect(projectIds).toContain('proj-b')
    })

    it('listProjectMembers returns members with user objects', () => {
      const u = createUser({ email: 'listed-member@example.com', name: 'ListedMember' })
      grantProjectMembership({ project_id: 'proj-b', user_id: u.id, role: 'owner', granted_by_user_id: null })
      const members = listProjectMembers('proj-b')
      const entry = members.find(m => m.user_id === u.id)
      expect(entry).toBeDefined()
      expect(entry!.user.email).toBe('listed-member@example.com')
      expect(entry!.role).toBe('owner')
    })

    it('revokeProjectMembership removes the row', () => {
      const u = createUser({ email: 'revoke-member@example.com', name: 'RevokeMember' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'viewer' })
      expect(getUserProjectRole(u.id, 'proj-a')).toBe('viewer')

      revokeProjectMembership('proj-a', u.id)
      expect(getUserProjectRole(u.id, 'proj-a')).toBeNull()
    })

    it('getUserProjectIds returns only projects user is member of', () => {
      const u = createUser({ email: 'project-ids@example.com', name: 'ProjectIds' })
      grantProjectMembership({ project_id: 'proj-a', user_id: u.id, role: 'viewer' })
      const ids = getUserProjectIds(u.id)
      expect(ids).toContain('proj-a')
      expect(ids).not.toContain('proj-b')
    })

    it('getUserProjectRole returns null for non-member', () => {
      const u = createUser({ email: 'no-member@example.com', name: 'NoMember' })
      expect(getUserProjectRole(u.id, 'proj-a')).toBeNull()
    })

    it('delete project cascades to memberships', () => {
      // Create a throwaway project
      createProject({ id: 'proj-temp', name: 'proj-temp', slug: 'proj-temp', display_name: 'Temp' })
      const u = createUser({ email: 'temp-member@example.com', name: 'TempMember' })
      grantProjectMembership({ project_id: 'proj-temp', user_id: u.id, role: 'viewer' })
      expect(getUserProjectIds(u.id)).toContain('proj-temp')

      // Delete project using raw db to bypass any soft-delete guard
      db.prepare('DELETE FROM projects WHERE id = ?').run('proj-temp')
      expect(getUserProjectIds(u.id)).not.toContain('proj-temp')
    })
  })

  // ---------------------------------------------------------------------------
  // roleAtLeast
  // ---------------------------------------------------------------------------

  describe('roleAtLeast', () => {
    // All 9 combinations: 3 roles x 3 minimums
    it('viewer >= viewer', () => expect(roleAtLeast('viewer', 'viewer')).toBe(true))
    it('viewer < editor', () => expect(roleAtLeast('viewer', 'editor')).toBe(false))
    it('viewer < owner', () => expect(roleAtLeast('viewer', 'owner')).toBe(false))
    it('editor >= viewer', () => expect(roleAtLeast('editor', 'viewer')).toBe(true))
    it('editor >= editor', () => expect(roleAtLeast('editor', 'editor')).toBe(true))
    it('editor < owner', () => expect(roleAtLeast('editor', 'owner')).toBe(false))
    it('owner >= viewer', () => expect(roleAtLeast('owner', 'viewer')).toBe(true))
    it('owner >= editor', () => expect(roleAtLeast('owner', 'editor')).toBe(true))
    it('owner >= owner', () => expect(roleAtLeast('owner', 'owner')).toBe(true))
    it('null fails any minimum', () => {
      expect(roleAtLeast(null, 'viewer')).toBe(false)
      expect(roleAtLeast(null, 'editor')).toBe(false)
      expect(roleAtLeast(null, 'owner')).toBe(false)
    })
  })
})
