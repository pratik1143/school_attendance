// One-off migration: stamp `tenantId` on legacy documents so the public API / webhooks can see them.
//
//   DRY RUN (default, writes nothing):   TENANT_ID=school-main node --env-file-if-exists=.env --experimental-strip-types scripts/assign-tenant.ts
//   APPLY:                               APPLY=yes TENANT_ID=school-main node ... scripts/assign-tenant.ts
//
// Only documents that have NO tenantId are touched; documents that already carry one are never changed.
// Credentials come from Application Default Credentials (run it on the VM, or locally after
// `gcloud auth application-default login`). Firestore writes must be enabled (FIRESTORE_WRITES_ENABLED=true).
import { getDb } from '../src/firestore/admin.ts';

const tenantId = (process.env.TENANT_ID || '').trim();
if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId)) throw new Error('Set TENANT_ID to a safe id (letters, digits, _ or -), e.g. school-main.');
const apply = process.env.APPLY === 'yes';
const collections = ['students', 'attendance', 'devices'] as const;

const db = getDb();
if (!db) throw new Error('Firestore is not available. Check ADC credentials and FIRESTORE_WRITES_ENABLED.');

console.info(apply ? `APPLY mode: stamping tenantId="${tenantId}" on documents that lack one.` : `DRY RUN: nothing will be written. Target tenantId="${tenantId}".`);

for (const name of collections) {
  const snap = await db.collection(name).get();
  const missing = snap.docs.filter((d) => typeof d.get('tenantId') !== 'string' || d.get('tenantId') === '');
  const others = new Set(snap.docs.map((d) => d.get('tenantId')).filter((t) => typeof t === 'string' && t && t !== tenantId));
  console.info(`${name}: ${snap.size} total, ${missing.length} without tenantId` + (others.size ? `, already tagged with other tenant(s): ${[...others].join(', ')} (left untouched)` : ''));
  if (!apply || !missing.length) continue;

  // Firestore batches take at most 500 writes.
  for (let i = 0; i < missing.length; i += 400) {
    const batch = db.batch();
    for (const doc of missing.slice(i, i + 400)) batch.update(doc.ref, { tenantId });
    await batch.commit();
  }
  console.info(`${name}: tagged ${missing.length} document(s).`);
}
console.info(apply ? 'Done. Also set DEFAULT_TENANT_ID on the backend so NEW punches get the tenant, then restart it.' : 'Dry run finished. Re-run with APPLY=yes to write.');
