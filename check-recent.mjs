import Database from 'better-sqlite3';
import { CREDENTIAL_ENCRYPTION_KEY } from './dist/config.js';
import { createDecipheriv } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const db = new Database('./store/claudepaw.db');
const encryptionKey = Buffer.from(CREDENTIAL_ENCRYPTION_KEY, 'hex');

function decrypt(value, iv, tag) {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(value), decipher.final()]);
  return decrypted.toString('utf8');
}

function getCred(key) {
  const row = db.prepare('SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?')
    .get('four-olives', 'wordpress', key);
  if (!row) return null;
  return decrypt(row.value, row.iv, row.tag);
}

const user = getCred('fop_user');
const pass = getCred('fop_app_password');
const url = getCred('fop_url');

const auth = Buffer.from(`${user}:${pass}`).toString('base64');
const wpUrl = `${url}/wp-json/wp/v2/posts?status=publish&per_page=10&orderby=date&order=desc`;

const res = await fetch(wpUrl, { headers: { 'Authorization': `Basic ${auth}` } });
const posts = await res.json();

const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
const recent = posts.filter(p => new Date(p.date) >= cutoff);

console.log(`Posts published in last 48h: ${recent.length}`);
for (const p of recent) {
  console.log(`- ${p.date}: ${p.title.rendered} (slug: ${p.slug})`);
  
  const hasSocial = db.prepare(`
    SELECT COUNT(*) as cnt 
    FROM social_posts 
    WHERE project_id='four-olives' 
    AND (content LIKE ? OR content LIKE ?)
  `).get(`%${p.slug}%`, `%${p.title.rendered}%`).cnt;
  
  console.log(`  Social posts: ${hasSocial}`);
}
