// SDK-level tool permissions, replacing permissionMode 'bypassPermissions'.
//
// Before this, every claude_desktop run had the operator's full authority:
// bypass permissions, the repo as cwd, and the bot's whole env
// (.reviews/loop1-autonomy.md, primitive 05, CRITICAL).
//
// Per ruling B7: keep the SDK's built-in preset (all default Claude Code
// tools) instead of shipping a narrow custom default. A soul's `tools:`
// frontmatter, when present, becomes a disallowedTools list computed as the
// complement of the soul's wanted tools against ALL_BUILTIN_TOOLS.
//
// Fix round 3: `canUseTool` alone is not the real enforcement point. Live
// smokes in fix round 2 proved the native Claude Code CLI never sends a
// can_use_tool control request for Read, Grep or Glob under
// permissionMode 'default' at all (it classifies them as safe and skips the
// permission system entirely), so any deny logic living only inside
// canUseTool is dead code for those three tools. A `PreToolUse` hook fires
// for every tool call regardless of the CLI's own danger classification
// (sdk.d.ts:3200 notes hook denies "bypass canUseTool"), so it is the actual
// gate now. `gateToolCall` holds all the policy (Bash allowlist plus the
// file-tool path guard) as one pure function; both the `PreToolUse` hook and
// `canUseTool` call it, so the two enforcement paths cannot disagree.
// Logging and `recordError` go through `logGateDenial`, which dedupes on a
// short-lived key (see `recentDenials`), so a Bash call that the hook denies
// and canUseTool then denies again (its own defense-in-depth check) is
// logged and recorded once, not twice.
//
// Fix round 2, Critical 3: Write, Edit, MultiEdit and NotebookEdit are
// denied by default for every soul (least privilege, spec 4.5), because the
// Bash exec arms (node dist/<cli>.js, scripts/*-wrapper.sh) point at files
// those tools could otherwise overwrite in place, turning an "allowed
// command" into arbitrary code execution with the bot's env and cwd. A soul
// opts back in per tool by naming it in its own tools: frontmatter. No soul
// does today; the Phase 3 builder soul will. mcp__* tools are always allowed
// with no prompt: an installed integration is operator-approved on the
// Integrations page, so it is treated the same as a first-party tool, not
// gated per call.
import { readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  CanUseTool,
  PermissionResult,
  HookCallback,
  HookCallbackMatcher,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CWD, PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'
import { recordError } from './telemetry.js'

/**
 * Builtin tool names the Claude Agent SDK ships (see the preset comment in
 * node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts). Used only to compute
 * disallowedTools for a soul that restricts its own tools: frontmatter.
 * ponytail: hand-maintained; update if the SDK adds a builtin tool that a
 * soul might also want to exclude.
 */
export const ALL_BUILTIN_TOOLS = [
  'Task', 'Bash', 'Glob', 'Grep', 'ExitPlanMode', 'Read', 'Edit', 'Write',
  'NotebookEdit', 'WebFetch', 'TodoWrite', 'WebSearch', 'Skill',
]

// Denied by default for every soul; see the Critical 3 comment above.
// MultiEdit is not in ALL_BUILTIN_TOOLS (it does not appear as a distinct
// tool name in this SDK version), so it is listed here directly rather than
// relying on the ALL_BUILTIN_TOOLS complement.
const DEFAULT_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

// Round 4 addendum 2, item 6: WebFetch and WebSearch are an open egress path
// (any URL, no allowlist, auto-approved by the CLI's own classifier), so they
// join the write tools in the default-deny set. A soul opts either back in by
// naming it in its tools: frontmatter. mcp__* tools are unaffected: an
// installed integration is operator-approved on the Integrations page.
const DEFAULT_DENIED_TOOLS = [...DEFAULT_WRITE_TOOLS, 'WebFetch', 'WebSearch']
const DEFAULT_DENIED_TOOL_NAMES = new Set(DEFAULT_DENIED_TOOLS)

// Character whitelist checked before any prefix match. A denylist of shell
// syntax keeps losing the race against process substitution, redirection and
// new metacharacters; this only ever grows more permissive by adding a
// character, never by removing a check. No glob character and no quote:
// fix round 2 found `cat .e*`, `cat ".e"nv` and `cat sto*/claudepaw*` all
// passing the path guard as literal strings while the shell expanded or
// unquoted them into a forbidden path before cat ever saw the argument.
// `~` and `^` are in the set so git revision syntax (HEAD~1, HEAD^2) works.
// The SDK Bash tool spawns bash, where `^` is inert in argument position (it
// is a history or extended-glob operator in csh and in zsh with EXTENDED_GLOB,
// neither of which runs here). A token that starts with `~` (home expansion)
// is still denied by touchesForbiddenPath.
const SAFE_CHARS_RE = /^[A-Za-z0-9 ._/=:@,+~^-]*$/

// Control characters and zero-width/bidi marks never belong in a path or a
// glob an agent typed. They exist only to make a denied path read as an
// allowed one in a log line or a review.
// eslint-disable-next-line no-control-regex
const UNSAFE_PATH_CHARS_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/

// Arguments that reach outside what a Bash-gated agent should ever read:
// secrets, the database, keys, and credentials.
const FORBIDDEN_PATH_MARKERS = ['.env', 'store/', '.claude', '.ssh', 'credential', '.db', '.pem', '.key']

function touchesForbiddenPath(cmd: string, workRoot?: ResolvedWorkRoot): boolean {
  const lower = cmd.toLowerCase()
  if (FORBIDDEN_PATH_MARKERS.some((m) => lower.includes(m))) return true
  const absoluteRoot = workRoot ? workRoot.lexical : PROJECT_ROOT
  for (const tok of cmd.split(/\s+/)) {
    if (tok.startsWith('~')) return true
    if (tok.startsWith('/') && !tok.startsWith(absoluteRoot)) return true
  }
  return false
}

function splitArgs(cmd: string): string[] {
  return cmd.trim().split(/\s+/)
}

function containedIn(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep)
}

