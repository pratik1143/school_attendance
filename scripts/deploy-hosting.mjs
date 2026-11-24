// Deploys dist/ to Firebase Hosting through the REST API using an OAuth access token
// (e.g. `gcloud auth print-access-token`). Usage: ACCESS_TOKEN=... node scripts/deploy-hosting.mjs
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const site = process.env.HOSTING_SITE || 'school-project-717c3';
const token = process.env.ACCESS_TOKEN;
if (!token) throw new Error('Set ACCESS_TOKEN.');
const api = 'https://firebasehosting.googleapis.com/v1beta1';
const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': site };

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.body && !(init.body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const root = 'dist';
const walk = (dir) => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = new Map();
for (const file of walk(root)) {
  const gz = gzipSync(readFileSync(file), { level: 9 });
  files.set('/' + relative(root, file).split(sep).join('/'), { gz, hash: createHash('sha256').update(gz).digest('hex') });
}

const version = await call(`${api}/sites/${site}/versions`, { method: 'POST', body: JSON.stringify({ config: { rewrites: [{ glob: '**', path: '/index.html' }] } }) });
const populate = await call(`${api}/${version.name}:populateFiles`, { method: 'POST', body: JSON.stringify({ files: Object.fromEntries([...files].map(([path, f]) => [path, f.hash])) }) });
const needed = new Set(populate.uploadRequiredHashes || []);
for (const f of files.values()) {
  if (!needed.has(f.hash)) continue;
  await call(`${populate.uploadUrl}/${f.hash}`, { method: 'POST', body: f.gz, headers: { 'Content-Type': 'application/octet-stream' } });
}
await call(`${api}/${version.name}?update_mask=status`, { method: 'PATCH', body: JSON.stringify({ status: 'FINALIZED' }) });
await call(`${api}/sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`, { method: 'POST', body: JSON.stringify({}) });
console.log(`Deployed ${files.size} files (${needed.size} uploaded) to https://${site}.web.app`);
