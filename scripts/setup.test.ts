import { describe, it, expect } from 'vitest'
import {
  toSlug,
  parseAgentFrontmatter,
  readEnvFile,
  THEME_PRESETS,
  BOT_TOKEN_RE,
  CHAT_ID_RE,
  SLUG_RE,
  HEX_COLOR_RE,
} from './setup-helpers.js'

// ── toSlug ──────────────────────────────────────────────────────────────────

describe('toSlug', () => {
  it('converts "Example Company" to "example-company"', () => {
    expect(toSlug('Example Company')).toBe('example-company')
  })

  it('converts "My Cool Project" to "my-cool-project"', () => {
    expect(toSlug('My Cool Project')).toBe('my-cool-project')
  })

  it('trims whitespace: "  spaces  " -> "spaces"', () => {
    expect(toSlug('  spaces  ')).toBe('spaces')
  })

  it('lowercases: "UPPERCASE" -> "uppercase"', () => {
    expect(toSlug('UPPERCASE')).toBe('uppercase')
  })

  it('strips special chars: "special!@#chars" -> "special-chars"', () => {
    expect(toSlug('special!@#chars')).toBe('special-chars')
  })

  it('passes through existing slug: "already-a-slug"', () => {
    expect(toSlug('already-a-slug')).toBe('already-a-slug')
  })

  it('strips leading/trailing hyphens: "---leading-trailing---"', () => {
    expect(toSlug('---leading-trailing---')).toBe('leading-trailing')
  })

  it('returns empty string for empty input', () => {
    expect(toSlug('')).toBe('')
  })

  it('collapses multiple special chars to single hyphen', () => {
    expect(toSlug('a   b   c')).toBe('a-b-c')
  })

  it('handles mixed case and symbols', () => {
    expect(toSlug('Hello World! 2026')).toBe('hello-world-2026')
  })
})

// ── parseAgentFrontmatter ───────────────────────────────────────────────────

describe('parseAgentFrontmatter', () => {
  it('parses valid frontmatter with all fields', () => {
    const content = `---
id: scout
name: Scout
emoji: "\\U0001F52D"
role: Trend researcher
mode: active
---

# Scout Agent

Body content here.
`
    const result = parseAgentFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('scout')
    expect(result!.name).toBe('Scout')
    expect(result!.role).toBe('Trend researcher')
    expect(result!.mode).toBe('active')
  })

  it('converts unicode emoji escapes correctly', () => {
    const content = `---
id: herald
name: Herald
emoji: "\\U0001F4E2"
role: Announcer
mode: active
---
`
    const result = parseAgentFrontmatter(content)
    expect(result).not.toBeNull()
    // U+1F4E2 is the loudspeaker emoji
    expect(result!.emoji).toBe('\u{1F4E2}')
  })

  it('strips double-quoted values', () => {
    const content = `---
id: "test-agent"
name: "Test Agent"
emoji: "X"
role: "tester"
mode: "on-demand"
---
`
    const result = parseAgentFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('test-agent')
    expect(result!.name).toBe('Test Agent')
  })

  it('strips single-quoted values', () => {
    const content = `---
id: 'quoted'
name: 'Quoted Agent'
emoji: 'Q'
role: 'quoter'
mode: 'active'
---
`
    const result = parseAgentFrontmatter(content)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('quoted')
    expect(result!.name).toBe('Quoted Agent')
  })

  it('returns null when id is missing', () => {
    const content = `---
name: NoId
emoji: X
role: nothing
mode: active
---
`
    expect(parseAgentFrontmatter(content)).toBeNull()
  })

  it('returns null when name is missing', () => {
    const content = `---
id: no-name
emoji: X
role: nothing
mode: active
---
`
    expect(parseAgentFrontmatter(content)).toBeNull()
  })

  it('returns null for file without frontmatter', () => {
    // Prefix with --- so it's treated as raw content, but no closing ---
    const content = `---
not valid frontmatter without closing delimiters
`
    expect(parseAgentFrontmatter(content)).toBeNull()
  })

  it('returns null for empty frontmatter block', () => {
    const content = `---

---
`
    expect(parseAgentFrontmatter(content)).toBeNull()
  })
})

// ── readEnvFile ─────────────────────────────────────────────────────────────

