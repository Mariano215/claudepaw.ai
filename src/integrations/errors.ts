export class IntegrationNotConnectedError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly service: string,
    public readonly account?: string,
  ) {
    const acct = account ? ` (${account})` : ''
    super(`Integration ${service}${acct} not connected for project ${projectId}. Connect it on the dashboard.`)
    this.name = 'IntegrationNotConnectedError'
  }
}

export class TokenExpiredError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly service: string,
    public readonly account?: string,
  ) {
    const acct = account ? ` (${account})` : ''
    super(`Token expired for ${service}${acct} in project ${projectId}. Reconnect on the dashboard.`)
    this.name = 'TokenExpiredError'
  }
}

export class InsufficientScopeError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly service: string,
    public readonly account: string,
    public readonly missingScopes: string[],
  ) {
    super(`Insufficient scopes for ${service} (${account}) in project ${projectId}. Missing: ${missingScopes.join(', ')}. Reconnect with additional permissions on the dashboard.`)
    this.name = 'InsufficientScopeError'
  }
}

export class GoogleApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly apiMessage: string,
    public readonly method: string,
  ) {
    super(`Google API error in ${method}: ${statusCode} ${apiMessage}`)
    this.name = 'GoogleApiError'
  }
}
