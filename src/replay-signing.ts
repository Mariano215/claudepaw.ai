// Signing for the replayable command on a policy card.
//
// The card runner executes the argv recorded on the card. That row lives in
// action_items.description, which the dashboard API lets any project editor
// edit and which an agent can reach through the action CLI, so an unsigned
// argv is an arbitrary-command path running with the bot's full environment.
// The signature is minted inside checkAction, where the argv comes from the
// process.argv of the CLI that is actually running, and checked again
// immediately before exec.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { CREDENTIAL_ENCRYPTION_KEY, WS_SECRET } from './config.js'

export interface CardReplay {
  argv: string[]
  cwd: string
  sig?: string
}

// The HMAC key is derived, not used raw, so the card signature cannot be
// replayed against any other use of the same secret.
function signingKey(): Buffer | null {
  const secret = CREDENTIAL_ENCRYPTION_KEY || WS_SECRET
  if (!secret) return null
  return createHash('sha256').update(`claudepaw:card-replay:${secret}`).digest()
}

/** False when neither secret is configured, so no replay may be recorded. */
export function canSignReplay(): boolean {
  return signingKey() !== null
}

// Fixed key order, so the bytes signed do not depend on object construction.
function canonical(cardId: string, argv: string[], cwd: string): string {
  return JSON.stringify({ argv, cardId, cwd })
}

export function signReplay(cardId: string, argv: string[], cwd: string): string | null {
  const key = signingKey()
  if (!key) return null
  return createHmac('sha256', key).update(canonical(cardId, argv, cwd)).digest('hex')
}

export function verifyReplaySignature(cardId: string, replay: CardReplay): boolean {
  if (typeof replay.sig !== 'string' || replay.sig.length === 0) return false
  const expected = signReplay(cardId, replay.argv, replay.cwd)
  if (!expected) return false
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(replay.sig, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
