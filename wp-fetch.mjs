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

if (!user || !pass || !url) {
  console.error('Missing WP credentials');
  process.exit(1);
}

const auth = Buffer.from(`${user}:${pass}`).toString('base64');
const wpUrl = `${url}/wp-json/wp/v2/posts?status=publish&per_page=10&orderby=date&order=desc`;

const res = await fetch(wpUrl, {
  headers: { 'Authorization': `Basic ${auth}` }
});

if (!res.ok) {
  console.error(`WP API error: ${res.status} ${res.statusText}`);
  const body = await res.text();
  console.error(body);
  process.exit(1);
}

const posts = await res.json();
console.log(JSON.stringify(posts.map(p => ({
  id: p.id,
  slug: p.slug,
  title: p.title.rendered,
  date: p.date,
  featured_media: p.featured_media
})), null, 2));
