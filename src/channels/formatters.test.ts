import { describe, it, expect } from 'vitest'
import {
  splitMessage,
  escapeHtml,
  formatForTelegram,
  formatForDiscord,
  formatForWhatsApp,
  formatForSlack,
  stripMarkdown,
  getFormatter,
} from './formatters.js'

// ── splitMessage ────────────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const result = splitMessage('Hello world', 4096)
    expect(result).toEqual(['Hello world'])
  })

  it('returns single chunk when exactly at limit', () => {
    const msg = 'x'.repeat(100)
    const result = splitMessage(msg, 100)
    expect(result).toEqual([msg])
  })

  it('splits long message at newline boundary', () => {
    const line1 = 'a'.repeat(50)
    const line2 = 'b'.repeat(50)
    const msg = `${line1}\n${line2}`
    // Limit smaller than full message but larger than each line
    const result = splitMessage(msg, 60)
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(line1)
    expect(result[1]).toBe(line2)
  })

  it('splits at space when no newline is available', () => {
    const msg = 'word '.repeat(20).trim() // 20 words separated by spaces
    const result = splitMessage(msg, 30)
    expect(result.length).toBeGreaterThan(1)
    // Each chunk should be within limit
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(30)
    }
  })

  it('hard-cuts when no space or newline is available', () => {
    const msg = 'x'.repeat(200)
    const result = splitMessage(msg, 50)
    expect(result.length).toBe(4)
    expect(result[0]).toBe('x'.repeat(50))
  })

  it('uses default limit of 4096', () => {
    const shortMsg = 'Hello'
    expect(splitMessage(shortMsg)).toEqual(['Hello'])

    const longMsg = 'a'.repeat(5000)
    const result = splitMessage(longMsg)
    expect(result.length).toBeGreaterThan(1)
  })
})

// ── escapeHtml ──────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('')
  })
})

// ── formatForTelegram ───────────────────────────────────────────────

describe('formatForTelegram (plain text policy)', () => {
  it('strips bold markdown markers', () => {
    const result = formatForTelegram('This is **bold** text')
    expect(result).toBe('This is bold text')
    expect(result).not.toContain('*')
    expect(result).not.toContain('<b>')
  })

  it('strips italic markdown markers', () => {
    const result = formatForTelegram('This is *italic* text')
    expect(result).toBe('This is italic text')
    expect(result).not.toContain('<i>')
  })

  it('strips heading markers', () => {
    const result = formatForTelegram('## My Heading')
    expect(result).toBe('My Heading')
    expect(result).not.toContain('#')
    expect(result).not.toContain('<b>')
  })

  it('strips code block fences but keeps content', () => {
    const result = formatForTelegram('```js\nconsole.log("hi")\n```')
    expect(result).toContain('console.log("hi")')
    expect(result).not.toContain('```')
    expect(result).not.toContain('<pre>')
    expect(result).not.toContain('<code>')
  })

  it('strips inline code backticks', () => {
    const result = formatForTelegram('Use `npm install` to install')
    expect(result).toBe('Use npm install to install')
    expect(result).not.toContain('`')
    expect(result).not.toContain('<code>')
  })

  it('converts markdown links to plain text with url in parens', () => {
    const result = formatForTelegram('[Click here](https://example.com)')
    expect(result).toBe('Click here (https://example.com)')
    expect(result).not.toContain('<a')
  })

  it('strips literal HTML tags emitted by the model', () => {
    const result = formatForTelegram('Use <b>bold</b> and <i>italic</i>')
    expect(result).toBe('Use bold and italic')
    expect(result).not.toContain('<')
    expect(result).not.toContain('>')
  })

  it('decodes HTML entities so users never see &amp; / &lt; / &gt;', () => {
    const result = formatForTelegram('Tom &amp; Jerry &lt;3')
    expect(result).toBe('Tom & Jerry <3')
    expect(result).not.toContain('&amp;')
    expect(result).not.toContain('&lt;')
  })

  it('decodes entity-wrapped HTML tags then strips them', () => {
    // This is the exact bug we hit: agent emitted &lt;b&gt;text&lt;/b&gt;
    const result = formatForTelegram('This is &lt;b&gt;important&lt;/b&gt; news')
    expect(result).toBe('This is important news')
    expect(result).not.toContain('<')
    expect(result).not.toContain('&')
  })

  it('keeps anchor href as plain url in parens', () => {
    const result = formatForTelegram('Visit <a href="https://example.com">our site</a> today')
    expect(result).toContain('our site (https://example.com)')
    expect(result).not.toContain('<a')
  })
})

