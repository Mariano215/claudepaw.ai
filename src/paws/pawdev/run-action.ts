// src/paws/pawdev/run-action.ts
// Binds executePawdevAction to the real shell and the real card lookup, so
// telegram.ts never imports a shell runner or the db layer directly.
import { getActionItem } from '../../db.js'
import { executePawdevAction, isPawdevAction, type PawdevAction, type AskCard } from './actions.js'

export { isPawdevAction }
import { realShell } from '../handlers/pawdev-builder.js'

export function runPawdevAction(action: PawdevAction, cardId: string): Promise<{ ok: boolean; message: string }> {
  return executePawdevAction(action, cardId, {
    sh: realShell,
    card: (id) => (getActionItem(id) as unknown as AskCard) ?? null,
  })
}
