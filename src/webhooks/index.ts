// src/webhooks/index.ts -- Barrel export

export { WebhookEvent, ALL_WEBHOOK_EVENTS } from './types.js'
export type { WebhookRow, WebhookDeliveryRow, WebhookPayload } from './types.js'
export { initWebhookDb } from './db.js'
export {
  getAllWebhooks,
  getWebhook,
  createWebhook,
  deleteWebhook,
  toggleWebhook,
  getRecentDeliveries,
  getDeliveriesForWebhook,
} from './db.js'
export {
  fireWebhook,
  fireAgentCompleted,
  fireSecurityFinding,
  fireTaskCompleted,
  fireGuardBlocked,
  startPruneTimer,
} from './dispatcher.js'