// A non-flag token must resolve inside the repo. Rejects `..` outright (a
// resolved path can still leave PROJECT_ROOT through a symlink or a
// same-prefix sibling directory, `.env` next to `.env.production`, so the
// literal `..` check catches traversal before resolution even runs).
// Fix round 4: a relative token is resolved by the tool against the shell's
// actual cwd (CLAUDE_CWD, passed on the query() call), which is not
// guaranteed to equal PROJECT_ROOT. Resolve against both bases and require
// every result to sit inside both roots, so the guard cannot be fooled by a
// cwd that points somewhere else.
// Addendum 2: a path that exists is also checked after symlink resolution,
// so a link inside the repo pointing at /etc or at the store cannot smuggle a
// read through a lexically clean path. A path that does not exist yet (a
// Write target) has no realpath, so the lexical result stands.
// Fix round 2: the leaf may not exist yet (a Write target), but a parent
// directory can still be a symlink pointing outside the intended root. When
// the target itself has no realpath, walk up to the deepest existing
// ancestor, resolve that, and re-append the segments that do not exist yet,
// so a symlinked parent cannot smuggle a not-yet-created path out through an
// otherwise-lexical result.
function realOrLexical(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    const tail: string[] = []
    let dir = target
    for (;;) {
      const parent = dirname(dir)
      if (parent === dir) return target
      tail.unshift(basename(dir))
      try {
        return join(realpathSync(parent), ...tail)
      } catch {
        dir = parent
      }
    }
  }
}
// Round 6, breaker: the path fields stop substring-matching too. `store` with
// no trailing slash passed the `store/` marker, and any marker can be dodged
// by spelling the same location differently. The value is resolved instead
// (realpath when the target exists), then compared against real directories
// and a basename pattern, so every spelling of one location collapses to one
// answer.
const FORBIDDEN_DIR_NAMES = ['store', '.claude', '.ssh', '.git', '.worktrees']
const FORBIDDEN_BASENAME_RE = /^(\.env.*|.*\.db|.*\.pem|.*\.key|.*credential.*|id_rsa.*)$/i

// The same two rules applied to one glob segment. `node_modules` is not here:
// reading a dependency is ordinary work.
const FORBIDDEN_SEGMENT_NAMES = new Set(FORBIDDEN_DIR_NAMES)

function isForbiddenSegment(segment: string): boolean {
  return FORBIDDEN_SEGMENT_NAMES.has(segment.toLowerCase()) || FORBIDDEN_BASENAME_RE.test(segment)
}

const REAL_PROJECT_ROOT = realOrLexical(PROJECT_ROOT)
const REAL_CLAUDE_CWD = realOrLexical(CLAUDE_CWD)

// Fix round 1 (Task 7 Critical 1): a builder agent edits inside a git worktree,
// not the live checkout. `workRoot` narrows every path check in this file to
// that one directory instead of the whole repo, but only when the caller
// proves the worktree is one this file itself would create: lexically and
// really under PROJECT_ROOT/.worktrees/. Anything else fails closed.
const WORKTREES_ROOT = join(PROJECT_ROOT, '.worktrees')
const REAL_WORKTREES_ROOT = realOrLexical(WORKTREES_ROOT)

