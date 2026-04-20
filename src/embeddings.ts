import Database from 'better-sqlite3'
import {
  EMBEDDING_PROVIDER,
  EMBEDDING_MODEL,
  EMBEDDING_BASE_URL,
  OPENAI_API_KEY,
  BOT_TOKEN,
  ALLOWED_CHAT_ID,
} from './config.js'
import { logger } from './logger.js'

// Target embedding dimension. 768 matches nomic-embed-text (Ollama default)
// and is requested explicitly from OpenAI so fallback vectors land in the
// same vec_embeddings shape.
const EMBEDDING_DIM = 768
const OLLAMA_ALERT_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour between repeat alerts
const OLLAMA_GRACE_PERIOD_MS = 3 * 60 * 1000    // 3 min grace before first alert (covers reboots)
let lastOllamaAlertAt = 0
let ollamaFirstDownAt = 0 // 0 = Ollama is healthy (or never tried); non-zero = first failure timestamp

// ── Public API ─────────────────────────────────────────────────────────────

/** Embed a single text. Returns empty array on failure — never throws. */
export async function embedText(text: string): Promise<number[]> {
  if (!text.trim()) return []
  return _embedWithProvider(text, EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_PROVIDER)
}

/** Embed multiple texts. Returns parallel array — failed embeds are empty arrays. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map((t) => embedText(t)))
}

/** Store an embedding in vec_embeddings. No-ops if vec table unavailable or embedding empty. */
export function storeEmbedding(
  db: Database.Database,
  targetType: 'observation' | 'entity' | 'memory',
  targetId: number,
  embedding: number[],
): void {
  if (embedding.length === 0) return
  try {
    // vec0 requires strict INTEGER for target_id. better-sqlite3 serializes JS
    // Number as FLOAT, so wrap in BigInt to force the int path.
    db
      .prepare('INSERT OR REPLACE INTO vec_embeddings (target_type, target_id, embedding) VALUES (?, ?, ?)')
      .run(targetType, BigInt(targetId), new Float32Array(embedding))
  } catch (err) {
    logger.debug({ err, targetType, targetId }, 'vec_embeddings insert skipped')
  }
}

/** KNN search in vec_embeddings. Returns empty array if table unavailable or embedding empty. */
export function vecSearch(
  db: Database.Database,
  embedding: number[],
  limit = 10,
): Array<{ target_type: string; target_id: number; distance: number }> {
  if (embedding.length === 0) return []
  try {
    return db
      .prepare('SELECT target_type, target_id, distance FROM vec_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
      .all(new Float32Array(embedding), limit) as Array<{ target_type: string; target_id: number; distance: number }>
  } catch (err) {
    logger.debug({ err }, 'vec_embeddings search skipped')
    return []
  }
}

// ── Internal (exported for testing) ───────────────────────────────────────

/** Reset alert state between tests. */
export function _resetOllamaAlertState(): void {
  lastOllamaAlertAt = 0
  ollamaFirstDownAt = 0
}

export async function _embedWithProvider(
  text: string,
  baseUrl: string,
  model: string,
  provider: 'ollama' | 'openai',
): Promise<number[]> {
  // Try configured provider first.
  try {
    const result = provider === 'ollama'
      ? await _ollamaEmbed(text, baseUrl, model)
      : await _openaiEmbed(text, model, EMBEDDING_DIM)
    // Ollama came back up — reset the outage clock so the next outage gets a fresh grace window.
    if (provider === 'ollama') ollamaFirstDownAt = 0
    return result
  } catch (err) {
    logger.debug({ err, provider, model }, 'primary embedding attempt failed')
    // Ollama primary: fall back to OpenAI if key is configured.
    if (provider === 'ollama' && OPENAI_API_KEY) {
      // Record the start of this outage (only on the first failure).
      if (ollamaFirstDownAt === 0) ollamaFirstDownAt = Date.now()
      void maybeAlertOllamaDown(err)
      try {
        return await _openaiEmbed(text, 'text-embedding-3-small', EMBEDDING_DIM)
      } catch (fallbackErr) {
        logger.debug({ err: fallbackErr }, 'openai fallback also failed')
        return []
      }
    }
    return []
  }
}

// Alert Telegram when Ollama is unreachable — but only after a grace period
// (covers reboots / service restarts). Subsequent alerts are suppressed for
// OLLAMA_ALERT_COOLDOWN_MS so we don't spam during a prolonged outage.
// Uses raw fetch to avoid importing the Telegram channel (circular risk).
async function maybeAlertOllamaDown(originalErr: unknown): Promise<void> {
  const now = Date.now()
  // Still inside the grace window — Ollama may just be restarting, stay quiet.
  if (ollamaFirstDownAt > 0 && now - ollamaFirstDownAt < OLLAMA_GRACE_PERIOD_MS) return
  if (now - lastOllamaAlertAt < OLLAMA_ALERT_COOLDOWN_MS) return
  if (!BOT_TOKEN || !ALLOWED_CHAT_ID) return
  lastOllamaAlertAt = now
  const errMsg = originalErr instanceof Error ? originalErr.message : String(originalErr)
  const text = `Ollama embedding unreachable, falling back to OpenAI. Error: ${errMsg.slice(0, 200)}`
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ALLOWED_CHAT_ID, text }),
      signal: AbortSignal.timeout(5000),
    })
  } catch (alertErr) {
    logger.debug({ err: alertErr }, 'ollama down alert send failed')
  }
}

async function _ollamaEmbed(text: string, baseUrl: string, model: string): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Ollama embed HTTP ${res.status}`)
  const json = (await res.json()) as { embedding: number[] }
  return json.embedding
}

async function _openaiEmbed(text: string, model: string, dimensions?: number): Promise<number[]> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')
  // Gate bypass protection: OpenAI embeddings are billed; honor the kill
  // switch so a paused system cannot burn quota via backfill loops.
  // (Ollama/local providers skip this check — they're free.)
  try {
    const { checkKillSwitch } = await import('./cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ reason: sw.reason }, 'OpenAI embed skipped: kill switch tripped')
      return []
    }
  } catch {
    // Fail-closed: if we can't verify, don't burn paid quota.
    return []
  }
  const body: Record<string, unknown> = { model, input: text }
  if (dimensions) body.dimensions = dimensions
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`OpenAI embed HTTP ${res.status}`)
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> }
  return json.data[0].embedding
}
