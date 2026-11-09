// ---------------------------------------------------------------------------
// Per-platform message formatters
//
// Claude outputs markdown. Each formatter converts to the target platform's
// native format. Shared utilities (splitting, escaping) live here too.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Split a long message into chunks that fit the platform's limit.
 * Prefers splitting at newlines, then spaces, then hard-cuts.
 */
export function splitMessage(text: string, limit: number = 4096): string[] {
  if (text.length <= limit) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', limit)
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', limit)
    }
    if (splitAt <= 0) {
      splitAt = limit
    }

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Telegram (plain text -- by user policy)
//
// We deliberately do NOT use Telegram's HTML or MarkdownV2 modes. Every
// message we send is plain text. That means:
//   - No <b>/<i>/<code>/<pre>/<a> tags
//   - No markdown formatting markers leaking through
//   - No HTML entities (&amp;, &lt;, &gt;, &quot;, etc.) -- they get decoded
//
// If the model returns markdown or HTML, we strip it back to readable text.
// ---------------------------------------------------------------------------

/** Decode the most common HTML entities back to their character form. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&') // last so we don't double-decode
}

/** Strip HTML tags but keep their inner text. <a href="x">y</a> becomes "y (x)". */
function stripHtmlTags(text: string): string {
  let result = text
  // Anchor tags: keep text and url
  result = result.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
  // <br> -> newline
  result = result.replace(/<br\s*\/?>/gi, '\n')
  // <pre>/<code> wrappers: keep inner text
  result = result.replace(/<\/?(?:pre|code|b|strong|i|em|u|s|strike|del|ins|tt|kbd|span|div|p|h[1-6])(?:\s[^>]*)?>/gi, '')
  // Anything else
  result = result.replace(/<[^>]+>/g, '')
  return result
}

export function formatForTelegram(text: string): string {
  let result = text

  // 1. Decode HTML entities first so &lt;b&gt; becomes <b>, ready to be stripped.
  result = decodeHtmlEntities(result)

  // 2. Strip any HTML tags the model may have generated.
  result = stripHtmlTags(result)

  // 3. Strip markdown formatting markers (bold, italic, headings, code fences, links, etc.)
  result = stripMarkdown(result)

  return result.trim()
}

// ---------------------------------------------------------------------------
// Discord (Markdown -- mostly passthrough, minor tweaks)
// ---------------------------------------------------------------------------

export function formatForDiscord(text: string): string {
  // Discord supports standard markdown natively.
  // Just strip HTML-style links if any snuck in, and limit heading depth.
  let result = text

  // Convert HTML links to markdown links (in case agent output has them)
  result = result.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '[$2]($1)')

  // Discord doesn't render h1-h6 -- convert to bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')

  return result.trim()
}

// ---------------------------------------------------------------------------
// WhatsApp (WhatsApp markdown)
// ---------------------------------------------------------------------------

export function formatForWhatsApp(text: string): string {
  let result = text

  // Protect code blocks (WhatsApp uses triple backtick too)
  const codeBlocks: string[] = []
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push('```' + code.trimEnd() + '```')
    return `%%CODEBLOCK_${idx}%%`
  })

  // Bold: **text** -> *text* (WhatsApp uses single asterisk)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')

  // Italic: keep _text_ as-is (WhatsApp uses underscore)
  // Strikethrough: ~~text~~ -> ~text~ (WhatsApp uses single tilde)
  result = result.replace(/~~(.+?)~~/g, '~$1~')

  // Headings -> bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Links: [text](url) -> text (url) -- WhatsApp auto-links URLs
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // Strip horizontal rules
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`%%CODEBLOCK_${i}%%`, codeBlocks[i])
  }

  return result.trim()
}

// ---------------------------------------------------------------------------
// Slack (mrkdwn)
// ---------------------------------------------------------------------------

export function formatForSlack(text: string): string {
  let result = text

  // Protect code blocks (Slack uses triple backtick too)
  const codeBlocks: string[] = []
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push('```' + code.trimEnd() + '```')
    return `%%CODEBLOCK_${idx}%%`
  })

  // Protect inline code
  const inlineCode: string[] = []
  result = result.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCode.length
    inlineCode.push('`' + code + '`')
    return `%%INLINE_${idx}%%`
  })

  // Bold: **text** -> *text* (Slack uses single asterisk for bold)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*')

  // Italic: *text* or _text_ -> _text_ (Slack uses underscore for italic)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '_$1_')

  // Strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, '~$1~')

  // Headings -> bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

  // Strip horizontal rules
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  // Restore
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`%%CODEBLOCK_${i}%%`, codeBlocks[i])
  }
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`%%INLINE_${i}%%`, inlineCode[i])
  }

  return result.trim()
}

// ---------------------------------------------------------------------------
// iMessage / Plain text
// ---------------------------------------------------------------------------

export function stripMarkdown(text: string): string {
  let result = text

  // Remove code block fences but keep the content
  result = result.replace(/```\w*\n?/g, '')

  // Remove inline code backticks
  result = result.replace(/`([^`]+)`/g, '$1')

  // Bold/italic markers
  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/__(.+?)__/g, '$1')
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '$1')
  result = result.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '$1')
  result = result.replace(/~~(.+?)~~/g, '$1')

  // Headings: strip the # prefix
  result = result.replace(/^#{1,6}\s+/gm, '')

  // Links: [text](url) -> text (url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')

  // Checkboxes
  result = result.replace(/- \[ \]/g, '[ ]')
  result = result.replace(/- \[x\]/gi, '[x]')

  // Horizontal rules
  result = result.replace(/^---+$/gm, '')
  result = result.replace(/^\*\*\*+$/gm, '')

  return result.trim()
}

// ---------------------------------------------------------------------------
// Lookup by channel ID
// ---------------------------------------------------------------------------

const formatterMap: Record<string, (text: string) => string> = {
  telegram: formatForTelegram,
  discord: formatForDiscord,
  whatsapp: formatForWhatsApp,
  slack: formatForSlack,
  imessage: stripMarkdown,
}

/**
 * Get the formatter for a given channel ID. Falls back to plain text.
 */
export function getFormatter(channelId: string): (text: string) => string {
  return formatterMap[channelId] ?? stripMarkdown
}
