export type CategoryId = 'cyber' | 'ai' | 'research'

export type TopicId =
  | 'identity'
  | 'supply_chain'
  | 'model_security'
  | 'data_governance'
  | 'ai_operations'
  | 'quantum_readiness'

export interface RawArticle {
  title: string
  url: string
  summary: string
  publishedAt: Date
  sourceFeed: string
  sourceCategory: CategoryId | 'google_news'
}

export interface ScoredArticle {
  title: string
  url: string
  summary: string
  publishedAt: Date
  sourceFeed: string
  sourceCategory: CategoryId | 'google_news'
  score: number
  category: CategoryId
  sourceDomain: string
}

export interface NewsletterEdition {
  id: string
  date: string
  lookbackDays: number
  articles: {
    cyber: ScoredArticle[]
    ai: ScoredArticle[]
    research: ScoredArticle[]
  }
  executiveInsight: string
  executiveImplication: string
  heroImagePath: string | null
  heroArtDirection: string
  htmlBytes: number
  sentAt: number | null
  recipient: string
}

export interface EditionRow {
  id: string
  date: string
  lookback_days: number
  articles_cyber: number
  articles_ai: number
  articles_research: number
  hero_path: string | null
  html_bytes: number | null
  sent_at: number | null
  recipient: string
}

export interface SeenLinkRow {
  url: string
  sent_at: number
  edition_date: string
}

export interface ExecutiveBrief {
  insight: string
  implication: string
  topThemes: TopicId[]
}

export interface NewsletterConfig {
  recipientEmail: string
  perCategoryLimit: number
  probeTimeoutMs: number
  heroDir: string
  geminiModel: string
  geminiApiKey: string
  templatePath: string
  maxHeroBytes: number
}
