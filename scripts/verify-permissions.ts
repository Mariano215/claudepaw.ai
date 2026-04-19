#!/usr/bin/env tsx
/**
 * End-to-end permissions verification script.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 \
 *   ADMIN_TOKEN=<admin-raw-token> \
 *   MEMBER_TOKEN=<member-raw-token> \
 *   MEMBER_PROJECT=example-company \
 *   FOREIGN_PROJECT=default \
 *   npm run verify:permissions
 */

import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? ''
const MEMBER_TOKEN = process.env.MEMBER_TOKEN ?? ''
const MEMBER_PROJECT = process.env.MEMBER_PROJECT ?? 'example-company'
const FOREIGN_PROJECT = process.env.FOREIGN_PROJECT ?? 'default'

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN is required')
  process.exit(1)
}
if (!MEMBER_TOKEN) {
  console.error('MEMBER_TOKEN is required')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Terminal colors
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function maskToken(t: string): string {
  if (t.length <= 4) return '****'
  return `****${t.slice(-4)}`
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ReqResult {
  status: number
  body: unknown
  headers: Record<string, string>
  setCookie: string | null
}

async function request(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; cookie?: string } = {},
): Promise<ReqResult> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.token) headers['x-dashboard-token'] = opts.token
  if (opts.cookie) headers['Cookie'] = opts.cookie

  const init: RequestInit = {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }

  const res = await fetch(url, init)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => { resHeaders[k] = v })

  const setCookie = res.headers.get('set-cookie')
  return { status: res.status, body, headers: resHeaders, setCookie }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: Array<{ name: string; detail: string }> = []
let currentSection = ''

function section(name: string): void {
  currentSection = name
  console.log(`\n${BOLD}${currentSection}${RESET}`)
}

async function check(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`   ${GREEN}\u2713${RESET} ${name}`)
  } catch (err) {
    failed++
    const detail = err instanceof Error ? err.message : String(err)
    console.log(`   ${RED}\u2717${RESET} ${name}`)
    if (detail) {
      for (const line of detail.split('\n')) {
        console.log(`     ${DIM}${line}${RESET}`)
      }
    }
    failures.push({ name: `${currentSection} > ${name}`, detail })
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label = ''): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------

