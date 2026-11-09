// Thin, testable wrappers around checkAction for the CLI entry points. The
// CLIs are top-level scripts with no exports, so the decision logic lives
// here and the CLI keeps three lines.
import { checkAction } from './policy.js'
import { logger } from './logger.js'

/**
 * What the card runner needs to perform the effect after an approval tap: the
 * exact command this process was started with. Without it the card carries a
 * JSON blob nothing can replay, and the runner's agent opens a second card
 * instead of doing the work.
 */
function cliReplay(): { argv: string[]; cwd: string } {
  return { argv: process.argv.slice(1), cwd: process.cwd() }
}

/**
 * A gate refusal (denied, parked) is a different thing from a send failure:
 * the caller must be able to tell "policy stopped this" from "the send
 * itself failed", so a non-allow decision never falls back to a Telegram
 * notice the way a real send failure does.
 */
export type EmailGateResult<T> =
  | { kind: 'allow'; result: T }
  | { kind: 'parked'; cardId: string | null }
  | { kind: 'denied' }

export async function gateEmailSend<T>(
  projectId: string,
  meta: { to: string; subject: string },
  send: () => Promise<T>,
): Promise<EmailGateResult<T>> {
  const decision = await checkAction(projectId, 'email.send', 'email-send-cli', { ...meta, replay: cliReplay() })
  if (decision === 'deny') return { kind: 'denied' }
  if (decision !== 'allow') {
    const cardId = decision.startsWith('pending:') ? decision.slice('pending:'.length) : null
    return { kind: 'parked', cardId }
  }
  return { kind: 'allow', result: await send() }
}

export async function gateScheduleChange(
  projectId: string,
  op: string,
  taskId: string,
  mutate: () => void,
): Promise<boolean> {
  const decision = await checkAction(projectId, 'schedule.change', 'schedule-cli', { op, task_id: taskId, replay: cliReplay() })
  if (decision !== 'allow') {
    logger.warn({ decision, op, taskId }, 'schedule change held by policy')
    return false
  }
  mutate()
  return true
}
