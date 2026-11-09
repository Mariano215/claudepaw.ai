// This file is a server-local copy of src/users.ts (the bot's user store).
// It must be kept in sync with that file manually.
// Rationale: the server is deployed independently to Hostinger (server/src/ only)
// so it cannot import from the bot's src/ tree at runtime.
import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GlobalRole = 'admin' | 'member' | 'bot'
export type ProjectRole = 'owner' | 'editor' | 'viewer'

export interface User {
  id: number
  email: string
  name: string
  global_role: GlobalRole
  created_at: number
  last_seen_at: number | null
}

export interface UserToken {
  id: number
  user_id: number
  token_hash: string
  label: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

export interface ProjectMembership {
  project_id: string
  user_id: number
  role: ProjectRole
  granted_by_user_id: number | null
  granted_at: number
}

// ---------------------------------------------------------------------------
// Module-level DB handle and cached prepared statements
// ---------------------------------------------------------------------------

let db: Database.Database

// All statements are cached at init time so the auth hot path never re-prepares.
let stmts: {
  insertUser: Database.Statement
  getUserById: Database.Statement
  getUserByEmail: Database.Statement
  listUsers: Database.Statement
  deleteUser: Database.Statement
  touchLastSeen: Database.Statement
  insertToken: Database.Statement
  getTokenById: Database.Statement
  listTokensByUser: Database.Statement
  revokeToken: Database.Statement
  resolveByHash: Database.Statement
  touchTokenLastUsed: Database.Statement
  touchUserLastSeenById: Database.Statement
  insertMember: Database.Statement
  deleteMember: Database.Statement
  listMembershipsByUser: Database.Statement
  listMembersByProject: Database.Statement
  getUserProjectIds: Database.Statement
  getUserProjectRole: Database.Statement
} | null = null

export function initUserStore(database: Database.Database): void {
  db = database
  stmts = {
    insertUser: db.prepare(
      `INSERT INTO users (email, name, global_role, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ),
    getUserById: db.prepare(
      `SELECT id, email, name, global_role, created_at, last_seen_at
       FROM users WHERE id = ?`,
    ),
    getUserByEmail: db.prepare(
      `SELECT id, email, name, global_role, created_at, last_seen_at
       FROM users WHERE email = ?`,
    ),
    listUsers: db.prepare(
      `SELECT id, email, name, global_role, created_at, last_seen_at
       FROM users ORDER BY id`,
    ),
    deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
    touchLastSeen: db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`),
    insertToken: db.prepare(
      `INSERT INTO user_tokens (user_id, token_hash, label, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    ),
    getTokenById: db.prepare(
      `SELECT id, user_id, token_hash, label, created_at, last_used_at, revoked_at
       FROM user_tokens WHERE id = ?`,
    ),
    listTokensByUser: db.prepare(
      `SELECT id, user_id, token_hash, label, created_at, last_used_at, revoked_at
       FROM user_tokens WHERE user_id = ? ORDER BY id`,
    ),
    revokeToken: db.prepare(`UPDATE user_tokens SET revoked_at = ? WHERE id = ?`),
    // SELECT is intentionally outside the transaction below -- better-sqlite3
    // is single-writer/single-connection so the read will always see the state
    // just before the write in the same thread without any isolation concerns.
    resolveByHash: db.prepare(
      `SELECT users.id, users.email, users.name, users.global_role,
              users.created_at, users.last_seen_at,
              user_tokens.id AS token_id
       FROM users
       JOIN user_tokens ON user_tokens.user_id = users.id
       WHERE user_tokens.token_hash = ? AND user_tokens.revoked_at IS NULL`,
    ),
    touchTokenLastUsed: db.prepare(
      `UPDATE user_tokens SET last_used_at = ? WHERE id = ?`,
    ),
    touchUserLastSeenById: db.prepare(
      `UPDATE users SET last_seen_at = ? WHERE id = ?`,
    ),
    insertMember: db.prepare(
      `INSERT INTO project_members (project_id, user_id, role, granted_by_user_id, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET
         role = excluded.role,
         granted_by_user_id = excluded.granted_by_user_id,
         granted_at = excluded.granted_at`,
    ),
    deleteMember: db.prepare(
      `DELETE FROM project_members WHERE project_id = ? AND user_id = ?`,
    ),
    listMembershipsByUser: db.prepare(
      `SELECT project_id, user_id, role, granted_by_user_id, granted_at
       FROM project_members WHERE user_id = ? ORDER BY granted_at`,
    ),
    listMembersByProject: db.prepare(
      `SELECT
         pm.project_id, pm.user_id, pm.role, pm.granted_by_user_id, pm.granted_at,
         u.id AS u_id, u.email, u.name, u.global_role, u.created_at, u.last_seen_at
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY pm.granted_at`,
    ),
    getUserProjectIds: db.prepare(
      `SELECT project_id FROM project_members WHERE user_id = ?`,
    ),
    getUserProjectRole: db.prepare(
      `SELECT role FROM project_members WHERE user_id = ? AND project_id = ?`,
    ),
  }
}

function getStmts() {
  if (!stmts) throw new Error('User store not initialized -- call initUserStore() first')
  return stmts
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function generateRawToken(): string {
  // 32 bytes -> base64url -> 43 chars (no padding)
  return randomBytes(32).toString('base64url')
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// Role ordering
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
}

export function roleAtLeast(role: ProjectRole | null, min: ProjectRole): boolean {
  if (role === null) return false
  return ROLE_RANK[role] >= ROLE_RANK[min]
}

// ---------------------------------------------------------------------------
// Allowed patch fields -- runtime whitelist guards against injection
// ---------------------------------------------------------------------------

const ALLOWED_PATCH_FIELDS = new Set(['name', 'email', 'global_role'])

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function createUser(opts: {
  email: string
  name: string
  global_role?: GlobalRole
}): User {
  const s = getStmts()
  const now = Date.now()
  const role: GlobalRole = opts.global_role ?? 'member'
  const email = normalizeEmail(opts.email)
  const result = s.insertUser.run(email, opts.name, role, now)
  return getUserById(result.lastInsertRowid as number)!
}

export function getUserById(id: number): User | null {
  const row = getStmts().getUserById.get(id) as User | undefined
  return row ?? null
}

export function getUserByEmail(email: string): User | null {
  const row = getStmts().getUserByEmail.get(normalizeEmail(email)) as User | undefined
  return row ?? null
}

export function listUsers(): User[] {
  return getStmts().listUsers.all() as User[]
}

export function updateUser(
  id: number,
  patch: Partial<Pick<User, 'name' | 'email' | 'global_role'>>,
): User {
  getStmts() // guard: throws clean sentinel if store not initialized
  // Whitelist fields at runtime to prevent SQL injection from unexpected keys.
  const fields = (Object.keys(patch) as Array<keyof typeof patch>).filter(f =>
    ALLOWED_PATCH_FIELDS.has(f as string),
  )

  if (fields.length === 0) {
    const existing = getUserById(id)
    if (!existing) throw new Error(`User ${id} not found`)
    return existing
  }

  const values = fields.map(f => {
    const v = patch[f]
    // Normalize email if it's part of the patch.
    return f === 'email' && typeof v === 'string' ? normalizeEmail(v) : v
  })

  const setClauses = fields.map(f => `${f} = ?`).join(', ')
  const result = db.prepare(`UPDATE users SET ${setClauses} WHERE id = ?`).run(...values, id)
  if (result.changes === 0) throw new Error(`User ${id} not found`)
  return getUserById(id)!
}

export function deleteUser(id: number): void {
  getStmts().deleteUser.run(id)
}

export function touchUserLastSeen(id: number, now?: number): void {
  getStmts().touchLastSeen.run(now ?? Date.now(), id)
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export function createUserToken(opts: {
  user_id: number
  label?: string
}): { token: string; record: UserToken } {
  const s = getStmts()
  const raw = generateRawToken()
  const hash = hashToken(raw)
  const now = Date.now()
  const label = opts.label ?? ''
  const result = s.insertToken.run(opts.user_id, hash, label, now)
  const record = getUserTokenById(result.lastInsertRowid as number)!
  return { token: raw, record }
}

/**
 * Insert a token row with a pre-computed hash. Used during auth bootstrap to
 * register the existing DASHBOARD_API_TOKEN hash without generating a new token.
 * Returns the inserted UserToken record.
 */
export function insertTokenHash(opts: {
  user_id: number
  token_hash: string
  label?: string
}): UserToken {
  const s = getStmts()
  const now = Date.now()
  const label = opts.label ?? ''
  const result = s.insertToken.run(opts.user_id, opts.token_hash, label, now)
  return getUserTokenById(result.lastInsertRowid as number)!
}

export function listUserTokens(user_id: number): UserToken[] {
  return getStmts().listTokensByUser.all(user_id) as UserToken[]
}

export function getUserTokenById(id: number): UserToken | null {
  const row = getStmts().getTokenById.get(id) as UserToken | undefined
  return row ?? null
}

export function revokeUserToken(id: number, now?: number): void {
  getStmts().revokeToken.run(now ?? Date.now(), id)
}

export function resolveUserByTokenHash(token_hash: string): User | null {
  const s = getStmts()
  const now = Date.now()

  // SELECT is outside the transaction -- see comment on resolveByHash statement above.
  const row = s.resolveByHash.get(token_hash) as (User & { token_id: number }) | undefined

  if (!row) return null

  const { token_id, ...user } = row

  db.transaction(() => {
    s.touchTokenLastUsed.run(now, token_id)
    s.touchUserLastSeenById.run(now, user.id)
  })()

  return { ...user, last_seen_at: now }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export function grantProjectMembership(opts: {
  project_id: string
  user_id: number
  role: ProjectRole
  granted_by_user_id?: number | null
}): ProjectMembership {
  const now = Date.now()
  const grantedBy = opts.granted_by_user_id ?? null
  getStmts().insertMember.run(opts.project_id, opts.user_id, opts.role, grantedBy, now)
  return {
    project_id: opts.project_id,
    user_id: opts.user_id,
    role: opts.role,
    granted_by_user_id: grantedBy,
    granted_at: now,
  }
}

export function revokeProjectMembership(project_id: string, user_id: number): void {
  getStmts().deleteMember.run(project_id, user_id)
}

export function listProjectMemberships(user_id: number): ProjectMembership[] {
  return getStmts().listMembershipsByUser.all(user_id) as ProjectMembership[]
}

export function listProjectMembers(
  project_id: string,
): Array<ProjectMembership & { user: User }> {
  const rows = getStmts().listMembersByProject.all(project_id) as Array<
    ProjectMembership & {
      u_id: number
      email: string
      name: string
      global_role: GlobalRole
      created_at: number
      last_seen_at: number | null
    }
  >

  return rows.map(row => {
    const { u_id, email, name, global_role, created_at, last_seen_at, ...membership } = row
    const user: User = { id: u_id, email, name, global_role, created_at, last_seen_at }
    return { ...membership, user }
  })
}

export function getUserProjectIds(user_id: number): string[] {
  const rows = getStmts().getUserProjectIds.all(user_id) as Array<{ project_id: string }>
  return rows.map(r => r.project_id)
}

export function getUserProjectRole(user_id: number, project_id: string): ProjectRole | null {
  const row = getStmts().getUserProjectRole.get(user_id, project_id) as
    | { role: ProjectRole }
    | undefined
  return row?.role ?? null
}

/**
 * Check whether a project_id exists in the projects table of the user store DB.
 * Used by admin routes to validate project_id before granting membership, so
 * that tests (which inject an in-memory DB) work without needing the bot DB.
 *
 * Keep in sync with isValidProjectId() in routes.ts -- both must validate against the same projects table shape.
 */
export function projectExistsInStore(project_id: string): boolean {
  getStmts() // guard: throws if not initialized
  const row = db.prepare(`SELECT id FROM projects WHERE id = ? LIMIT 1`).get(project_id)
  return row !== undefined
}