export interface ResolvedWorkRoot {
  lexical: string
  real: string
}

// Fix round 2 MEDIUM: `containedIn` treats the root itself as contained, so
// `.worktrees` (and any deeper path like `.worktrees/a/b`) passed validation.
// A valid work root is exactly one path segment below the worktrees root:
// the directory `git worktree add` itself creates, never the shared parent
// and never something nested inside one worktree.
function isOneLevelBelow(root: string, target: string): boolean {
  if (!containedIn(root, target) || target === root) return false
  return !relative(root, target).includes(sep)
}

/** Resolves and validates a workRoot against PROJECT_ROOT/.worktrees/. Null means invalid; callers must fail closed on null, never fall back to the unscoped roots. */
function resolveWorkRoot(workRoot: string): ResolvedWorkRoot | null {
  const lexical = resolve(PROJECT_ROOT, workRoot)
  if (!isOneLevelBelow(WORKTREES_ROOT, lexical)) return null
  const real = realOrLexical(lexical)
  if (!isOneLevelBelow(REAL_WORKTREES_ROOT, real)) return null
  return { lexical, real }
}

// Every spelling of every forbidden directory, resolved once. The home
// directory is on the list so a tool cannot walk into the operator's dotfiles,
// but only when it is not an ancestor of the repo: a checkout that lives under
// the home directory would otherwise deny every path in the project.
const FORBIDDEN_DIRS: string[] = (() => {
  const roots = [PROJECT_ROOT, CLAUDE_CWD, REAL_PROJECT_ROOT, REAL_CLAUDE_CWD]
  const dirs = new Set<string>()
  for (const root of roots) {
    for (const name of FORBIDDEN_DIR_NAMES) dirs.add(join(root, name))
  }
  const home = realOrLexical(homedir())
  const homeHoldsRepo = roots.some((r) => r === home || r.startsWith(home + sep))
  if (!homeHoldsRepo) dirs.add(home)
  return [...dirs]
})()

// Same two rules, resolved against one worktree instead of the whole repo.
// `.worktrees` itself is dropped: the target is already inside one.
const WORKROOT_FORBIDDEN_DIR_NAMES = FORBIDDEN_DIR_NAMES.filter((n) => n !== '.worktrees')

function isForbiddenTarget(target: string, workRoot?: ResolvedWorkRoot): boolean {
  const dirs = workRoot
    ? WORKROOT_FORBIDDEN_DIR_NAMES.flatMap((name) => [join(workRoot.lexical, name), join(workRoot.real, name)])
    : FORBIDDEN_DIRS
  for (const dir of dirs) {
    if (target === dir || containedIn(dir, target)) return true
  }
  return FORBIDDEN_BASENAME_RE.test(basename(target))
}

// Fix round 2 LOW: when a workRoot is set, it is the only root a Bash token
// may resolve inside, matching the file-tool guard. Without one, behavior is
// unchanged (both CLAUDE_CWD and PROJECT_ROOT, lexically and by realpath).
function isPathContained(tok: string, workRoot?: ResolvedWorkRoot): boolean {
  if (tok.includes('..')) return false
  if (workRoot) {
    const lexical = resolve(workRoot.lexical, tok)
    if (!containedIn(workRoot.lexical, lexical)) return false
    const real = realOrLexical(lexical)
    return real === lexical || containedIn(workRoot.real, real)
  }
  for (const base of [CLAUDE_CWD, PROJECT_ROOT]) {
    const lexical = resolve(base, tok)
    if (!containedIn(PROJECT_ROOT, lexical)) return false
    if (!containedIn(CLAUDE_CWD, lexical)) return false
    const real = realOrLexical(lexical)
    if (real === lexical) continue
    if (!containedIn(REAL_PROJECT_ROOT, real)) return false
    if (!containedIn(REAL_CLAUDE_CWD, real)) return false
  }
  return true
}

// Per-tool argument check: every `-`-prefixed token must be on that tool's
// option allowlist (a flag not listed is denied outright, closing argument
// injection like `rg --pre curl` or `git log --output=/tmp/x`); every other
// token must resolve inside the repo.
function checkArgs(tokens: string[], isAllowedFlag: (opt: string) => boolean, workRoot?: ResolvedWorkRoot): boolean {
  for (const tok of tokens) {
    if (tok.startsWith('-')) {
      if (!isAllowedFlag(tok)) return false
    } else if (!isPathContained(tok, workRoot)) {
      return false
    }
  }
  return true
}