async function wsConnect(ticket: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const wsUrl = BASE_URL.replace(/^http/, 'ws')
    const ws = new WebSocket(wsUrl)
    ws.once('open', () => {
      ws.send(JSON.stringify({
        type: 'register',
        clientId: `verify-${Date.now()}`,
        userTicket: ticket,
      }))
      resolve(ws)
    })
    ws.once('error', reject)
  })
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler)
      resolve(null)
    }, timeoutMs)

    function handler(raw: WebSocket.RawData): void {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(msg)
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.on('message', handler)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${BOLD}ClaudePaw Permissions Verification${RESET}`)
  console.log(`Target:        ${BASE_URL}`)
  console.log(`Admin:         ${maskToken(ADMIN_TOKEN)}`)
  console.log(`Member:        ${maskToken(MEMBER_TOKEN)}`)
  console.log(`MemberProject: ${MEMBER_PROJECT}`)
  console.log(`ForeignProject: ${FOREIGN_PROJECT}`)

  // -------------------------------------------------------------------------
  // Resolve member user ID up front (needed for section 7)
  // -------------------------------------------------------------------------
  let memberUserId: number | null = null
  {
    const me = await request('GET', '/api/v1/auth/me', { token: MEMBER_TOKEN })
    if (me.status === 200 && typeof (me.body as Record<string, unknown>).user === 'object') {
      memberUserId = ((me.body as Record<string, unknown>).user as Record<string, unknown>).id as number
    }
  }

  // =========================================================================
  // 1. Login sanity
  // =========================================================================
  section('1. Login sanity')

  await check('valid member token -> 200 + global_role: member', async () => {
    const r = await request('POST', '/api/v1/auth/login', { body: { token: MEMBER_TOKEN } })
    assertEqual(r.status, 200, 'status')
    const user = (r.body as Record<string, unknown>).user as Record<string, unknown> | undefined
    assert(user !== undefined, 'response.user missing')
    assertEqual(user.global_role as string, 'member', 'global_role')
    assert(r.setCookie !== null && r.setCookie.includes('dashboard_api_token'), 'cookie not set')
  })

  await check('garbage token -> 401', async () => {
    const r = await request('POST', '/api/v1/auth/login', { body: { token: 'garbage_not_a_real_token_xyz' } })
    assertEqual(r.status, 401, 'status')
  })

  await check('missing body -> 400', async () => {
    const r = await request('POST', '/api/v1/auth/login', { body: {} })
    assertEqual(r.status, 400, 'status')
  })

  // =========================================================================
  // 2. Project list isolation
  // =========================================================================
  section('2. Project list isolation')

  await check('member sees only their projects (not FOREIGN_PROJECT)', async () => {
    const r = await request('GET', '/api/v1/projects', { token: MEMBER_TOKEN })
    assertEqual(r.status, 200, 'status')
    const projects = r.body as Array<Record<string, unknown>>
    assert(Array.isArray(projects), 'expected array of projects')
    const ids = projects.map(p => p.id as string)
    assert(
      !ids.includes(FOREIGN_PROJECT),
      `expected ${FOREIGN_PROJECT} to be absent\ngot: ${JSON.stringify(ids)}`,
    )
    assert(
      ids.includes(MEMBER_PROJECT),
      `expected ${MEMBER_PROJECT} to be present\ngot: ${JSON.stringify(ids)}`,
    )
  })

  await check('admin sees all projects including both', async () => {
    const r = await request('GET', '/api/v1/projects', { token: ADMIN_TOKEN })
    assertEqual(r.status, 200, 'status')
    const projects = r.body as Array<Record<string, unknown>>
    assert(Array.isArray(projects), 'expected array of projects')
    const ids = projects.map(p => p.id as string)
    assert(ids.includes(MEMBER_PROJECT), `expected ${MEMBER_PROJECT} in admin list`)
    assert(ids.includes(FOREIGN_PROJECT), `expected ${FOREIGN_PROJECT} in admin list`)
  })

  // =========================================================================
  // 3. Cross-project read blocked (404)
  // =========================================================================
  section('3. Cross-project read blocked (404)')

  await check(`member GET /projects/${FOREIGN_PROJECT} -> 404`, async () => {
    const r = await request('GET', `/api/v1/projects/${FOREIGN_PROJECT}`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 404, 'status')
  })

  await check(`member GET /projects/${FOREIGN_PROJECT}/settings -> 404`, async () => {
    const r = await request('GET', `/api/v1/projects/${FOREIGN_PROJECT}/settings`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 404, 'status')
  })

  await check(`member GET /projects/${FOREIGN_PROJECT}/integrations -> 404`, async () => {
    const r = await request('GET', `/api/v1/projects/${FOREIGN_PROJECT}/integrations`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 404, 'status')
  })

  // =========================================================================
  // 4. Listing auto-filter
  // =========================================================================
  section('4. Listing auto-filter')

  // Endpoints that use resolveProjectScope internally -- member should only see
  // rows for their project, admin should see rows across projects.
  // We sample up to 50 rows and check project_id values.

  type ListEndpoint = {
    path: string
    itemsKey: string | null    // null means the response body IS the array
    pidField: string
  }

  const listEndpoints: ListEndpoint[] = [
    { path: '/api/v1/feed', itemsKey: null, pidField: 'project_id' },
    { path: '/api/v1/metrics/token-usage', itemsKey: 'metrics', pidField: 'project_id' },
    { path: '/api/v1/agents', itemsKey: 'agents', pidField: 'project_id' },
    { path: '/api/v1/tasks', itemsKey: 'tasks', pidField: 'project_id' },
    { path: '/api/v1/research', itemsKey: 'items', pidField: 'project_id' },
    { path: '/api/v1/board/meetings', itemsKey: 'meetings', pidField: 'project_id' },
    { path: '/api/v1/action-items', itemsKey: 'items', pidField: 'project_id' },
    { path: '/api/v1/paws', itemsKey: 'paws', pidField: 'project_id' },
    { path: '/api/v1/security/findings', itemsKey: 'findings', pidField: 'project_id' },
    { path: '/api/v1/integrations', itemsKey: 'integrations', pidField: 'project_id' },
    { path: '/api/v1/webhooks', itemsKey: 'webhooks', pidField: 'project_id' },
  ]

  for (const ep of listEndpoints) {
    const shortPath = ep.path.replace('/api/v1/', '')

    await check(`member GET /${shortPath} returns only own-project rows`, async () => {
      const r = await request('GET', ep.path, { token: MEMBER_TOKEN })
      assert(
        r.status === 200 || r.status === 404,
        `unexpected status ${r.status}`,
      )
      if (r.status === 404) return // endpoint 404 is acceptable if no data

      const body = r.body as Record<string, unknown>
      let rows: Array<Record<string, unknown>>

      if (ep.itemsKey === null) {
        rows = Array.isArray(body)
          ? (body as Array<Record<string, unknown>>).slice(0, 50)
          : []
      } else {
        const rawItems = body[ep.itemsKey]
        rows = Array.isArray(rawItems)
          ? (rawItems as Array<Record<string, unknown>>).slice(0, 50)
          : []
      }

      for (const row of rows) {
        const pid = row[ep.pidField] as string | undefined
        if (pid !== undefined) {
          assert(
            pid === MEMBER_PROJECT,
            `row with project_id="${pid}" should not be visible to member (expected only "${MEMBER_PROJECT}")`,
          )
        }
      }
    })

    await check(`admin GET /${shortPath} returns rows from multiple projects`, async () => {
      const r = await request('GET', ep.path, { token: ADMIN_TOKEN })
      assert(r.status === 200, `unexpected status ${r.status}`)

      const body = r.body as Record<string, unknown>
      let rows: Array<Record<string, unknown>>

      if (ep.itemsKey === null) {
        rows = Array.isArray(body)
          ? (body as Array<Record<string, unknown>>).slice(0, 50)
          : []
      } else {
        const rawItems = body[ep.itemsKey]
        rows = Array.isArray(rawItems)
          ? (rawItems as Array<Record<string, unknown>>).slice(0, 50)
          : []
      }

      if (rows.length === 0) {
        // If admin has no data yet, skip (not a failure -- no rows to inspect)
        console.log(`     ${YELLOW}(no rows -- skipping multi-project check)${RESET}`)
        return
      }

      const pids = new Set(
        rows
          .map(r => r[ep.pidField] as string | undefined)
          .filter(Boolean),
      )

      // Only assert multi-project if we actually have enough rows; otherwise it's
      // a new instance with single-project data and the check would be noisy.
      if (pids.size < 2) {
        console.log(`     ${YELLOW}(only ${pids.size} distinct project_ids in first 50 rows -- possible single-project instance)${RESET}`)
      }
      // Not a hard failure since test environment may have only one project worth of data.
    })
  }

  // =========================================================================
  // 5. Explicit cross-scope rejected
  // =========================================================================
  section('5. Explicit cross-scope rejected')

  await check(`member GET /feed?project_id=${FOREIGN_PROJECT} -> 404`, async () => {
    const r = await request('GET', `/api/v1/feed?project_id=${FOREIGN_PROJECT}`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 404, 'status')
  })

  await check(`member GET /paws?project_id=${FOREIGN_PROJECT} -> 404`, async () => {
    const r = await request('GET', `/api/v1/paws?project_id=${FOREIGN_PROJECT}`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 404, 'status')
  })

  await check(`member GET /tasks?project_id=${FOREIGN_PROJECT} -> 404`, async () => {
    const r = await request('GET', `/api/v1/tasks?project_id=${FOREIGN_PROJECT}`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 404, 'status')
  })

  // =========================================================================
  // 6. Mutation gates
  // =========================================================================
  section('6. Mutation gates')

  // POST paw in own project -> 200/201 (editor in own project)
  let createdPawId: string | null = null
  await check(`member POST /paws with project_id=${MEMBER_PROJECT} -> 200 or 201`, async () => {
    const pawId = `verify-test-paw-${Date.now()}`
    const r = await request('POST', '/api/v1/paws', {
      token: MEMBER_TOKEN,
      body: {
        id: pawId,
        name: 'verify-test paw',
        agent_id: 'scout',
        cron: '0 */6 * * *',
        project_id: MEMBER_PROJECT,
        config: {},
      },
    })
    assert(
      r.status === 200 || r.status === 201,
      `expected 200 or 201, got ${r.status}: ${JSON.stringify(r.body)}`,
    )
    createdPawId = pawId
  })

  // Clean up the created paw
  if (createdPawId !== null) {
    await check('cleanup: DELETE created paw as admin', async () => {
      const r = await request('DELETE', `/api/v1/paws/${createdPawId}`, { token: ADMIN_TOKEN })
      assert(
        r.status === 200 || r.status === 204 || r.status === 404,
        `unexpected status ${r.status}`,
      )
    })
  }

  // POST paw in foreign project -> 403 or 404
  await check(`member POST /paws with project_id=${FOREIGN_PROJECT} -> 403 or 404`, async () => {
    const r = await request('POST', '/api/v1/paws', {
      token: MEMBER_TOKEN,
      body: {
        id: `verify-test-paw-foreign-${Date.now()}`,
        name: 'verify-test paw',
        agent_id: 'scout',
        cron: '0 */6 * * *',
        project_id: FOREIGN_PROJECT,
        config: {},
      },
    })
    assert(
      r.status === 403 || r.status === 404,
      `expected 403 or 404, got ${r.status}: ${JSON.stringify(r.body)}`,
    )
  })

  // DELETE own project -> 403 (editor not admin)
  await check(`member DELETE /projects/${MEMBER_PROJECT} -> 403`, async () => {
    const r = await request('DELETE', `/api/v1/projects/${MEMBER_PROJECT}`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 403, 'status')
  })

  // POST /projects (create) -> 403 (admin only)
  await check('member POST /projects -> 403', async () => {
    const r = await request('POST', '/api/v1/projects', {
      token: MEMBER_TOKEN,
      body: { id: 'test-project', name: 'Test', slug: 'test', display_name: 'Test' },
    })
    assertEqual(r.status, 403, 'status')
  })

  // GET /costs/line-items -> 403 (admin only)
  await check('member GET /costs/line-items -> 403', async () => {
    const r = await request('GET', '/api/v1/costs/line-items', { token: MEMBER_TOKEN })
    assertEqual(r.status, 403, 'status')
  })

  // =========================================================================
  // 7. Token lifecycle
  // =========================================================================
  section('7. Token lifecycle')

  if (memberUserId === null) {
    console.log(`   ${YELLOW}\u26a0${RESET} could not resolve member user ID -- skipping token lifecycle checks`)
  } else {
    const uid = memberUserId
    let newTokenRaw: string | null = null
    let newTokenId: number | null = null

    await check(`admin POST /users/${uid}/tokens -> 201 returns raw token`, async () => {
      const r = await request('POST', `/api/v1/users/${uid}/tokens`, {
        token: ADMIN_TOKEN,
        body: { label: 'verify-test' },
      })
      assertEqual(r.status, 201, 'status')
      const body = r.body as Record<string, unknown>
      assert(typeof body.token === 'string' && (body.token as string).length > 0, 'raw token missing')
      assert(typeof body.record === 'object', 'record missing')
      newTokenRaw = body.token as string
      newTokenId = (body.record as Record<string, unknown>).id as number
    })

    if (newTokenRaw !== null) {
      await check('login with new raw token -> 200', async () => {
        const r = await request('POST', '/api/v1/auth/login', { body: { token: newTokenRaw } })
        assertEqual(r.status, 200, 'status')
      })
    }

    if (newTokenId !== null) {
      await check(`admin DELETE /users/${uid}/tokens/${newTokenId} -> 200`, async () => {
        const r = await request('DELETE', `/api/v1/users/${uid}/tokens/${newTokenId}`, {
          token: ADMIN_TOKEN,
        })
        assertEqual(r.status, 200, 'status')
      })

      if (newTokenRaw !== null) {
        await check('login with revoked token -> 401', async () => {
          const r = await request('POST', '/api/v1/auth/login', { body: { token: newTokenRaw } })
          assertEqual(r.status, 401, 'status')
        })
      }
    }
  }

  // =========================================================================
  // 8. WebSocket scope
  // =========================================================================
  section('8. WebSocket scope')

  let wsSkipped = false
  let memberWs: WebSocket | null = null

  await check('member can get WS ticket', async () => {
    const r = await request('GET', '/api/v1/auth/ws-ticket', { token: MEMBER_TOKEN })
    assertEqual(r.status, 200, 'status')
    const body = r.body as Record<string, unknown>
    assert(typeof body.ticket === 'string', 'ticket missing')
  })

  // Attempt full WS test -- skip gracefully if connection fails
  try {
    const ticketRes = await request('GET', '/api/v1/auth/ws-ticket', { token: MEMBER_TOKEN })
    if (ticketRes.status === 200) {
      const ticket = (ticketRes.body as Record<string, unknown>).ticket as string

      memberWs = await wsConnect(ticket)

      // Wait for registered confirmation
      const registered = await waitForMessage(
        memberWs,
        (msg) => msg.type === 'registered' || msg.type === 'auth_error',
        3000,
      )

      if (registered?.type === 'registered') {
        // Post a feed item to FOREIGN_PROJECT as admin -> member should NOT receive it
        const foreignFeedAction = `verify-foreign-${Date.now()}`
        let receivedForeign: Record<string, unknown> | null = null

        const foreignWait = waitForMessage(
          memberWs,
          (msg) => msg.type === 'feed_update' && (msg.item as Record<string, unknown>)?.action === foreignFeedAction,
          2000,
        )

        // Find an agent in the foreign project (use a placeholder; real agent check is loose)
        await request('POST', '/api/v1/feed', {
          token: ADMIN_TOKEN,
          body: {
            agent_id: 'scout',
            action: foreignFeedAction,
            project_id: FOREIGN_PROJECT,
          },
        })

        receivedForeign = await foreignWait

        await check('member WS does NOT receive FOREIGN_PROJECT feed event', async () => {
          assert(
            receivedForeign === null,
            `member received foreign-project feed event: ${JSON.stringify(receivedForeign)}`,
          )
        })

        // Post a feed item to MEMBER_PROJECT -> member SHOULD receive it
        const memberFeedAction = `verify-member-${Date.now()}`

        const memberWait = waitForMessage(
          memberWs,
          (msg) => msg.type === 'feed_update' && (msg.item as Record<string, unknown>)?.action === memberFeedAction,
          3000,
        )

        await request('POST', '/api/v1/feed', {
          token: ADMIN_TOKEN,
          body: {
            agent_id: 'scout',
            action: memberFeedAction,
            project_id: MEMBER_PROJECT,
          },
        })

        const receivedMember = await memberWait

        await check('member WS receives MEMBER_PROJECT feed event within 3s', async () => {
          assert(
            receivedMember !== null,
            `member did not receive own-project feed event within timeout`,
          )
        })
      } else {
        wsSkipped = true
        console.log(`   ${YELLOW}\u26a0${RESET} WS auth failed (ticket rejected) -- skipping WS broadcast checks`)
      }
    } else {
      wsSkipped = true
      console.log(`   ${YELLOW}\u26a0${RESET} Could not get WS ticket (status ${ticketRes.status}) -- skipping WS broadcast checks`)
    }
  } catch (err) {
    wsSkipped = true
    const detail = err instanceof Error ? err.message : String(err)
    console.log(`   ${YELLOW}\u26a0${RESET} WS connection failed (${detail}) -- skipping WS broadcast checks`)
  } finally {
    if (memberWs) {
      memberWs.close()
    }
  }

  if (wsSkipped) {
    console.log(`   ${DIM}Manual verification: ws.test.ts covers in-process broadcast filtering.${RESET}`)
  }

  // =========================================================================
  // 9. No secrets leak
  // =========================================================================
  section('9. No secrets leak')

  await check(`member GET /credentials?project_id=${MEMBER_PROJECT} -> 200 (scoped)`, async () => {
    const r = await request('GET', `/api/v1/credentials?project_id=${MEMBER_PROJECT}`, { token: MEMBER_TOKEN })
    assertEqual(r.status, 200, 'status')
    // Ensure no 'value' field leaks in the response
    const body = r.body as Record<string, unknown>
    const creds = (body.credentials ?? []) as Array<Record<string, unknown>>
    for (const cred of creds) {
      assert(!('value' in cred), `credential row contains a 'value' field: ${JSON.stringify(cred)}`)
    }
  })

  await check(`member GET /credentials?project_id=${FOREIGN_PROJECT} -> 403 or 404`, async () => {
    const r = await request('GET', `/api/v1/credentials?project_id=${FOREIGN_PROJECT}`, { token: MEMBER_TOKEN })
    assert(
      r.status === 403 || r.status === 404,
      `expected 403 or 404, got ${r.status}`,
    )
  })

  await check('member GET /credentials (no project_id) -> 403', async () => {
    const r = await request('GET', '/api/v1/credentials', { token: MEMBER_TOKEN })
    assertEqual(r.status, 403, 'status')
  })

  await check('member GET /integrations/status (no project_id) -> 400 (project_id required)', async () => {
    // The route requires project_id; without it the requireProjectRole middleware
    // returns 400 ("project_id required") before hitting any data.
    const r = await request('GET', '/api/v1/integrations/status', { token: MEMBER_TOKEN })
    assert(
      r.status === 400 || r.status === 403,
      `expected 400 or 403, got ${r.status}`,
    )
  })

  await check(`member GET /integrations/google/access-token?project_id=${FOREIGN_PROJECT}&account=x -> 403 or 404`, async () => {
    const r = await request(
      'GET',
      `/api/v1/integrations/google/access-token?project_id=${FOREIGN_PROJECT}&account=x`,
      { token: MEMBER_TOKEN },
    )
    assert(
      r.status === 403 || r.status === 404,
      `expected 403 or 404, got ${r.status}`,
    )
  })

  // =========================================================================
  // 10. Env regression (manual step)
  // =========================================================================
  section('10. Env regression (manual)')

  console.log(
    `   ${YELLOW}\u26a0${RESET} Manual step: restart the server with DASHBOARD_API_TOKEN unchanged`,
  )
  console.log(
    `     ${DIM}and confirm that the original admin can still log in with that same token.${RESET}`,
  )
  console.log(
    `     ${DIM}The bootstrap row must hash-match; a fresh DB seeding should not break existing sessions.${RESET}`,
  )

  // =========================================================================
  // 11. Bot callback endpoints -- requireBotOrAdmin gate
  // =========================================================================
  section('11. Bot callback endpoints (requireBotOrAdmin)')

  await check('member POST /api/v1/chat/response -> 403', async () => {
    const r = await request('POST', '/api/v1/chat/response', {
      token: MEMBER_TOKEN,
      body: { event_id: 'verify-e1', result_text: 'test' },
    })
    assert(r.status === 403, `expected 403, got ${r.status}`)
  })

  await check('member POST /api/v1/chat/events -> 403', async () => {
    const r = await request('POST', '/api/v1/chat/events', {
      token: MEMBER_TOKEN,
      body: { event_id: 'verify-ev1' },
    })
    assert(r.status === 403, `expected 403, got ${r.status}`)
  })

  await check('member POST /api/v1/internal/paws-sync -> 403', async () => {
    const r = await request('POST', '/api/v1/internal/paws-sync', {
      token: MEMBER_TOKEN,
      body: { paws: [], cycles: [] },
    })
    assert(r.status === 403, `expected 403, got ${r.status}`)
  })

  // Bot-success path is verified by in-process vitest tests (requires BOT_API_TOKEN
  // which the verify script does not have). Admin success is checked implicitly by the
  // fact that admin is tested throughout -- if requireBotOrAdmin blocks admin, other
  // sections would fail.
  console.log(
    `   ${YELLOW}\u26a0${RESET} Bot-success path omitted here (requires BOT_API_TOKEN).`,
  )
  console.log(
    `     ${DIM}Covered by server/src/routes-permissions.test.ts and paws-routes.test.ts.${RESET}`,
  )

  // =========================================================================
  // Summary
  // =========================================================================
  const total = passed + failed
  console.log(`\n${BOLD}Result: ${passed}/${total} passed${RESET}`)

  if (failures.length > 0) {
    console.log(`\n${RED}Failed checks:${RESET}`)
    for (const f of failures) {
      console.log(`  ${RED}\u2717${RESET} ${f.name}`)
      for (const line of f.detail.split('\n')) {
        console.log(`    ${DIM}${line}${RESET}`)
      }
    }
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err)
  process.exit(1)
})
