/**
 * Types for the LinkedIn Newsletter publishing pipeline (Phase 2).
 *
 * The flow is: newsletter generation triggers `queueLinkedinDraft()`,
 * which writes a `linkedin_editions` row with status='pending_approval'
 * and emits a Telegram approval card. the operator approves -> status='approved'.
 * Scheduler tick picks up approved rows and invokes `publishOne(row)`.
 */

export type LinkedinEditionStatus =
  | 'pending_approval'
  | 'approved'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'skipped'

export interface LinkedinEditionRow {
  id: string                    // 'signal-2026-05-18' (matches newsletter editionId)
  edition_date: string          // '2026-05-18'
  title: string                 // 'The Signal - 2026-05-18'
  cover_path: string            // absolute path under store/newsletter/heroes/
  body_md: string               // markdown-ish intermediate (not Quill Delta)
  status: LinkedinEditionStatus
  approval_chat_msg_id: number | null
  created_at_ms: number
  approved_at_ms: number | null
  published_at_ms: number | null
  published_url: string | null  // final https://www.linkedin.com/pulse/...
  error_message: string | null
  attempts: number
  last_screenshot: string | null
  dry_run: number               // 0 | 1 — SQLite has no bool type
}

// ---------------------------------------------------------------------------
// Quill Delta type (subset we use; LinkedIn ships Quill 2.x).
// Full spec: https://quilljs.com/docs/delta
// ---------------------------------------------------------------------------

export interface QuillDeltaOp {
  insert: string | Record<string, unknown>
  attributes?: {
    bold?: boolean
    italic?: boolean
    strike?: boolean
    underline?: boolean
    link?: string
    header?: 1 | 2 | 3
    list?: 'ordered' | 'bullet'
    blockquote?: boolean
    code?: boolean
    code_block?: boolean
  }
}

// ---------------------------------------------------------------------------
// Body-builder input + output
// ---------------------------------------------------------------------------

import type {
  ScoredArticle,
  ScoredRepo,
  ExecutiveBrief,
  CategoryId,
} from '../newsletter/types.js'

export interface BuildLinkedinBodyInput {
  brief: ExecutiveBrief
  articles: Record<CategoryId, ScoredArticle[]>
  github: ScoredRepo[]
  /** Public archive URL or LinkedIn newsletter subscribe URL — appended at body end if non-empty. */
  subscribeUrl?: string
  /**
   * Optional author attribution rendered in the footer. When `name` is empty,
   * the body builder omits the byline line entirely. When `url` is empty,
   * the name renders as plain text. Source: caller passes from
   * NEWSLETTER_BYLINE_NAME / NEWSLETTER_BYLINE_URL env-backed config so no
   * personal names are hardcoded in committed source.
   */
  byline?: {
    name: string
    url?: string
  }
}

export interface LinkedinBody {
  /** Article title as it will appear in the LinkedIn editor. */
  title: string
  /** Quill Delta ops; injected via quill.setContents(ops, 'api'). */
  delta: QuillDeltaOp[]
  /** Plain-text preview used for the Telegram approval card. */
  plainPreview: string
}

// ---------------------------------------------------------------------------
// Publisher API
// ---------------------------------------------------------------------------

export interface PublishOptions {
  /** When true, save as draft and do NOT click the final Publish button. */
  dryRun: boolean
  /** Headed=false fails LinkedIn detection; default false. */
  headless?: boolean
}

export interface PublishResult {
  ok: boolean
  publishedUrl?: string
  errorMessage?: string
  screenshotPath?: string
  /** Step at which the run completed or failed: 'navigate' | 'fill-title' | 'fill-body' | 'upload-cover' | 'click-publish' | 'verify-success' | etc. */
  step: string
  /** Milliseconds elapsed from publisher start to end. */
  durationMs: number
}