// CLI names an agent may invoke through `node dist/<name>.js`, read lazily
// from src/*-cli.ts so an agent-written file under dist/ (which has no
// matching source file) can never be executed this way. These CLIs are
// policy-gated internally (checkAction, Task 6), which is why a mutation
// like `schedule-cli.js delete` is acceptable to allow here: the CLI itself
// re-checks policy before acting.
let knownCliNames: Set<string> | null = null
export function getKnownCliNames(): Set<string> {
  if (knownCliNames) return knownCliNames
  try {
    const files = readdirSync(join(PROJECT_ROOT, 'src'))
    knownCliNames = new Set(
      files.filter((f) => f.endsWith('-cli.ts')).map((f) => f.slice(0, -'.ts'.length)),
    )
  } catch {
    knownCliNames = new Set()
  }
  return knownCliNames
}

const GIT_LOG_FLAGS = new Set(['-n', '--oneline', '--stat'])
// `git log -3` is the same count limit as `git log -n 3`, spelled shorter.
const GIT_LOG_COUNT_RE = /^-\d+$/
const GIT_DIFF_SHOW_FLAGS = new Set(['--stat', '--name-only'])

const NODE_CLI_RE = /^node dist\/([A-Za-z0-9._-]+-cli)\.js\b/
// Quotes are no longer in SAFE_CHARS_RE, so only the unquoted print form
// reaches this regex; the quoted form is already denied as a metacharacter.
const SED_RE = /^sed -n \d+(?:,\d+)?p (\S+)$/

function isAllowedGit(cmd: string, workRoot?: ResolvedWorkRoot): boolean {
  if (touchesForbiddenPath(cmd, workRoot)) return false
  const [bin, sub, ...rest] = splitArgs(cmd)
  if (bin !== 'git') return false
  // Blocks `<rev>:<path>` reads (git show HEAD:.env) on every subcommand,
  // not just the ones with a flag allowlist.
  if (rest.some((t) => t.includes(':'))) return false
  switch (sub) {
    case 'status':
    case 'branch':
      return rest.length === 0
    case 'worktree':
      return rest.length === 1 && rest[0] === 'list'
    case 'log':
      return checkArgs(rest, (o) => GIT_LOG_FLAGS.has(o) || GIT_LOG_COUNT_RE.test(o), workRoot)
    case 'diff':
    case 'show':
      return checkArgs(rest, (o) => GIT_DIFF_SHOW_FLAGS.has(o), workRoot)
    default:
      return false
  }
}

function isAllowedNpm(cmd: string): boolean {
  return cmd === 'npm test' || /^npm run (test|typecheck|build)$/.test(cmd)
}

// npm and node take no flags here: the CLI's own positional arguments
// (project id, action class, task id) are the only thing that follows.
function isAllowedNodeCli(cmd: string, workRoot?: ResolvedWorkRoot): boolean {
  const m = NODE_CLI_RE.exec(cmd)
  if (!m) return false
  if (!getKnownCliNames().has(m[1]!)) return false
  const rest = splitArgs(cmd).slice(2)
  return checkArgs(rest, () => false, workRoot)
}

// gh flags that take a file path as their value. Without this the wrapper arm
// matched on its prefix alone and never looked at the rest of the line, so
// `scripts/gh-wrapper.sh default pr create --body-file .env` posted the file
// into a public PR body.
const FILE_VALUE_FLAGS = new Set(['--body-file', '--field-file', '-F', '--input', '-f'])

// These carry prose, not a path. A PR title or an issue comment naturally
// contains words, slashes and file names, and running the path rules over them
// denied ordinary GitHub work. Their values are never opened as files, so the
// file-flag guard above is what actually matters.
const PROSE_VALUE_FLAGS = new Set(['--body', '--title', '-b', '-t'])

function isWrapperPathTokenAllowed(tok: string, workRoot?: ResolvedWorkRoot): boolean {
  return !touchesForbiddenPath(tok, workRoot) && isPathContained(tok, workRoot)
}

