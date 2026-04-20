// YouTube channel inventory audit.
//
// Pulls the given project's YouTube credentials from the credential store,
// enumerates the full uploads playlist, then fetches per-video
// contentDetails + status. Prints a sortable table of publish date,
// length, shorts-vs-long classification, privacy, scheduled-at, title,
// and video id.
//
// Usage:
//   tsx scripts/list-yt-inventory.ts <project> [<service>]
//
// Examples:
//   tsx scripts/list-yt-inventory.ts my-company
//   tsx scripts/list-yt-inventory.ts example-project youtube
//
// Project slug is NOT hardcoded so the script stays project-agnostic and
// safe to publish in the OSS mirror.

import { initDatabase } from '../src/db.js'
import { initCredentialStore, getServiceCredentials } from '../src/credentials.js'

async function main() {
  const [, , project, service = 'youtube'] = process.argv
  if (!project) {
    console.error('Usage: tsx scripts/list-yt-inventory.ts <project> [<service>]')
    process.exit(1)
  }

  const db = initDatabase()
  initCredentialStore(db)

  const creds = getServiceCredentials(project, service)
  const apiKey = creds['api_key']
  const channelId = creds['channel_id']

  if (!apiKey || !channelId) {
    console.error(`Missing api_key or channel_id for ${project}/${service}`)
    process.exit(1)
  }

  const chResp = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${channelId}&key=${apiKey}`)
  const chData: any = await chResp.json()
  if (!chResp.ok) { console.error('Channel fetch failed:', JSON.stringify(chData, null, 2)); process.exit(1) }
  const uploadsId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads
  const channelTitle = chData.items?.[0]?.snippet?.title
  console.log(`Channel: ${channelTitle}`)
  console.log(`Uploads playlist: ${uploadsId}\n`)

  const videos: any[] = []
  let pageToken = ''
  while (true) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsId}&maxResults=50&key=${apiKey}${pageToken ? `&pageToken=${pageToken}` : ''}`
    const r = await fetch(url)
    const d: any = await r.json()
    if (!r.ok) { console.error('Playlist fetch failed:', JSON.stringify(d, null, 2)); process.exit(1) }
    for (const it of d.items ?? []) {
      videos.push({
        id: it.contentDetails?.videoId,
        title: it.snippet?.title,
        publishedAt: it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt,
      })
    }
    if (!d.nextPageToken) break
    pageToken = d.nextPageToken
  }

  const chunks: string[][] = []
  for (let i = 0; i < videos.length; i += 50) chunks.push(videos.slice(i, i + 50).map(v => v.id))
  const durations: Record<string, string> = {}
  const privacy: Record<string, string> = {}
  const scheduled: Record<string, string> = {}
  for (const chunk of chunks) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status&id=${chunk.join(',')}&key=${apiKey}`)
    const d: any = await r.json()
    for (const v of d.items ?? []) {
      durations[v.id] = v.contentDetails?.duration ?? ''
      privacy[v.id] = v.status?.privacyStatus ?? ''
      if (v.status?.publishAt) scheduled[v.id] = v.status.publishAt
    }
  }

  function iso8601ToSeconds(iso: string): number {
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
    if (!m) return 0
    return (parseInt(m[1] ?? '0') * 3600) + (parseInt(m[2] ?? '0') * 60) + parseInt(m[3] ?? '0')
  }

  console.log(`Total videos (public + unlisted visible via API): ${videos.length}\n`)
  console.log('#  | PUB        | LEN   | TYPE  | PRIV      | SCHED            | TITLE (id)')
  console.log('-'.repeat(130))
  videos.sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))
  videos.forEach((v, i) => {
    const secs = iso8601ToSeconds(durations[v.id] ?? '')
    const lenStr = secs < 60 ? `${secs}s` : `${Math.floor(secs/60)}m${String(secs%60).padStart(2,'0')}s`
    const type = secs <= 62 ? 'SHORT' : 'VIDEO'
    const pub = (v.publishedAt ?? '').slice(0, 10)
    const priv = privacy[v.id] ?? ''
    const sched = scheduled[v.id] ? scheduled[v.id].slice(0, 16) : ''
    console.log(`${String(i+1).padStart(2)} | ${pub} | ${lenStr.padEnd(5)} | ${type.padEnd(5)} | ${priv.padEnd(9)} | ${sched.padEnd(16)} | ${v.title} [${v.id}]`)
  })
}

main().catch(e => { console.error(e); process.exit(1) })
