export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface Budget {
  total: number
  remaining: number
  exhausted: boolean
  consume(tokens: number): void
  consumeText(text: string): number
}

export function createBudget(total: number): Budget {
  const state = { remaining: total }
  return {
    total,
    get remaining() { return state.remaining },
    get exhausted() { return state.remaining <= 0 },
    consume(tokens: number) { state.remaining -= tokens },
    consumeText(text: string) { const t = estimateTokens(text); state.remaining -= t; return t },
  }
}

export function fitToBudget(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const suffix = '... [truncated]'
  const availableChars = Math.max(0, (maxTokens - estimateTokens(suffix)) * 4)
  return text.slice(0, availableChars) + suffix
}
