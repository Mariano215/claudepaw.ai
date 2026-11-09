#!/usr/bin/env node
import { runAgentWithResolvedExecution, type ExecutionProvider, type ModelTier } from '../src/agent-runtime.js'

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function usage(): never {
  console.error('Usage: node --import tsx scripts/provider-smoke.ts --provider <claude_desktop|codex_local|anthropic_api|openai_api> [--model <id>] [--tier <cheap|balanced|premium>] [--fallback-policy <disabled|enabled|manual_only|auto_on_quota|auto_on_error>] [--fallback-provider <provider>] [--prompt <text>] [--verbose]')
  process.exit(1)
}

function normalizeFallbackPolicy(value: string | undefined): 'disabled' | 'enabled' | undefined {
  if (!value) return undefined
  if (value === 'disabled' || value === 'manual_only') return 'disabled'
  if (value === 'enabled' || value === 'auto_on_quota' || value === 'auto_on_error') return 'enabled'
  return undefined
}

const provider = argValue('--provider') as ExecutionProvider | undefined
const model = argValue('--model') ?? null
const modelTier = (argValue('--tier') as ModelTier | undefined) ?? 'balanced'
const fallbackPolicyArg = argValue('--fallback-policy')
const fallbackPolicy = normalizeFallbackPolicy(fallbackPolicyArg) ?? 'disabled'
const fallbackProvider = (argValue('--fallback-provider') as ExecutionProvider | undefined) ?? null
const prompt = argValue('--prompt') ?? 'Reply with exactly: provider smoke ok'
const verbose = hasFlag('--verbose')

if (!provider || !['claude_desktop', 'codex_local', 'anthropic_api', 'openai_api'].includes(provider)) usage()
if (!['cheap', 'balanced', 'premium'].includes(modelTier)) usage()
if (fallbackPolicyArg && !normalizeFallbackPolicy(fallbackPolicyArg)) usage()
if (fallbackProvider && !['claude_desktop', 'codex_local', 'anthropic_api', 'openai_api'].includes(fallbackProvider)) usage()

async function main(): Promise<void> {
  const events: any[] = []
  const startedAt = Date.now()

  const { settings, result } = await runAgentWithResolvedExecution(
    {
      prompt,
      onEvent: (event) => {
        events.push(event)
        if (verbose) console.log('[event]', JSON.stringify(event))
      },
    },
    {
      executionOverride: {
        provider,
        model,
        modelTier,
        fallbackPolicy,
        fallbackProvider,
      },
    },
  )

  const durationMs = Date.now() - startedAt

  console.log('\nExecution smoke test')
  console.log(`requested provider: ${settings.provider}`)
  console.log(`executed provider:  ${result.executedProvider}`)
  console.log(`fallback applied:   ${result.providerFallbackApplied ? 'yes' : 'no'}`)
  console.log(`configured model:   ${settings.model ?? '(auto)'}`)
  console.log(`result subtype:     ${result.resultSubtype ?? '(none)'}`)
  console.log(`assistant turns:    ${result.assistantTurns}`)
  console.log(`tool uses:          ${result.toolUses}`)
  console.log(`events seen:        ${events.length}`)
  console.log(`elapsed ms:         ${durationMs}`)
  console.log(`text:               ${JSON.stringify(result.text)}`)
}

main().catch((err) => {
  console.error('\nExecution smoke test failed')
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
