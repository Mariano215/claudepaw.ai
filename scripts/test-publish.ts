#!/usr/bin/env tsx
// One-shot test publisher. Usage: npx tsx scripts/test-publish.ts <post-id>
import { initDatabase } from '../src/db.js'
import { initCredentialStore } from '../src/credentials.js'
import { initSocial, publish, getPost } from '../src/social/index.js'

const postId = process.argv[2]
if (!postId) { console.error('Usage: npx tsx scripts/test-publish.ts <post-id>'); process.exit(1) }

const db = initDatabase()
await initCredentialStore()
initSocial(db)

const post = getPost(postId)
if (!post) { console.error(`Post ${postId} not found`); process.exit(1) }

console.log(`Publishing: [${post.platform}] ${post.content.slice(0, 80)}...`)
console.log(`Status: ${post.status}`)

const ok = await publish(postId)
console.log(`Result: ${ok ? 'SUCCESS' : 'FAILED'}`)

const updated = getPost(postId)
console.log(`New status: ${updated?.status}`)
if (updated?.platform_url) console.log(`URL: ${updated.platform_url}`)
if (updated?.error) console.log(`Error: ${updated.error}`)
