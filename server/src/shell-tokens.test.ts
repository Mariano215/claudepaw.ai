/**
 * shell-tokens.test.ts
 *
 * server/public/shell-tokens.js is a classic browser script (no bundler in
 * this project), so it cannot be imported as an ES module. It assigns its two
 * functions onto globalThis; evaluating the file here gives vitest the same
 * two functions the browser gets.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHELL_TOKENS = path.join(here, '..', 'public', 'shell-tokens.js')

type TokenFn = (hex: string) => Record<string, string>
type AccentFn = (settings: unknown, theme: unknown) => string

let shellAccentTokens: TokenFn
let shellAccentFor: AccentFn

beforeAll(() => {
  new Function(readFileSync(SHELL_TOKENS, 'utf-8'))()
  shellAccentTokens = (globalThis as Record<string, unknown>).shellAccentTokens as TokenFn
  shellAccentFor = (globalThis as Record<string, unknown>).shellAccentFor as AccentFn
})

describe('shellAccentTokens', () => {
  it('returns only accent custom properties', () => {
    const tokens = shellAccentTokens('#f97316')
    expect(Object.keys(tokens).every(k => k.startsWith('--accent'))).toBe(true)
  })

  it('derives the opacity variants from the hex', () => {
    const tokens = shellAccentTokens('#f97316')
    expect(tokens['--accent']).toBe('#f97316')
    expect(tokens['--accent-dim']).toBe('rgba(249,115,22,0.13)')
    expect(tokens['--accent-glow']).toBe('rgba(249,115,22,0.32)')
    expect(tokens['--accent-strong']).toBe('rgba(249,115,22,0.60)')
  })

  it('never touches background, text, border, font or shadow tokens', () => {
    const keys = Object.keys(shellAccentTokens('#8bc34a'))
    for (const forbidden of ['--bg-base', '--bg-raised', '--text-primary', '--border-color', '--font-heading', '--shadow-card', '--card-gradient']) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('returns nothing for an unparseable value', () => {
    expect(shellAccentTokens('not-a-color')).toEqual({})
    expect(shellAccentTokens('')).toEqual({})
  })
})

describe('shellAccentFor', () => {
  it('prefers the project primary color', () => {
    expect(shellAccentFor({ primary_color: '#8bc34a' }, { colors: { accent: '#00ff9f' } })).toBe('#8bc34a')
  })

  it('falls back to the theme accent', () => {
    expect(shellAccentFor({}, { colors: { accent: '#00ff9f' } })).toBe('#00ff9f')
  })

  it('falls back to the ClaudePaw orange', () => {
    expect(shellAccentFor(null, null)).toBe('#f97316')
  })
})
