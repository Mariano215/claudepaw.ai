export interface UpdateStatus {
  behind: number
  commits: Array<{ sha: string; message: string }>
}

const GITHUB_REPO = 'your-username/your-repo'

export async function getUpdateStatus(gitHash: string | null): Promise<UpdateStatus> {
  if (!gitHash) return { behind: 0, commits: [] }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/compare/main...${gitHash}`,
      { headers: { 'User-Agent': 'ClaudePaw-Dashboard' } }
    )
    if (!res.ok) return { behind: 0, commits: [] }

    const data = await res.json() as {
      behind_by?: number
      commits?: Array<{ sha: string; commit: { message: string } }>
    }
    const commits = (data.commits ?? []).slice(-10).map(c => ({
      sha: c.sha.substring(0, 7),
      message: c.commit.message.split('\n')[0],
    }))
    return { behind: data.behind_by ?? 0, commits }
  } catch {
    return { behind: 0, commits: [] }
  }
}
