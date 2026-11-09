import type { Express, Request, Response } from 'express'
import {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  listUserTokens,
  getUserTokenById,
  createUserToken,
  revokeUserToken,
  grantProjectMembership,
  revokeProjectMembership,
  listProjectMemberships,
  projectExistsInStore,
  type GlobalRole,
  type ProjectRole,
} from './users.js'
import { requireAdmin } from './auth.js'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// 'bot' is intentionally excluded here -- admin UI cannot create bot users.
// Bot users are seeded exclusively via BOT_API_TOKEN in ensureAuthBootstrap.
const VALID_GLOBAL_ROLES: readonly GlobalRole[] = ['admin', 'member']
const VALID_PROJECT_ROLES: readonly ProjectRole[] = ['owner', 'editor', 'viewer']

function isValidGlobalRole(v: unknown): v is GlobalRole {
  return typeof v === 'string' && (VALID_GLOBAL_ROLES as string[]).includes(v)
}

function isValidProjectRole(v: unknown): v is ProjectRole {
  return typeof v === 'string' && (VALID_PROJECT_ROLES as string[]).includes(v)
}

function isValidEmail(v: unknown): v is string {
  return typeof v === 'string' && v.includes('@') && v.trim().length > 0
}

/** Whether a SQLite error is a UNIQUE constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Error &&
    /UNIQUE constraint failed/i.test(err.message)
  )
}

/** Strip token_hash from a UserToken before sending to the client. */
function safeToken(t: {
  id: number
  user_id: number
  token_hash: string
  label: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}): Omit<typeof t, 'token_hash'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { token_hash, ...safe } = t
  return safe
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountUsersRoutes(app: Express): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/users
  // -------------------------------------------------------------------------
  app.get('/api/v1/users', requireAdmin, (_req: Request, res: Response): void => {
    const users = listUsers()
    const result = users.map(u => ({
      ...u,
      memberships: listProjectMemberships(u.id),
    }))
    res.json({ users: result, total: result.length })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/users
  // -------------------------------------------------------------------------
  app.post('/api/v1/users', requireAdmin, (req: Request, res: Response): void => {
    const { email, name, global_role } = req.body as Record<string, unknown>

    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'email is required and must contain @' })
      return
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const role: GlobalRole =
      global_role === undefined ? 'member' : isValidGlobalRole(global_role) ? global_role : '__invalid__' as GlobalRole

    if (!VALID_GLOBAL_ROLES.includes(role)) {
      res.status(400).json({ error: `global_role must be one of: ${VALID_GLOBAL_ROLES.join(', ')}` })
      return
    }

    try {
      const user = createUser({ email: email.trim(), name: name.trim(), global_role: role })
      res.status(201).json({ user })
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(400).json({ error: 'A user with that email already exists' })
        return
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/users/:id
  // -------------------------------------------------------------------------
  app.get('/api/v1/users/:id', requireAdmin, (req: Request, res: Response): void => {
    const id = parseInt(req.params["id"] as string, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user id' })
      return
    }
    const user = getUserById(id)
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    const memberships = listProjectMemberships(id)
    res.json({ user: { ...user, memberships } })
  })

  // -------------------------------------------------------------------------
  // PATCH /api/v1/users/:id
  // -------------------------------------------------------------------------
  app.patch('/api/v1/users/:id', requireAdmin, (req: Request, res: Response): void => {
    const id = parseInt(req.params["id"] as string, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user id' })
      return
    }

    const { email, name, global_role } = req.body as Record<string, unknown>
    const patch: Partial<{ email: string; name: string; global_role: GlobalRole }> = {}

    if (email !== undefined) {
      if (!isValidEmail(email)) {
        res.status(400).json({ error: 'email must contain @' })
        return
      }
      patch.email = (email as string).trim()
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'name must be a non-empty string' })
        return
      }
      patch.name = name.trim()
    }
    if (global_role !== undefined) {
      if (!isValidGlobalRole(global_role)) {
        res.status(400).json({ error: `global_role must be one of: ${VALID_GLOBAL_ROLES.join(', ')}` })
        return
      }
      patch.global_role = global_role
    }

    // Bot users cannot be edited via the API -- they are system accounts.
    const targetForPatch = getUserById(id)
    if (targetForPatch?.global_role === 'bot') {
      res.status(400).json({ error: 'Bot user cannot be modified via the API' })
      return
    }

    // Prevent demoting the last admin -- check before the DB write.
    if (patch.global_role === 'member') {
      const target = getUserById(id)
      if (target && target.global_role === 'admin') {
        const adminCount = listUsers().filter(u => u.global_role === 'admin').length
        if (adminCount <= 1) {
          res.status(400).json({ error: 'Cannot demote the last admin' })
          return
        }
      }
    }

    try {
      const user = updateUser(id, patch)
      res.json({ user })
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: 'User not found' })
        return
      }
      if (isUniqueViolation(err)) {
        res.status(400).json({ error: 'A user with that email already exists' })
        return
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // DELETE /api/v1/users/:id
  // -------------------------------------------------------------------------
  app.delete('/api/v1/users/:id', requireAdmin, (req: Request, res: Response): void => {
    const id = parseInt(req.params["id"] as string, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user id' })
      return
    }

    if (req.user!.id === id) {
      res.status(400).json({ error: 'Cannot delete your own account' })
      return
    }

    const target = getUserById(id)
    if (!target) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    // Bot users are system accounts -- they cannot be deleted via the API.
    if (target.global_role === 'bot') {
      res.status(400).json({ error: 'Bot user cannot be deleted via the API' })
      return
    }

    // Prevent deleting the last admin.
    if (target.global_role === 'admin') {
      const allUsers = listUsers()
      const adminCount = allUsers.filter(u => u.global_role === 'admin').length
      if (adminCount <= 1) {
        res.status(400).json({ error: 'Cannot delete the last admin user' })
        return
      }
    }

    deleteUser(id)
    res.json({ deleted: true })
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/users/:id/tokens
  // -------------------------------------------------------------------------
  app.get('/api/v1/users/:id/tokens', requireAdmin, (req: Request, res: Response): void => {
    const id = parseInt(req.params["id"] as string, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user id' })
      return
    }
    if (!getUserById(id)) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    const tokens = listUserTokens(id).map(safeToken)
    res.json({ tokens })
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/users/:id/tokens
  // -------------------------------------------------------------------------
  app.post('/api/v1/users/:id/tokens', requireAdmin, (req: Request, res: Response): void => {
    const id = parseInt(req.params["id"] as string, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user id' })
      return
    }
    if (!getUserById(id)) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const { label } = req.body as { label?: unknown }
    const labelStr = typeof label === 'string' ? label.trim() : ''

    const { token: rawToken, record } = createUserToken({ user_id: id, label: labelStr })

    logger.info(
      { userId: id, tokenId: record.id, label: record.label },
      'Issued new API token',
    )

    res.status(201).json({ token: rawToken, record: safeToken(record) })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/v1/users/:id/tokens/:tokenId
  // -------------------------------------------------------------------------
  app.delete(
    '/api/v1/users/:id/tokens/:tokenId',
    requireAdmin,
    (req: Request, res: Response): void => {
      const userId = parseInt(req.params["id"] as string, 10)
      const tokenId = parseInt(req.params["tokenId"] as string, 10)
      if (isNaN(userId) || isNaN(tokenId)) {
        res.status(400).json({ error: 'Invalid id' })
        return
      }

      const token = getUserTokenById(tokenId)
      if (!token || token.user_id !== userId) {
        res.status(404).json({ error: 'Token not found' })
        return
      }

      revokeUserToken(tokenId)
      res.json({ revoked: true })
    },
  )

  // -------------------------------------------------------------------------
  // POST /api/v1/users/:id/memberships
  // -------------------------------------------------------------------------
  app.post('/api/v1/users/:id/memberships', requireAdmin, (req: Request, res: Response): void => {
    const userId = parseInt(req.params["id"] as string, 10)
    if (isNaN(userId)) {
      res.status(400).json({ error: 'Invalid user id' })
      return
    }

    if (!getUserById(userId)) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const { project_id, role } = req.body as Record<string, unknown>

    if (typeof project_id !== 'string' || project_id.trim().length === 0) {
      res.status(400).json({ error: 'project_id is required' })
      return
    }
    if (!isValidProjectRole(role)) {
      res.status(400).json({ error: `role must be one of: ${VALID_PROJECT_ROLES.join(', ')}` })
      return
    }

    // Validate the project actually exists.
    if (!projectExistsInStore(project_id.trim())) {
      res.status(400).json({ error: 'Project not found' })
      return
    }

    const membership = grantProjectMembership({
      project_id: project_id.trim(),
      user_id: userId,
      role,
      granted_by_user_id: req.user!.id,
    })

    res.status(201).json({ membership })
  })

  // -------------------------------------------------------------------------
  // DELETE /api/v1/users/:id/memberships/:projectId
  // -------------------------------------------------------------------------
  app.delete(
    '/api/v1/users/:id/memberships/:projectId',
    requireAdmin,
    (req: Request, res: Response): void => {
      const userId = parseInt(req.params["id"] as string, 10)
      if (isNaN(userId)) {
        res.status(400).json({ error: 'Invalid user id' })
        return
      }

      const projectId = req.params["projectId"] as string

      // Check the membership actually exists before revoking.
      const memberships = listProjectMemberships(userId)
      const exists = memberships.some(m => m.project_id === projectId)
      if (!exists) {
        res.status(404).json({ error: 'Membership not found' })
        return
      }

      revokeProjectMembership(projectId, userId)
      res.json({ revoked: true })
    },
  )
}