describe('readEnvFile', () => {
  it('parses KEY=value correctly', () => {
    const result = readEnvFile('FOO=bar\nBAZ=qux')
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('skips comments and blank lines', () => {
    const content = `# This is a comment
FOO=bar

# Another comment

BAZ=qux
`
    const result = readEnvFile(content)
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('handles double-quoted values', () => {
    const result = readEnvFile('KEY="hello world"')
    expect(result).toEqual({ KEY: 'hello world' })
  })

  it('handles single-quoted values', () => {
    const result = readEnvFile("KEY='hello world'")
    expect(result).toEqual({ KEY: 'hello world' })
  })

  it('strips inline comments on unquoted values', () => {
    const result = readEnvFile('KEY=value # this is a comment')
    expect(result).toEqual({ KEY: 'value' })
  })

  it('does not strip hash inside quoted values', () => {
    const result = readEnvFile('KEY="value # not a comment"')
    expect(result).toEqual({ KEY: 'value # not a comment' })
  })

  it('handles values with equals signs', () => {
    const result = readEnvFile('KEY=abc=def')
    expect(result).toEqual({ KEY: 'abc=def' })
  })

  it('returns empty object for empty input', () => {
    expect(readEnvFile('')).toEqual({})
  })

  it('skips lines without equals sign', () => {
    const result = readEnvFile('INVALID_LINE\nGOOD=value')
    expect(result).toEqual({ GOOD: 'value' })
  })

  it('trims whitespace around keys and values', () => {
    const result = readEnvFile('  KEY  =  value  ')
    expect(result).toEqual({ KEY: 'value' })
  })
})

// ── Validation regex patterns ───────────────────────────────────────────────

describe('BOT_TOKEN_RE', () => {
  it('matches valid bot token "123456:ABC-def_123"', () => {
    expect(BOT_TOKEN_RE.test('123456:ABC-def_123')).toBe(true)
  })

  it('matches long numeric prefix', () => {
    expect(BOT_TOKEN_RE.test('7891234567:AAHfiqkM_Xk-ABC123')).toBe(true)
  })

  it('rejects token without colon: "no-colon"', () => {
    expect(BOT_TOKEN_RE.test('no-colon')).toBe(false)
  })

  it('rejects token with non-digits before colon: "abc:def"', () => {
    expect(BOT_TOKEN_RE.test('abc:def')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(BOT_TOKEN_RE.test('')).toBe(false)
  })

  it('rejects colon only', () => {
    expect(BOT_TOKEN_RE.test(':')).toBe(false)
  })
})

describe('CHAT_ID_RE', () => {
  it('matches valid chat ID "123456789"', () => {
    expect(CHAT_ID_RE.test('123456789')).toBe(true)
  })

  it('matches single digit', () => {
    expect(CHAT_ID_RE.test('1')).toBe(true)
  })

  it('rejects alphabetic: "abc"', () => {
    expect(CHAT_ID_RE.test('abc')).toBe(false)
  })

  it('rejects negative number: "-123"', () => {
    expect(CHAT_ID_RE.test('-123')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(CHAT_ID_RE.test('')).toBe(false)
  })

  it('rejects mixed alphanumeric', () => {
    expect(CHAT_ID_RE.test('123abc')).toBe(false)
  })
})

describe('SLUG_RE', () => {
  it('matches valid slug "my-project"', () => {
    expect(SLUG_RE.test('my-project')).toBe(true)
  })

  it('matches slug with numbers "test123"', () => {
    expect(SLUG_RE.test('test123')).toBe(true)
  })

  it('matches single word "hello"', () => {
    expect(SLUG_RE.test('hello')).toBe(true)
  })

  it('rejects uppercase: "MY-PROJECT"', () => {
    expect(SLUG_RE.test('MY-PROJECT')).toBe(false)
  })

  it('rejects spaces: "has spaces"', () => {
    expect(SLUG_RE.test('has spaces')).toBe(false)
  })

  it('rejects special chars: "special!"', () => {
    expect(SLUG_RE.test('special!')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(SLUG_RE.test('')).toBe(false)
  })
})

describe('HEX_COLOR_RE', () => {
  it('matches valid lowercase "#1e1b4b"', () => {
    expect(HEX_COLOR_RE.test('#1e1b4b')).toBe(true)
  })

  it('matches valid uppercase "#FFFFFF"', () => {
    expect(HEX_COLOR_RE.test('#FFFFFF')).toBe(true)
  })

  it('matches mixed case "#aAbBcC"', () => {
    expect(HEX_COLOR_RE.test('#aAbBcC')).toBe(true)
  })

  it('rejects missing hash: "1e1b4b"', () => {
    expect(HEX_COLOR_RE.test('1e1b4b')).toBe(false)
  })

  it('rejects invalid hex chars: "#GGG000"', () => {
    expect(HEX_COLOR_RE.test('#GGG000')).toBe(false)
  })

  it('rejects too short: "#12345"', () => {
    expect(HEX_COLOR_RE.test('#12345')).toBe(false)
  })

  it('rejects too long: "#1234567"', () => {
    expect(HEX_COLOR_RE.test('#1234567')).toBe(false)
  })

  it('rejects 3-char shorthand: "#fff"', () => {
    expect(HEX_COLOR_RE.test('#fff')).toBe(false)
  })
})

// ── THEME_PRESETS ───────────────────────────────────────────────────────────

describe('THEME_PRESETS', () => {
  it('contains 5 presets', () => {
    expect(THEME_PRESETS).toHaveLength(5)
  })

  it('each preset has name, primary, and accent', () => {
    for (const preset of THEME_PRESETS) {
      expect(preset.name).toBeTruthy()
      expect(HEX_COLOR_RE.test(preset.primary)).toBe(true)
      expect(HEX_COLOR_RE.test(preset.accent)).toBe(true)
    }
  })

  it('includes Midnight preset', () => {
    const midnight = THEME_PRESETS.find((t) => t.name === 'Midnight')
    expect(midnight).toBeDefined()
    expect(midnight!.primary).toBe('#1e1b4b')
    expect(midnight!.accent).toBe('#7c3aed')
  })
})
