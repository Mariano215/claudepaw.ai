// Token → USD conversion for non-claude-desktop adapters.
//
// The Claude Desktop path emits total_cost_usd natively via the SDK. Every
// other adapter (anthropic_api, openai_api, openrouter, codex_local) must
// compute cost from token counts or the cost gate silently sees $0 and caps
// never trip. See .reviews/loop1-findings.md "Telemetry" section for detail.
//
// Prices are per 1M tokens, USD. Sourced from each provider's public pricing
// page. These are approximations; the cost gate tolerates ±20% drift because
// the thresholds (80% / 100%) include their own slack. Update when pricing
// shifts materially.
//
// Ollama and LM Studio run locally and return {0, 0} — free by construction.

import { logger } from '../logger.js'

export interface TokenUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

interface ModelPrice {
  // USD per 1M tokens
  inputUsdPer1M: number
  outputUsdPer1M: number
  // Optional: distinct prices for cache reads / writes when supported
  cacheReadUsdPer1M?: number
  cacheWriteUsdPer1M?: number
}

// Canonical prices. Prefer exact match; otherwise fall back to a "family"
// match on substring (e.g. "anthropic/claude-sonnet-4-5" maps to "claude-sonnet-4").
const PRICES: Record<string, ModelPrice> = {
  // Anthropic (via API or Claude Desktop SDK, same economics)
  'claude-sonnet-4-6':  { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00, cacheReadUsdPer1M: 0.30, cacheWriteUsdPer1M: 3.75 },
  'claude-sonnet-4-5':  { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00, cacheReadUsdPer1M: 0.30, cacheWriteUsdPer1M: 3.75 },
  'claude-sonnet-4':    { inputUsdPer1M: 3.00,  outputUsdPer1M: 15.00 },
  'claude-haiku-4-5':   { inputUsdPer1M: 0.80,  outputUsdPer1M: 4.00 },
  'claude-haiku-4':     { inputUsdPer1M: 0.80,  outputUsdPer1M: 4.00 },
  'claude-opus-4':      { inputUsdPer1M: 15.00, outputUsdPer1M: 75.00 },
  // OpenAI
  'gpt-5.4':            { inputUsdPer1M: 5.00,  outputUsdPer1M: 20.00 },
  'gpt-5.2-codex':      { inputUsdPer1M: 3.00,  outputUsdPer1M: 12.00 },
  'gpt-5-mini':         { inputUsdPer1M: 0.40,  outputUsdPer1M: 1.60 },
  'gpt-4o':             { inputUsdPer1M: 2.50,  outputUsdPer1M: 10.00 },
  'gpt-4o-mini':        { inputUsdPer1M: 0.15,  outputUsdPer1M: 0.60 },
  // Local / free
  'ollama':             { inputUsdPer1M: 0,     outputUsdPer1M: 0 },
  'lm-studio':          { inputUsdPer1M: 0,     outputUsdPer1M: 0 },
}

function findPrice(model: string): ModelPrice | null {
  const normalized = model.toLowerCase().replace(/^anthropic\/|^openai\//, '')
  if (PRICES[normalized]) return PRICES[normalized]
  // Fuzzy family match so e.g. "claude-sonnet-4-5-20250522" still maps.
  for (const [key, price] of Object.entries(PRICES)) {
    if (normalized.includes(key)) return price
  }
  return null
}

/**
 * Estimate USD cost from token usage for a given model. Returns 0 for free
 * providers (ollama/lm-studio). Returns null if we have no pricing data AND
 * the usage is non-zero — caller should emit a warn log and pass null through
 * so the cost dashboard can show "unpriced" rather than a misleading $0.
 */
export function computeCostUsd(model: string | null | undefined, usage: TokenUsage | null | undefined): number | null {
  if (!usage) return null
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return 0

  const price = model ? findPrice(model) : null
  if (!price) {
    logger.warn({ model, input, output }, 'cost/pricing: no price entry for model, attributing as unpriced')
    return null
  }

  const cost =
    (input * price.inputUsdPer1M) / 1_000_000 +
    (output * price.outputUsdPer1M) / 1_000_000 +
    (cacheRead * (price.cacheReadUsdPer1M ?? price.inputUsdPer1M * 0.1)) / 1_000_000 +
    (cacheWrite * (price.cacheWriteUsdPer1M ?? price.inputUsdPer1M * 1.25)) / 1_000_000

  return Math.round(cost * 1_000_000) / 1_000_000 // 6 decimal places, max precision
}

// Test-only: for unit tests asserting the table matches the docs.
export function _getPriceTable(): Record<string, ModelPrice> {
  return PRICES
}
