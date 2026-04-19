async function main() {
  const { initDatabase } = await import('../src/db.js')
  const { initNewsletter } = await import('../src/newsletter/index.js')
  const { fetchAllFeeds } = await import('../src/newsletter/feeds.js')
  const { scoreAllArticles, selectTopArticles } = await import('../src/newsletter/scorer.js')
  const { filterSeenArticles } = await import('../src/newsletter/dedup.js')
  const { probeArticles } = await import('../src/newsletter/prober.js')
  const { generateExecutiveBrief } = await import('../src/newsletter/brief.js')
  const { renderNewsletter } = await import('../src/newsletter/renderer.js')
  const { getLookbackDays, NEWSLETTER_CONFIG } = await import('../src/newsletter/config.js')
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs')
  const type = await import('../src/newsletter/types.js')

  // Init
  initDatabase()
  initNewsletter()

  const lookbackDays = getLookbackDays()
  console.log(`Lookback: ${lookbackDays} days\n`)

  // 1. Fetch RSS
  console.log('Fetching RSS feeds...')
  const raw = await fetchAllFeeds()
  console.log(`  Raw articles: ${raw.length}`)

  // 2. Filter by lookback
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000)
  const recent = raw.filter(a => a.publishedAt >= cutoff)
  console.log(`  Within ${lookbackDays}-day window: ${recent.length}`)

  // 3. Score
  const scored = scoreAllArticles(recent)
  console.log(`  Scored: ${scored.length}`)

  // 4. Dedup
  const unseen = filterSeenArticles(scored)
  console.log(`  After dedup: ${unseen.length}`)

  // 5. Select top
  const selected = selectTopArticles(unseen, NEWSLETTER_CONFIG.perCategoryLimit)
  console.log(`  Selected: cyber=${selected.cyber.length} ai=${selected.ai.length} research=${selected.research.length}`)

  // 6. Probe (skip to save time, use all selected)
  console.log('\nSkipping accessibility probe for speed...')

  // 7. Executive brief
  const brief = generateExecutiveBrief(selected)
  console.log(`\nExecutive Insight:\n  ${brief.insight}\n`)
  console.log(`Executive Implication:\n  ${brief.implication}\n`)
  console.log(`Top themes: ${brief.topThemes.join(', ')}`)

  // 8. Render HTML
  const templatePath = NEWSLETTER_CONFIG.templatePath
  if (!existsSync(templatePath)) {
    console.error(`Template not found at ${templatePath}`)
    process.exit(1)
  }
  const template = readFileSync(templatePath, 'utf-8')
  const html = renderNewsletter(template, {
    articles: selected,
    executiveInsight: brief.insight,
    executiveImplication: brief.implication,
    heroImageSrc: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=',
    heroArtDirection: 'placeholder',
    lookbackDays,
  })

  // Save preview
  const previewPath = '/tmp/newsletter_preview.html'
  writeFileSync(previewPath, html)
  console.log(`\nHTML rendered: ${Buffer.byteLength(html)} bytes`)
  console.log(`Preview saved to: ${previewPath}`)

  // Show some article titles
  console.log('\n=== Top Cyber Articles ===')
  for (const a of selected.cyber.slice(0, 3)) {
    console.log(`  - ${a.title} (${a.sourceDomain}) [score: ${a.score.toFixed(1)}]`)
  }
  console.log('\n=== Top AI Articles ===')
  for (const a of selected.ai.slice(0, 3)) {
    console.log(`  - ${a.title} (${a.sourceDomain}) [score: ${a.score.toFixed(1)}]`)
  }
  console.log('\n=== Top Research Articles ===')
  for (const a of selected.research.slice(0, 3)) {
    console.log(`  - ${a.title} (${a.sourceDomain}) [score: ${a.score.toFixed(1)}]`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