function isAllowedWrapper(cmd: string, workRoot?: ResolvedWorkRoot): boolean {
  if (!/^(bash\s+)?scripts\/(gh-wrapper|git-push-wrapper)\.sh\b/.test(cmd)) return false

  const tokens = splitArgs(cmd)
  // Skip the optional `bash` and the wrapper script path itself.
  for (let i = tokens[0] === 'bash' ? 2 : 1; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!tok.startsWith('-')) {
      if (!isWrapperPathTokenAllowed(tok, workRoot)) return false
      continue
    }
    const eq = tok.indexOf('=')
    const name = eq === -1 ? tok : tok.slice(0, eq)

    if (PROSE_VALUE_FLAGS.has(name)) {
      // Quotes are not in SAFE_CHARS_RE, so a multi-word body arrives as
      // several tokens. Everything up to the next flag is that prose.
      if (eq === -1) while (i + 1 < tokens.length && !tokens[i + 1]!.startsWith('-')) i++
      continue
    }

    if (FILE_VALUE_FLAGS.has(name)) {
      // --body-file=<path>: the value never appears as its own token, so it
      // would otherwise skip the check entirely.
      const value = eq === -1 ? tokens[++i] : tok.slice(eq + 1)
      if (value === undefined || !isWrapperPathTokenAllowed(value, workRoot)) return false
      continue
    }

    // Any other flag written in the equals form. Its value is one token that no
    // later iteration will see, and gh has more file-taking flags than the list
    // above, so the value is path-checked rather than trusted.
    if (eq !== -1 && !isWrapperPathTokenAllowed(tok.slice(eq + 1), workRoot)) return false
  }
  return true
}

const LS_FLAGS = new Set(['-l', '-a', '-la', '-al', '-R'])
// No -r: grep -r walks the whole tree including dotfiles (.env,
// .claude/settings.local.json), and the path guard only inspects the
// tokens the agent typed, never what the tool recurses into. rg is the
// allowed recursive search tool; it skips hidden files and respects
// .gitignore by default.
const GREP_FLAGS = new Set(['-n', '-i', '-l', '-c', '-E'])

function isAllowedRgFlag(opt: string): boolean {
  return ['-n', '-i', '-l', '-c'].includes(opt) || opt.startsWith('--type=') || opt.startsWith('-g')
}

function isAllowedReadCommand(cmd: string, workRoot?: ResolvedWorkRoot): boolean {
  if (touchesForbiddenPath(cmd, workRoot)) return false
  const sedMatch = SED_RE.exec(cmd)
  if (sedMatch) return isPathContained(sedMatch[1]!, workRoot)
  const [bin, ...rest] = splitArgs(cmd)
  if (bin === 'ls') return checkArgs(rest, (o) => LS_FLAGS.has(o), workRoot)
  // A bare `cat` with no file argument reads stdin and hangs the tool call.
  if (bin === 'cat') return rest.length > 0 && checkArgs(rest, () => false, workRoot)
  if (bin === 'grep') return checkArgs(rest, (o) => GREP_FLAGS.has(o), workRoot)
  if (bin === 'rg') return checkArgs(rest, isAllowedRgFlag, workRoot)
  return false
}

// Which input field(s) on each SDK file tool carry a path or glob pattern
// that must stay inside the repo and off the forbidden-path list. Read,
// Grep and Glob are always available (never in DEFAULT_WRITE_TOOLS), so
// without this guard a soul with no Bash access at all could still read
// .env straight through the Read tool; that is exactly how a live smoke
// leaked real secrets in fix round 2. Edit, Write, MultiEdit and
// NotebookEdit are covered too, for whenever a soul's tools: frontmatter
// enables one of them.
// Fix round 4: every path-like input of every file tool is guarded, not just
// the obvious one. A Grep call with path `src` and glob `**/.env*`, or a Glob
// call with an absolute pattern, escaped the old single-field guard entirely.
const PATH_GUARDED_FIELDS: Record<string, string[]> = {
  Read: ['file_path', 'notebook_path'],
  Edit: ['file_path', 'notebook_path'],
  MultiEdit: ['file_path', 'notebook_path'],
  Write: ['file_path', 'notebook_path'],
  NotebookEdit: ['file_path', 'notebook_path'],
  Glob: ['pattern', 'path'],
  Grep: ['path', 'glob'],
}

// Fields whose value is a glob pattern rather than a plain path.
const GLOB_FIELDS = new Set(['pattern', 'glob'])

// The one field each file tool must actually carry. A call that omits it is
// denied rather than sliding past an all-optional loop.
const REQUIRED_PATH_FIELD: Record<string, string> = {
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
}

