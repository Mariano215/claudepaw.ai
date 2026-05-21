import { logger } from '../logger.js'
import { getNewsletterDb } from './dedup.js'
import type { ScoredRepo, SeenRepoRow } from './types.js'

// ---------------------------------------------------------------------------
// Repo dedup: separate from newsletter_seen_links because a repo deserves
// re-mention when a new release ships. Re-allow rule:
//   currentReleaseTag !== last_release_tag OR now - last_shown_at > windowDays
// ---------------------------------------------------------------------------

export function isRepoShownRecently(
  fullName: string,
  currentReleaseTag: string | null,
  windowDays = 90,
): boolean {
  const row = getNewsletterDb()
    .prepare(
      `SELECT repo_full_name, last_shown_at, last_release_tag, last_edition_date
         FROM newsletter_seen_repos
        WHERE repo_full_name = ?`,
    )
    .get(fullName) as SeenRepoRow | undefined

  if (!row) return false

  // New release tag → re-allow regardless of recency
  if ((row.last_release_tag ?? null) !== (currentReleaseTag ?? null)) {
    return false
  }

  // Within suppression window AND same release tag → still seen
  const cutoff = Date.now() - windowDays * 86_400_000
  return row.last_shown_at >= cutoff
}

export function markReposSeen(repos: ScoredRepo[], editionDate: string): void {
  if (repos.length === 0) return
  const now = Date.now()
  const stmt = getNewsletterDb().prepare(
    `INSERT OR REPLACE INTO newsletter_seen_repos
       (repo_full_name, last_shown_at, last_release_tag, last_edition_date)
     VALUES (?, ?, ?, ?)`,
  )
  const tx = getNewsletterDb().transaction(() => {
    for (const r of repos) {
      stmt.run(r.fullName, now, r.latestReleaseTag, editionDate)
    }
  })
  tx()
  logger.info({ count: repos.length, editionDate }, 'Marked repos as seen')
}

// Filter a candidate list to those NOT recently shown. Used inside the
// collector's shortlist step before the 60/40 bucket mix is applied.
export function filterUnseenRepos<T extends { fullName: string; latestReleaseTag: string | null }>(
  repos: T[],
  windowDays = 90,
): T[] {
  return repos.filter((r) => !isRepoShownRecently(r.fullName, r.latestReleaseTag, windowDays))
}
