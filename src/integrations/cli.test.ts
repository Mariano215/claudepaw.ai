import { describe, it, expect } from 'vitest'
import { parseArgs } from './cli.js'

describe('CLI arg parser', () => {
  it('parses gmail search command', () => {
    const args = parseArgs(['service', 'google', 'gmail', 'search', '--project', 'example-company', '--query', 'from:test', '--max', '5'])
    expect(args.service).toBe('google')
    expect(args.module).toBe('gmail')
    expect(args.command).toBe('search')
    expect(args.project).toBe('example-company')
    expect(args.options.query).toBe('from:test')
    expect(args.options.max).toBe('5')
  })

  it('parses drive list with account', () => {
    const args = parseArgs(['service', 'google', 'drive', 'list', '--project', 'example-company', '--account', 'user@gmail.com'])
    expect(args.module).toBe('drive')
    expect(args.command).toBe('list')
    expect(args.account).toBe('user@gmail.com')
  })

  it('parses sheets read with sheet and range', () => {
    const args = parseArgs(['service', 'google', 'sheets', 'read', '--project', 'test', '--sheet', 'abc123', '--range', 'Sheet1!A1:Z'])
    expect(args.module).toBe('sheets')
    expect(args.command).toBe('read')
    expect(args.options.sheet).toBe('abc123')
    expect(args.options.range).toBe('Sheet1!A1:Z')
  })

  it('throws on missing --project', () => {
    expect(() => parseArgs(['service', 'google', 'gmail', 'search'])).toThrow('--project')
  })

  it('throws on missing module', () => {
    expect(() => parseArgs(['service', 'google'])).toThrow('module')
  })

  it('parses imap search command (flat service, no sub-module)', () => {
    const args = parseArgs(['service', 'imap', 'search', '--project', 'example-company', '--account', 'press@example.com', '--query', 'UNSEEN', '--max', '10'])
    expect(args.service).toBe('imap')
    expect(args.module).toBe('search')
    expect(args.command).toBe('')
    expect(args.project).toBe('example-company')
    expect(args.account).toBe('press@example.com')
    expect(args.options.query).toBe('UNSEEN')
    expect(args.options.max).toBe('10')
  })

  it('parses imap read command', () => {
    const args = parseArgs(['service', 'imap', 'read', '--project', 'example-company', '--account', 'press@example.com', '--uid', '123'])
    expect(args.service).toBe('imap')
    expect(args.module).toBe('read')
    expect(args.options.uid).toBe('123')
  })

  it('parses imap folders command', () => {
    const args = parseArgs(['service', 'imap', 'folders', '--project', 'example-company', '--account', 'press@example.com'])
    expect(args.service).toBe('imap')
    expect(args.module).toBe('folders')
    expect(args.command).toBe('')
  })
})