// Round 5, Critical: the forbidden-marker test was a literal substring match,
// so any glob metacharacter split the marker and the gate never saw it.
// `**/.en[v]`, `**/.e?v` and `**/.{env,zz}` all passed the gate and all three
// resolve to `.env` under ripgrep.
const GLOB_SAFE_RE = /^[A-Za-z0-9._/*-]+$/

// Round 6, breaker: a whitelist of characters was still not enough, because
// `*` alone spells around a marker: `**/*env`, `**/*db`, `st*re/**` and
// `**/claudepaw*` all reach the same files. So the glob is a grammar, not a
// character set. Each `/`-separated segment must be one of exactly three
// things: `**`, a literal name with no wildcard at all, or, only as the final
// segment, a leading star with one allowlisted source extension. That leaves
// no way to write a partial name, which is the only way a star can be used to
// probe for a secret whose full name the grammar would reject.
const GLOB_LITERAL_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const GLOB_EXT_SEGMENT_RE =
  /^\*\.(ts|tsx|js|mjs|cjs|jsx|json|md|css|html|sh|py|yml|yaml|txt|sql)$/


// Write-class tools may never target a file the Bash allowlist can execute
// (dist/<name>-cli.js, scripts/*-wrapper.sh) or a source file those builds
// come from, nor git/worktree/dependency internals. This holds regardless of
// the soul's tools list, so enabling Write for a future soul cannot hand it
// an arbitrary-code-execution path through the allowlist.
const WRITE_TOOL_NAMES = new Set(DEFAULT_WRITE_TOOLS)
const WRITE_FORBIDDEN_DIRS = ['dist', 'scripts', 'node_modules', '.git', '.worktrees']

// Round 6: a tool path value is judged by where it resolves to, not by what
// it looks like. `..` is no longer rejected lexically here (the Bash token
// guard still does), because `./store/../src` resolves to a path the tools may
// read and the resolution is what the tool will actually open.
function checkPathValue(value: string, workRoot?: ResolvedWorkRoot): string | null {
  if (UNSAFE_PATH_CHARS_RE.test(value)) return 'path not allowed'
  if (value.startsWith('~')) return 'path not allowed'

  if (workRoot) {
    // The agent's session cwd is the worktree itself, so it is the only base
    // that matters, and containment is required against the worktree, not
    // the whole repo. `checkArgs`/`isPathContained` (the Bash-token guard)
    // are unaffected: the builder soul has no Bash.
    const lexical = resolve(workRoot.lexical, value)
    if (!containedIn(workRoot.lexical, lexical)) return 'path not allowed'
    const real = realOrLexical(lexical)
    if (real !== lexical && !containedIn(workRoot.real, real)) return 'path not allowed'
    if (isForbiddenTarget(real, workRoot)) return 'path not allowed'
    return null
  }

  for (const base of [CLAUDE_CWD, PROJECT_ROOT]) {
    const lexical = resolve(base, value)
    if (!containedIn(PROJECT_ROOT, lexical)) return 'path not allowed'
    if (!containedIn(CLAUDE_CWD, lexical)) return 'path not allowed'
    const real = realOrLexical(lexical)
    if (real !== lexical) {
      if (!containedIn(REAL_PROJECT_ROOT, real)) return 'path not allowed'
      if (!containedIn(REAL_CLAUDE_CWD, real)) return 'path not allowed'
    }
    if (isForbiddenTarget(real)) return 'path not allowed'
  }
  return null
}

// A glob may not climb out of the repo (`..`), name an absolute or home
// path, or touch the forbidden list. Its literal prefix (everything before
// the first wildcard) must also resolve inside the repo.
function checkGlobValue(value: string, workRoot?: ResolvedWorkRoot): string | null {
  if (UNSAFE_PATH_CHARS_RE.test(value)) return 'path not allowed'
  if (!GLOB_SAFE_RE.test(value)) return 'glob syntax not allowed'

  const segments = value.split('/')
  const literal: string[] = []
  let sawWildcard = false
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (seg.startsWith('.')) return 'hidden path in glob'
    if (seg === '**') {
      sawWildcard = true
      continue
    }
    if (GLOB_LITERAL_SEGMENT_RE.test(seg)) {
      // Every literal segment, not only the prefix before the first wildcard.
      // The prefix-only check let `**/store/*.json`, `**/claudepaw.db` and
      // `**/credentials.json` through, because their forbidden part sits after
      // a `**` and the prefix was empty.
      if (isForbiddenSegment(seg)) return 'path not allowed'
      if (!sawWildcard) literal.push(seg)
      continue
    }
    if (i === segments.length - 1 && GLOB_EXT_SEGMENT_RE.test(seg)) {
      sawWildcard = true
      continue
    }
    return 'glob syntax not allowed'
  }

  // The literal part the glob is rooted at must itself be a path the tools may
  // touch, so `store/**` is denied for the same reason `store` is.
  return checkPathValue(literal.join('/'), workRoot)
}

function isWriteTargetAllowed(value: string, workRoot?: ResolvedWorkRoot): boolean {
  const root = workRoot ? workRoot.lexical : PROJECT_ROOT
  const rel = relative(root, resolve(root, value))
  if (rel.startsWith('..')) return false
  const segments = rel.split(sep)
  if (WRITE_FORBIDDEN_DIRS.includes(segments[0] ?? '')) return false
  return !(segments[segments.length - 1] ?? '').endsWith('-cli.ts')
}

interface ToolPathCheckResult {
  allowed: boolean
  value?: string
  reason?: string
}

function checkToolPathFields(toolName: string, input: Record<string, unknown>, workRoot?: ResolvedWorkRoot): ToolPathCheckResult {
  const fields = PATH_GUARDED_FIELDS[toolName]
  if (!fields) return { allowed: true }

  // Fail closed on a value that is not a plain non-empty string (an array, an
  // object, a number, or a required field left out). Whether the CLI's own
  // tool schema would have rejected it first is CLI side and unverified, and
  // that is exactly the assumption that failed in round 3.
  const required = REQUIRED_PATH_FIELD[toolName]
  if (required !== undefined) {
    const raw = input[required]
    if (typeof raw !== 'string' || raw.length === 0) {
      return { allowed: false, value: String(raw), reason: 'invalid input type' }
    }
  }

  for (const field of fields) {
    const raw = input[field]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'string' || raw.length === 0) {
      return { allowed: false, value: String(raw), reason: 'invalid input type' }
    }
    const reason = GLOB_FIELDS.has(field) ? checkGlobValue(raw, workRoot) : checkPathValue(raw, workRoot)
    if (reason) return { allowed: false, value: raw, reason }
    if (WRITE_TOOL_NAMES.has(toolName) && !isWriteTargetAllowed(raw, workRoot)) {
      return { allowed: false, value: raw, reason: 'path not allowed' }
    }
  }
  return { allowed: true }
}

export interface BashCheckResult {
  allowed: boolean
  reason?: string
}

export function checkBashCommand(command: string, workRoot?: ResolvedWorkRoot): BashCheckResult {
  const cmd = (command ?? '').trim()
  if (!cmd) return { allowed: false, reason: 'empty command' }
  if (!SAFE_CHARS_RE.test(cmd)) return { allowed: false, reason: 'shell metacharacter' }
  if (
    isAllowedGit(cmd, workRoot) ||
    isAllowedNpm(cmd) ||
    isAllowedNodeCli(cmd, workRoot) ||
    isAllowedWrapper(cmd, workRoot) ||
    isAllowedReadCommand(cmd, workRoot)
  ) {
    return { allowed: true }
  }
  return { allowed: false, reason: touchesForbiddenPath(cmd, workRoot) ? 'path not allowed' : 'not on the allowlist' }
}

export function isAllowedBashCommand(command: string): boolean {
  return checkBashCommand(command).allowed
}

export interface ToolGateResult {
  allowed: boolean
  /** Short machine reason (e.g. "path not allowed", "shell metacharacter"). Only set when denied. */
  reason?: string
  /** Full human-readable denial message. Only set when denied. */
  message?: string
}

