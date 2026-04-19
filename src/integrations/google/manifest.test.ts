import { describe, it, expect } from 'vitest'
import { googleManifest, GOOGLE_SCOPES } from './manifest.js'

describe('Google manifest', () => {
  it('has correct name and display name', () => {
    expect(googleManifest.name).toBe('google')
    expect(googleManifest.displayName).toBe('Google Workspace')
  })

  it('uses oauth2 auth type', () => {
    expect(googleManifest.authType).toBe('oauth2')
  })

  it('has OAuth config with Google URLs', () => {
    expect(googleManifest.oauth).toBeDefined()
    expect(googleManifest.oauth!.authUrl).toContain('accounts.google.com')
    expect(googleManifest.oauth!.tokenUrl).toContain('oauth2.googleapis.com')
  })

  it('requires access_token and refresh_token', () => {
    expect(googleManifest.requiredKeys).toContain('access_token')
    expect(googleManifest.requiredKeys).toContain('refresh_token')
  })

  it('exports scope constants', () => {
    expect(GOOGLE_SCOPES.GMAIL_MODIFY).toContain('gmail')
    expect(GOOGLE_SCOPES.DRIVE).toContain('drive')
    expect(GOOGLE_SCOPES.SHEETS).toContain('spreadsheets')
    expect(GOOGLE_SCOPES.CALENDAR).toContain('calendar')
  })

  it('includes all scopes in availableScopes', () => {
    const allScopes = Object.values(GOOGLE_SCOPES)
    for (const scope of allScopes) {
      expect(googleManifest.oauth!.availableScopes).toContain(scope)
    }
  })
})
