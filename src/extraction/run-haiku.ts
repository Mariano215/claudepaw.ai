import { spawn } from 'node:child_process'
import { CLAUDE_BINARY } from '../agent-runtime.js'
import { ANTHROPIC_API_KEY } from '../config.js'
import { logger } from '../logger.js'

const DEFAULT_MODEL = 'claude-haiku-4-5'
const DEFAULT_TIMEOUT_MS = 60_000

export interface RunHaikuOptions {
  model?: string
  timeoutMs?: number
  /** When true and the CLI fails, fall back to a direct Anthropic API call. */
  apiFallback?: boolean
  maxTokens?: number
}

/**
 * Runs a one-shot Haiku prompt through the local `claude` CLI binary so the
 * call uses the operator's Pro/Max subscription auth (keychain) instead of
 * the paid Anthropic API. Returns the assistant text or '' on failure.
 *
 * Why a CLI spawn instead of runAgent(): runAgent sets up the full agent
 * context (tools, working dir, sessions, hooks). For pure prompt -> JSON
 * extraction we want zero of that. The flags below disable everything except
 * the model call:
 *   --print                    non-interactive, exit after one turn
 *   --model claude-haiku-4-5   explicit small model
 *   --tools ""                 no tool use
 *   --disable-slash-commands   skip skill resolution
 *   --no-session-persistence   no .session files written
 *
 * NOTE: we deliberately do NOT pass --bare. --bare forces API-key auth
 * (no keychain), which would defeat the whole point of this helper.
 */
export async function runHaikuPrompt(prompt: string, opts: RunHaikuOptions = {}): Promise<string> {
  const model = opts.model ?? DEFAULT_MODEL
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cliResult = await runViaCli(prompt, model, timeoutMs)
  if (cliResult !== null) return cliResult
  if (opts.apiFallback && ANTHROPIC_API_KEY) {
    return runViaApi(prompt, model, opts.maxTokens ?? 2000)
  }
  return ''
}

async function runViaCli(prompt: string, model: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(CLAUDE_BINARY, [
      '--print',
      '--model', model,
      '--tools', '',
      '--disable-slash-commands',
      '--no-session-persistence',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* noop */ }
      logger.warn({ timeoutMs, model }, 'haiku cli timed out')
      resolve(null)
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      logger.warn({ err, model }, 'haiku cli spawn failed')
      resolve(null)
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        logger.warn({ code, stderrPreview: stderr.slice(0, 200), model }, 'haiku cli exited non-zero')
        resolve(null)
        return
      }
      resolve(stdout.trim())
    })

    child.stdin.write(prompt)
    child.stdin.end()
  })
}

async function runViaApi(prompt: string, model: string, maxTokens: number): Promise<string> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
    const result = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
    const first = result.content[0]
    return first && first.type === 'text' ? first.text : ''
  } catch (err) {
    logger.warn({ err, model }, 'haiku api fallback failed')
    return ''
  }
}
