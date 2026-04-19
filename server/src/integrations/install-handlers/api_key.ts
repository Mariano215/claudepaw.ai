import type { IntegrationManifest } from '../schema.js'
import { fillTemplate, parseHeaderTemplate } from '../cred-template.js'

export type VerifyResult = {
  status: 'connected' | 'error'
  account?: string
  error?: string
}

function sanitize(message: string, creds: Record<string, string>): string {
  let out = message
  for (const v of Object.values(creds)) {
    if (v && v.length >= 6) out = out.split(v).join('[REDACTED]')
  }
  return out
}

export async function verifyApiKeyIntegration(
  manifest: IntegrationManifest,
  creds: Record<string, string>,
): Promise<VerifyResult> {
  if (manifest.verify.kind !== 'http_get') {
    return { status: 'error', error: `unexpected verify kind: ${manifest.verify.kind}` }
  }
  const v = manifest.verify
  let header: { name: string; value: string }
  try {
    header = parseHeaderTemplate(fillTemplate(v.header_template, creds))
  } catch (err: any) {
    return { status: 'error', error: sanitize(err.message ?? String(err), creds) }
  }
  try {
    const res = await fetch(v.endpoint, { headers: { [header.name]: header.value } })
    if (res.status !== v.expect_status) {
      const body = await res.text().catch(() => '')
      return { status: 'error', error: sanitize(`expected ${v.expect_status}, got ${res.status}: ${body.slice(0, 200)}`, creds) }
    }
    let account: string | undefined
    if (v.account_field) {
      try {
        const json = await res.clone().json() as Record<string, unknown>
        const val = json[v.account_field]
        if (typeof val === 'string') account = val
      } catch { /* not JSON, no account */ }
    }
    return { status: 'connected', account }
  } catch (err: any) {
    return { status: 'error', error: sanitize(err.message ?? String(err), creds) }
  }
}
