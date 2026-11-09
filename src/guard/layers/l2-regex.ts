// src/guard/layers/l2-regex.ts
import type { L2Result } from '../types.js'

interface PatternEntry {
  name: string
  regex: RegExp
}

// Compiled at module load time, case-insensitive
const PATTERNS: PatternEntry[] = [
  // --- Direct instruction hijacking ---
  {
    name: 'instruction-ignore',
    regex: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i,
  },
  {
    name: 'instruction-disregard',
    regex: /disregard\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i,
  },
  {
    name: 'instruction-forget',
    regex: /forget\s+(all\s+)?(previous|prior|above|earlier|your)\s+instructions?/i,
  },
  {
    name: 'role-override-you-are-now',
    regex: /\byou\s+are\s+now\b/i,
  },
  {
    name: 'role-override-act-as',
    regex: /\bact\s+as\s+(if\s+)?(you\s+are|a)\b/i,
  },
  {
    name: 'role-override-pretend',
    regex: /\bpretend\s+(to\s+be|you\s+are|you\s+have)\b/i,
  },
  {
    name: 'new-instructions',
    regex: /\bnew\s+instructions?\s*:/i,
  },
  {
    name: 'system-tag',
    regex: /<\s*system\s*>/i,
  },
  {
    name: 'system-prefix',
    regex: /\bsystem\s*:\s*/i,
  },

  // --- System prompt exfiltration ---
  {
    name: 'exfil-repeat-prompt',
    regex: /(repeat|reveal|show|print|output|display|tell\s+me)\s+.{0,30}(system\s+prompt|instructions?|configuration)/i,
  },
  {
    name: 'exfil-what-is-prompt',
    regex: /what\s+(are|is)\s+your\s+(system\s+prompt|instructions?|initial\s+prompt)/i,
  },
  {
    name: 'exfil-verbatim',
    regex: /(verbatim|word\s+for\s+word).{0,30}(instructions?|system\s+prompt)/i,
  },

  // --- Markdown/HTML exfiltration vectors ---
  {
    name: 'exfil-markdown-image',
    regex: /!\[.*?\]\(https?:\/\//i,
  },
  {
    name: 'exfil-img-tag',
    regex: /<img\s+[^>]*src\s*=/i,
  },
  {
    name: 'exfil-anchor-tag',
    regex: /<a\s+[^>]*href\s*=/i,
  },
  {
    name: 'exfil-iframe',
    regex: /<iframe/i,
  },
  {
    name: 'exfil-script',
    regex: /<script/i,
  },
]

export function scanRegex(text: string): L2Result {
  const matchedPatterns: string[] = []

  for (const entry of PATTERNS) {
    if (entry.regex.test(text)) {
      matchedPatterns.push(entry.name)
    }
  }

  const isFlagged = matchedPatterns.length > 0
  const flagReason = isFlagged
    ? `Regex patterns matched: ${matchedPatterns.join(', ')}`
    : null

  return {
    layer: 'l2-regex',
    matchedPatterns,
    isFlagged,
    flagReason,
  }
}

// Export patterns for use in L6 output validation
export { PATTERNS as REGEX_PATTERNS }