/**
 * The single source of truth for whether a tool call is allowed: the Bash
 * command allowlist, the file-tool path guard, and the soul's own tools:
 * restriction. Pure and side-effect free so both the PreToolUse hook and
 * canUseTool can call it and never disagree.
 */
export function gateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  wanted: string[] | null,
  workRoot?: string,
): ToolGateResult {
  if (toolName.startsWith('mcp__')) return { allowed: true }

  let resolvedRoot: ResolvedWorkRoot | undefined
  if (workRoot !== undefined) {
    const root = resolveWorkRoot(workRoot)
    if (!root) {
      return {
        allowed: false,
        reason: 'invalid work root',
        message: `Tool ${toolName} denied (invalid work root): ${workRoot}`,
      }
    }
    resolvedRoot = root
  }

  if (wanted && !wanted.includes(toolName)) {
    return {
      allowed: false,
      reason: 'tool outside soul tool set',
      message: `Tool ${toolName} is not in this agent's tool set`,
    }
  }

  if (DEFAULT_DENIED_TOOL_NAMES.has(toolName) && !wanted?.includes(toolName)) {
    return {
      allowed: false,
      reason: 'tool denied by default',
      message: `Tool ${toolName} is denied by default; name it in the soul tools list to enable it`,
    }
  }

  const pathCheck = checkToolPathFields(toolName, input, resolvedRoot)
  if (!pathCheck.allowed) {
    const reason = pathCheck.reason ?? 'path not allowed'
    return {
      allowed: false,
      reason,
      message: `Tool ${toolName} denied (${reason}): ${pathCheck.value}`,
    }
  }

  if (toolName === 'Bash') {
    const command = String((input as { command?: unknown })?.command ?? '')
    const check = checkBashCommand(command, resolvedRoot)
    if (!check.allowed) {
      return {
        allowed: false,
        reason: check.reason,
        message: `Bash command denied (${check.reason}): ${command.slice(0, 200)}`,
      }
    }
  }

  return { allowed: true }
}

