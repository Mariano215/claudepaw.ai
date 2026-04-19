import { describe, it, expect } from 'vitest'
import {
  IntegrationNotConnectedError,
  TokenExpiredError,
  InsufficientScopeError,
  GoogleApiError,
} from './errors.js'

describe('integration errors', () => {
  it('IntegrationNotConnectedError has correct properties', () => {
    const err = new IntegrationNotConnectedError('example-company', 'google', 'user@gmail.com')
    expect(err.message).toContain('example-company')
    expect(err.message).toContain('google')
    expect(err.message).toContain('user@gmail.com')
    expect(err.projectId).toBe('example-company')
    expect(err.service).toBe('google')
    expect(err.account).toBe('user@gmail.com')
    expect(err instanceof Error).toBe(true)
  })

  it('TokenExpiredError has correct properties', () => {
    const err = new TokenExpiredError('example-company', 'google', 'user@gmail.com')
    expect(err.message).toContain('expired')
    expect(err.projectId).toBe('example-company')
    expect(err instanceof Error).toBe(true)
  })

  it('InsufficientScopeError lists missing scopes', () => {
    const err = new InsufficientScopeError('example-company', 'google', 'user@gmail.com', ['drive', 'calendar'])
    expect(err.message).toContain('drive')
    expect(err.missingScopes).toEqual(['drive', 'calendar'])
    expect(err instanceof Error).toBe(true)
  })

  it('GoogleApiError wraps status and message', () => {
    const err = new GoogleApiError(403, 'Forbidden', 'gmail.search')
    expect(err.statusCode).toBe(403)
    expect(err.apiMessage).toBe('Forbidden')
    expect(err.method).toBe('gmail.search')
    expect(err instanceof Error).toBe(true)
  })
})