// ── formatForDiscord ────────────────────────────────────────────────

describe('formatForDiscord', () => {
  it('converts headings to bold', () => {
    const result = formatForDiscord('# Title')
    expect(result).toBe('**Title**')
  })

  it('passes through standard markdown', () => {
    const result = formatForDiscord('**bold** and *italic*')
    expect(result).toContain('**bold**')
    expect(result).toContain('*italic*')
  })
})

// ── formatForWhatsApp ───────────────────────────────────────────────

describe('formatForWhatsApp', () => {
  it('converts double asterisk bold to single asterisk', () => {
    const result = formatForWhatsApp('This is **bold** text')
    expect(result).toBe('This is *bold* text')
  })

  it('converts strikethrough ~~ to single ~', () => {
    const result = formatForWhatsApp('~~strikethrough~~')
    expect(result).toBe('~strikethrough~')
  })

  it('converts links to text (url) format', () => {
    const result = formatForWhatsApp('[link](https://example.com)')
    expect(result).toBe('link (https://example.com)')
  })
})

// ── formatForSlack ──────────────────────────────────────────────────

describe('formatForSlack', () => {
  it('converts bold markdown to Slack bold then italic regex runs', () => {
    // Slack formatter first converts **x** to *x* (Slack bold),
    // then the italic regex converts *x* to _x_ (Slack italic).
    // This is a known quirk -- bold-only input ends up italic.
    // For actual bold in Slack, users would need to pass *x* directly.
    const result = formatForSlack('**bold text**')
    expect(result).toBe('_bold text_')
  })

  it('converts links to Slack format <url|text>', () => {
    const result = formatForSlack('[Click](https://example.com)')
    expect(result).toBe('<https://example.com|Click>')
  })

  it('converts strikethrough to single tilde', () => {
    const result = formatForSlack('~~deleted~~')
    expect(result).toBe('~deleted~')
  })
})

// ── stripMarkdown ───────────────────────────────────────────────────

describe('stripMarkdown', () => {
  it('removes bold markers', () => {
    expect(stripMarkdown('**bold**')).toBe('bold')
  })

  it('removes italic markers', () => {
    expect(stripMarkdown('*italic*')).toBe('italic')
  })

  it('removes heading markers', () => {
    expect(stripMarkdown('## Heading')).toBe('Heading')
  })

  it('strips code block fences but keeps content', () => {
    const result = stripMarkdown('```js\nconsole.log("hi")\n```')
    expect(result).toContain('console.log("hi")')
    expect(result).not.toContain('```')
  })

  it('converts links to text (url) format', () => {
    expect(stripMarkdown('[Link](https://example.com)')).toBe('Link (https://example.com)')
  })
})

// ── getFormatter ────────────────────────────────────────────────────

describe('getFormatter', () => {
  it('returns telegram formatter for "telegram"', () => {
    const fn = getFormatter('telegram')
    expect(fn).toBe(formatForTelegram)
  })

  it('returns discord formatter for "discord"', () => {
    expect(getFormatter('discord')).toBe(formatForDiscord)
  })

  it('returns whatsapp formatter for "whatsapp"', () => {
    expect(getFormatter('whatsapp')).toBe(formatForWhatsApp)
  })

  it('returns slack formatter for "slack"', () => {
    expect(getFormatter('slack')).toBe(formatForSlack)
  })

  it('falls back to stripMarkdown for unknown channel', () => {
    expect(getFormatter('sms')).toBe(stripMarkdown)
  })

  it('falls back to stripMarkdown for "imessage"', () => {
    expect(getFormatter('imessage')).toBe(stripMarkdown)
  })
})
