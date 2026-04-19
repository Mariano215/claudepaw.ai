import * as base from '../embeddings.js'
import { logger } from '../logger.js'

export async function embedBatchOptimized(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const cache = new Map<string, Promise<number[]>>()
  return Promise.all(texts.map(t => {
    let p = cache.get(t)
    if (!p) { p = base.embedText(t); cache.set(t, p) }
    return p
  }))
}

export async function embedWithRetry(text: string, opts: { maxAttempts: number; baseDelayMs: number } = { maxAttempts: 3, baseDelayMs: 200 }): Promise<number[]> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const r = await base.embedText(text)
    if (r.length > 0) return r
    if (attempt < opts.maxAttempts) {
      await new Promise(res => setTimeout(res, opts.baseDelayMs * Math.pow(2, attempt - 1)))
    }
  }
  logger.warn({ preview: text.slice(0, 40) }, 'embed failed all retries')
  return []
}