// Both the PreToolUse hook and canUseTool call gateToolCall and may both fire
// for the same tool call, so the identical denial would be logged twice.
// Round 4 addendum: the dedupe key is the SDK's own tool_use_id, which is
// unique per tool call within an assistant message. That merges the two
// enforcement paths for one call while still logging every distinct attempt,
// which a message-text key with a time window did not: a genuine retry of the
// same command inside the window was swallowed, and two long commands sharing
// a truncated prefix collided. The set is bounded at the last 200 ids,
// oldest evicted first (Set iteration order is insertion order).
const seenDenialIds = new Set<string>()
const DENIAL_ID_LIMIT = 200

function logGateDenial(
  toolName: string,
  result: ToolGateResult,
  toolUseId: string | undefined,
  projectId: string | undefined,
): void {
  if (toolUseId) {
    if (seenDenialIds.has(toolUseId)) return
    seenDenialIds.add(toolUseId)
    if (seenDenialIds.size > DENIAL_ID_LIMIT) {
      const oldest = seenDenialIds.values().next().value
      if (oldest !== undefined) seenDenialIds.delete(oldest)
    }
  }
  logger.warn({ toolName, reason: result.reason, projectId }, 'sdk permission denied')
  recordError('agent-permissions', 'warn', result.message ?? `Tool ${toolName} denied`, undefined, {
    toolName,
    reason: result.reason,
    projectId,
  })
}

// A throw inside the gate must deny, never fall through to allow.
function gateOrError(
  toolName: string,
  input: Record<string, unknown>,
  wanted: string[] | null,
  workRoot?: string,
): ToolGateResult {
  try {
    return gateToolCall(toolName, input, wanted, workRoot)
  } catch (err) {
    return {
      allowed: false,
      reason: 'gate error',
      message: `Tool ${toolName} denied (gate error): ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export function buildSdkPermissions(
  soul?: { tools?: string[] } | null,
  projectId?: string,
  workRoot?: string,
): {
  tools: { type: 'preset'; preset: 'claude_code' }
  disallowedTools?: string[]
  canUseTool: CanUseTool
  hooks: { PreToolUse: HookCallbackMatcher[] }
} {
  const wanted = soul?.tools?.length ? soul.tools : null
  // Least privilege: the write tools are denied unless the soul's own
  // tools: frontmatter names them. Without a soul restriction at all, that
  // means exactly DEFAULT_WRITE_TOOLS; with one, it is the union of that
  // default deny list and the ALL_BUILTIN_TOOLS complement, each filtered
  // for anything the soul explicitly asked for.
  const disallowedTools = wanted
    ? Array.from(new Set([
        ...ALL_BUILTIN_TOOLS.filter((t) => !wanted.includes(t)),
        ...DEFAULT_DENIED_TOOLS.filter((t) => !wanted.includes(t)),
      ]))
    : [...DEFAULT_DENIED_TOOLS]

  // Second line of defense: gateToolCall already ran in the PreToolUse hook
  // for every tool call, so a denial reaching here for the same call is
  // deduped by logGateDenial's short-lived key and not logged twice. This
  // still enforces (not a no-op) in case a future SDK version changes the
  // hook/canUseTool ordering or skips the hook for some tool.
  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const result = gateOrError(toolName, input as Record<string, unknown>, wanted, workRoot)
    if (!result.allowed) {
      logGateDenial(toolName, result, options?.toolUseID, projectId)
      return { behavior: 'deny', message: result.message! }
    }
    return { behavior: 'allow' }
  }

  const preToolUseHook: HookCallback = async (input, toolUseID) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const { tool_name: toolName, tool_input: toolInput } = input as PreToolUseHookInput
    const result = gateOrError(toolName, (toolInput ?? {}) as Record<string, unknown>, wanted, workRoot)
    if (!result.allowed) {
      logGateDenial(toolName, result, toolUseID, projectId)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: result.message,
        },
      }
    }
    // Pass through rather than returning an explicit 'allow'. Per the SDK
    // contract a hook allow bypasses canUseTool, which would make the second
    // line of defense above dead code.
    return {}
  }

  return {
    tools: { type: 'preset', preset: 'claude_code' },
    ...(disallowedTools ? { disallowedTools } : {}),
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUseHook] }] },
  }
}
