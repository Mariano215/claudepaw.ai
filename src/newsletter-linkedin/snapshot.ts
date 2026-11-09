/**
 * Edition snapshots: serialize the fully-composed newsletter content
 * (brief, articles, GH picks, hero) to JSON so future test runs can skip
 * the expensive RSS fetch + GH API + LLM calls and just reload from disk.
 *
 * Used by the linkedin-publish-current CLI and the bot when iterating on
 * publisher selectors against a known-good edition.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../env.js'
import type {
  CategoryId,
  ScoredArticle,
  ScoredRepo,
  ExecutiveBrief,
} from '../newsletter/types.js'

const SNAPSHOT_DIR = join(PROJECT_ROOT, 'store', 'newsletter', 'snapshots')

export interface EditionSnapshotV1 {
  schemaVersion: 1
  capturedAt: string
  editionId: string
  dateStr: string
  lookbackDays: number
  brief: ExecutiveBrief
  // Stored as ISO strings on disk; runtime decode hydrates Dates.
  accessibleByCategory: Record<CategoryId, ScoredArticleJson[]>
  githubPicks: ScoredRepoJson[]
  imagePath: string
  artDirection: string
}

interface ScoredArticleJson extends Omit<ScoredArticle, 'publishedAt'> {
  publishedAt: string
}

interface ScoredRepoJson
  extends Omit<ScoredRepo, 'pushedAt' | 'createdAt' | 'latestReleaseAt'> {
  pushedAt: string
  createdAt: string
  latestReleaseAt: string | null
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function articleToJson(a: ScoredArticle): ScoredArticleJson {
  return { ...a, publishedAt: a.publishedAt.toISOString() }
}

function repoToJson(r: ScoredRepo): ScoredRepoJson {
  return {
    ...r,
    pushedAt: r.pushedAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    latestReleaseAt: r.latestReleaseAt ? r.latestReleaseAt.toISOString() : null,
  }
}

function articleFromJson(j: ScoredArticleJson): ScoredArticle {
  return { ...j, publishedAt: new Date(j.publishedAt) }
}

function repoFromJson(j: ScoredRepoJson): ScoredRepo {
  return {
    ...j,
    pushedAt: new Date(j.pushedAt),
    createdAt: new Date(j.createdAt),
    latestReleaseAt: j.latestReleaseAt ? new Date(j.latestReleaseAt) : null,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EditionMaterial {
  editionId: string
  dateStr: string
  lookbackDays: number
  brief: ExecutiveBrief
  accessibleByCategory: Record<CategoryId, ScoredArticle[]>
  githubPicks: ScoredRepo[]
  imagePath: string
  artDirection: string
}

export function saveEditionSnapshot(material: EditionMaterial, outPath?: string): string {
  const path = outPath ?? defaultSnapshotPath(material.editionId)
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true })
  }
  const snap: EditionSnapshotV1 = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    editionId: material.editionId,
    dateStr: material.dateStr,
    lookbackDays: material.lookbackDays,
    brief: material.brief,
    accessibleByCategory: {
      cyber: material.accessibleByCategory.cyber.map(articleToJson),
      ai: material.accessibleByCategory.ai.map(articleToJson),
      research: material.accessibleByCategory.research.map(articleToJson),
    },
    githubPicks: material.githubPicks.map(repoToJson),
    imagePath: material.imagePath,
    artDirection: material.artDirection,
  }
  writeFileSync(path, JSON.stringify(snap, null, 2))
  logger.info({ path, editionId: material.editionId }, 'Edition snapshot saved')
  return path
}

export function loadEditionSnapshot(path: string): EditionMaterial {
  if (!existsSync(path)) {
    throw new Error(`Edition snapshot not found at ${path}`)
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as EditionSnapshotV1
  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported snapshot schemaVersion: ${raw.schemaVersion}`)
  }
  logger.info(
    { path, editionId: raw.editionId, capturedAt: raw.capturedAt },
    'Edition snapshot loaded',
  )
  return {
    editionId: raw.editionId,
    dateStr: raw.dateStr,
    lookbackDays: raw.lookbackDays,
    brief: raw.brief,
    accessibleByCategory: {
      cyber: raw.accessibleByCategory.cyber.map(articleFromJson),
      ai: raw.accessibleByCategory.ai.map(articleFromJson),
      research: raw.accessibleByCategory.research.map(articleFromJson),
    },
    githubPicks: raw.githubPicks.map(repoFromJson),
    imagePath: raw.imagePath,
    artDirection: raw.artDirection,
  }
}

export function defaultSnapshotPath(editionId: string): string {
  return join(SNAPSHOT_DIR, `${editionId}.json`)
}
