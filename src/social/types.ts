// ---------------------------------------------------------------------------
// Social posting types
// ---------------------------------------------------------------------------

export type Platform = 'linkedin' | 'twitter' | 'facebook' | 'instagram' | 'youtube'
export type PostStatus = 'draft' | 'approved' | 'published' | 'rejected' | 'failed'

export interface SocialPost {
  id: string
  platform: Platform
  content: string
  media_url: string | null
  suggested_time: string | null
  cta: string | null
  status: PostStatus
  platform_post_id: string | null
  platform_url: string | null
  error: string | null
  created_at: number
  published_at: number | null
  scheduled_at?: number | null
  created_by: string // agent ID that drafted it
  project_id: string
}

export interface DraftInput {
  platform: Platform
  content: string
  media_url?: string
  suggested_time?: string
  cta?: string
  created_by?: string
  project_id: string
}

export interface PublishResult {
  success: boolean
  platform_post_id?: string
  platform_url?: string
  error?: string
}
