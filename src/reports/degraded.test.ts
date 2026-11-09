import { describe, it, expect } from 'vitest'
import { renderDigestText } from './digest-text.js'
import { fixture } from './digest-fixture.js'
import type { ReportData } from './types.js'

// B3: integration_id is the metric_health row id (an integer), not a name, so
// the rendered line uses platform plus project_id instead.
const withDegraded: ReportData = {
  ...fixture,
  degraded_integrations: [
    { integration_id: 12, project_id: 'example-company', platform: 'wordpress', status: 'failing', attempts: 16, reason: 'credential expired' },
    { integration_id: 7, project_id: 'default', platform: 'linkedin', status: 'failing', attempts: 16, reason: null },
  ],
}

describe('degraded integrations in the digest', () => {
  it('lists each broken integration once under Failures', () => {
    const text = renderDigestText(withDegraded)
    const failuresIdx = text.indexOf('Failures')
    expect(failuresIdx).toBeGreaterThan(-1)
    expect(text.indexOf('wordpress')).toBeGreaterThan(failuresIdx)
    expect(text).toContain('example-company')
    expect(text).toContain('16 attempts')
  })

  it('says nothing when every integration is healthy', () => {
    const text = renderDigestText({ ...fixture, degraded_integrations: [] })
    expect(text).not.toContain('attempts')
  })

  it('is plain text: no markdown markers and no HTML tags', () => {
    const text = renderDigestText(withDegraded)
    expect(text).not.toMatch(/[*_`]|<[a-z/]/i)
  })
})
