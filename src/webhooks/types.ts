// src/webhooks/types.ts -- Webhook event types and interfaces

// ---------------------------------------------------------------------------
// Event types that can trigger webhooks
// ---------------------------------------------------------------------------

export enum WebhookEvent {
  AgentCompleted = 'agent_completed',
  SecurityFinding = 'security_finding',
  TaskCompleted = 'task_completed',
  GuardBlocked = 'guard_blocked',
}

export const ALL_WEBHOOK_EVENTS = Object.values(WebhookEvent)

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

export interface WebhookRow {
  id: string
  project_id: string
  event_type: WebhookEvent
  target_url: string
  secret: string
  active: number // SQLite boolean
  created_at: number
}

export interface WebhookDeliveryRow {
  id: string
  webhook_id: string
  event_type: WebhookEvent
  payload: string
  status_code: number | null
  response_time_ms: number | null
  error: string | null
  created_at: number
}

// ---------------------------------------------------------------------------
// Payload sent to webhook targets
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  event: WebhookEvent
  timestamp: number
  project_id: string
  data: Record<string, unknown>
}
