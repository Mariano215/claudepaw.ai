// src/guard/types.ts

export type GuardEventType = 'BLOCKED' | 'FLAGGED' | 'PASSED'

// --- Layer results ---

export interface L1Result {
  layer: 'l1-sanitize'
  cleanedText: string
  charsRemoved: number
  wasTruncated: boolean
}

export interface L2Result {
  layer: 'l2-regex'
  matchedPatterns: string[]
  isFlagged: boolean
  flagReason: string | null
}

export interface L3Result {
  layer: 'l3-nova'
  rulesTriggered: string[]
  severity: 'none' | 'low' | 'high'
  timedOut: boolean
  error: string | null
  degraded: boolean
}

export interface L4Result {
  layer: 'l4-ml-input'
  injectionScore: number
  toxicityScore: number
  invisibleTextDetected: boolean
  isBlocked: boolean
  blocker: string | null
  degraded: boolean
}

export interface L5Result {
  layer: 'l5-canary'
  canary: string
  delimiterID: string
}

export interface L6Result {
  layer: 'l6-output-validate'
  lengthOk: boolean
  canaryLeaked: boolean
  exfilDetected: boolean
  echoDetected: boolean
  isBlocked: boolean
  blockReason: string | null
}

export interface L7Result {
  layer: 'l7-ml-output'
  toxicityScore: number
  refusalDetected: boolean
  isBlocked: boolean
  blocker: string | null
  degraded: boolean
}

export type LayerResult = L1Result | L2Result | L3Result | L4Result | L5Result | L6Result | L7Result

// --- Orchestrator types ---

export interface PreProcessResult {
  allowed: boolean
  sanitizedText: string
  blocked: boolean
  flagged: boolean
  triggeredLayers: string[]
  blockReason: string | null
  layerResults: LayerResult[]
  latencyMs: number
  requestId: string
}

export interface HardenedPrompt {
  systemPrompt: string
  userMessage: string
  canary: string
  delimiterID: string
}

export interface RequestContext {
  requestId: string
  canary: string
  delimiterID: string
  chatId: string
}

export interface PostProcessResult {
  response: string
  blocked: boolean
  flagged: boolean
  triggeredLayers: string[]
  blockReason: string | null
  layerResults: LayerResult[]
  latencyMs: number
  requestId: string
}

export interface GuardResult {
  response: string
  blocked: boolean
  flagged: boolean
  triggeredLayers: string[]
  blockReason: string | null
  latencyMs: number
  requestId: string
}

export interface GuardConfig {
  // L1
  maxInputChars: number

  // L3
  novaTimeoutMs: number
  sidecarUrl: string

  // L4
  injectionThreshold: number
  toxicityInputThreshold: number

  // L6
  minResponseChars: number
  maxResponseChars: number
  systemPromptEchoPhrases: string[]
  systemPromptEchoThreshold: number

  // L7
  toxicityOutputThreshold: number
  refusalThreshold: number

  // Fallback
  fallbackResponse: string
}

// --- Guard event for DB + JSONL logging ---

export interface GuardEvent {
  id: string
  timestamp: number
  chatId: string
  eventType: GuardEventType
  triggeredLayers: string[]
  blockReason: string | null
  originalMessage: string | null
  sanitizedMessage: string | null
  layerResults: Record<string, unknown>
  latencyMs: number
  requestId: string
}
