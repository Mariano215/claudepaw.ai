// src/guard/layers/l1-sanitize.ts
import type { L1Result } from '../types.js'
import { GUARD_CONFIG } from '../config.js'

// Unicode ranges to strip:
// U+200B-U+200F: zero-width space, ZWNJ, ZWJ, LRM, RLM
// U+2028-U+2029: line separator, paragraph separator
// U+202A-U+202F: directional overrides (LRE, RLE, PDF, LRO, RLO, NNBSP)
// U+2060: word joiner
// U+FEFF: BOM / zero-width no-break space
const INVISIBLE_RE = /[\u200B-\u200F\u2028-\u2029\u202A-\u202F\u2060\uFEFF]/g

export function sanitize(
  input: string,
  maxChars?: number,
): L1Result {
  const limit = maxChars ?? GUARD_CONFIG.maxInputChars

  // 1. Count invisible chars before stripping
  const invisibleMatches = input.match(INVISIBLE_RE)
  const removedCount = invisibleMatches ? invisibleMatches.length : 0

  // 2. Strip invisible Unicode (replace with space to maintain word boundaries)
  const stripped = input.replace(INVISIBLE_RE, ' ')

  // 3. Collapse whitespace runs to single spaces
  const collapsed = stripped.replace(/\s+/g, ' ')

  // 4. Trim
  const trimmed = collapsed.trim()

  // 5. Truncate at word boundary
  let wasTruncated = false
  let cleanedText = trimmed

  if (trimmed.length > limit) {
    wasTruncated = true
    // Find last space before limit
    const truncated = trimmed.slice(0, limit)
    const lastSpace = truncated.lastIndexOf(' ')
    cleanedText = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated
  }

  return {
    layer: 'l1-sanitize',
    cleanedText,
    charsRemoved: removedCount,
    wasTruncated,
  }
}
