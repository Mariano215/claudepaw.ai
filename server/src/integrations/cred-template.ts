const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g

export function fillTemplate(template: string, creds: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    if (!(key in creds)) throw new Error(`missing credential: ${key}`)
    return creds[key]!
  })
}

export function redactTemplate(template: string): string {
  return template
}

export function parseHeaderTemplate(filled: string): { name: string; value: string } {
  const idx = filled.indexOf(':')
  if (idx === -1) throw new Error(`invalid header template (no colon)`)
  return { name: filled.slice(0, idx).trim(), value: filled.slice(idx + 1).trim() }
}
