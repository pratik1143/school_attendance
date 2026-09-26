import { createHmac, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { env } from '../config/env.ts';
import { getAdminAuth, getDb } from '../firestore/admin.ts';

export const API_PERMISSIONS = ['attendance:read', 'students:read', 'devices:read'] as const;
export type ApiPermission = typeof API_PERMISSIONS[number];
export type ApiClient = {
  id: string; clientId: string; clientName: string; schoolName: string; tenantId: string;
  keyPrefix: string; keyHash: string; status: 'active' | 'disabled' | 'revoked';
  permissions: ApiPermission[]; rateLimit: number; expiresAt?: Timestamp | null;
  lastUsedAt?: Timestamp | null; createdAt?: Timestamp; requestCount?: number;
};

function pepper(): string {
  if (env.apiKeyPepper.length < 32) throw new Error('API_KEY_PEPPER must be configured with at least 32 characters.');
  return env.apiKeyPepper;
}
function digest(secret: string): Buffer { return createHmac('sha256', pepper()).update(secret).digest(); }
export function safeKeyPrefix(key: string): string { return key.split('_').slice(0, 3).join('_'); }
export function newApiCredential(): { key: string; prefix: string; hash: string } {
  const prefix = `sca_live_${randomBytes(6).toString('hex')}`;
  const key = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: digest(key).toString('hex') };
}
export function isApiSecretValid(key: string, storedHex: string): boolean {
  try {
    const expected = Buffer.from(storedHex, 'hex');
    const actual = digest(key);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}
export function rateLimitAllowed(requestCount: number, limit: number): boolean { return requestCount <= limit; }
export function clientUsable(status: string, expiresAt: Timestamp | Date | null | undefined, now = new Date()): 'active' | 'CLIENT_DISABLED' | 'INVALID_API_KEY' | 'API_KEY_EXPIRED' {
  if (status === 'revoked') return 'INVALID_API_KEY';
  if (status !== 'active') return 'CLIENT_DISABLED';
  const expiry = expiresAt instanceof Timestamp ? expiresAt.toDate() : expiresAt;
  if (expiry && expiry <= now) return 'API_KEY_EXPIRED';
  return 'active';
}
function clientFromDoc(id: string, data: FirebaseFirestore.DocumentData): ApiClient {
  return { id, clientId: String(data.clientId || id), clientName: String(data.clientName || ''), schoolName: String(data.schoolName || ''), tenantId: String(data.tenantId || ''), keyPrefix: String(data.keyPrefix || ''), keyHash: String(data.keyHash || ''), status: data.status, permissions: Array.isArray(data.permissions) ? data.permissions : [], rateLimit: Number(data.rateLimit) || env.apiRateLimit, expiresAt: data.expiresAt || null, lastUsedAt: data.lastUsedAt || null, createdAt: data.createdAt, requestCount: Number(data.requestCount) || 0 };
}
export async function authenticateApiKey(key: string): Promise<{ client: ApiClient; error?: never } | { client?: never; error: 'INVALID_API_KEY' | 'CLIENT_DISABLED' | 'API_KEY_EXPIRED' }> {
  if (!key.startsWith('sca_live_') || key.length > 256) return { error: 'INVALID_API_KEY' };
  const prefix = safeKeyPrefix(key);
  const snap = await getDb().collection('api_clients').where('keyPrefix', '==', prefix).limit(2).get();
  const found = snap.docs.find((doc) => isApiSecretValid(key, String(doc.get('keyHash') || '')));
  if (!found) return { error: 'INVALID_API_KEY' };
  const client = clientFromDoc(found.id, found.data());
  const state = clientUsable(client.status, client.expiresAt);
  if (state !== 'active') return { error: state };
  return { client };
}

export async function consumeRateLimit(client: ApiClient): Promise<{ allowed: boolean; limit: number; remaining: number; resetAt: number }> {
  const db = getDb(); const now = Date.now(); const minute = Math.floor(now / 60_000); const ref = db.collection('api_rate_limits').doc(`${client.clientId}_${minute}`);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const count = Number(snap.get('count') || 0) + 1;
    tx.set(ref, { clientId: client.clientId, count, expireAt: new Date((minute + 2) * 60_000) }, { merge: true });
    return count;
  });
  await db.collection('api_clients').doc(client.clientId).update({ lastUsedAt: FieldValue.serverTimestamp(), requestCount: FieldValue.increment(1) });
  return { allowed: rateLimitAllowed(result, client.rateLimit), limit: client.rateLimit, remaining: Math.max(0, client.rateLimit - result), resetAt: (minute + 1) * 60_000 };
}

export function isAdminRole(claims: Record<string, unknown>): boolean {
  return claims.admin === true || claims.role === 'admin' || claims.role === 'super_admin' || (Array.isArray(claims.roles) && (claims.roles.includes('admin') || claims.roles.includes('super_admin')));
}
export function isDeviceOperatorRole(claims: Record<string, unknown>): boolean {
  return claims.operator === true || claims.role === 'operator' || (Array.isArray(claims.roles) && claims.roles.includes('operator'));
}
export async function getAdminUserId(token: string): Promise<string | null> {
  try { const claims = await getAdminAuth().verifyIdToken(token); return isAdminRole(claims) && typeof claims.uid === 'string' ? claims.uid : null; } catch { return null; }
}
export async function getAdminIdentity(token: string): Promise<{ uid: string; clientId: string | null; tenantId: string | null } | null> {
  try {
    const claims = await getAdminAuth().verifyIdToken(token);
    if ((!isAdminRole(claims) && !isDeviceOperatorRole(claims)) || typeof claims.uid !== 'string') return null;
    return { uid: claims.uid, clientId: typeof claims.clientId === 'string' ? claims.clientId : null, tenantId: typeof claims.tenantId === 'string' ? claims.tenantId : null };
  } catch { return null; }
}
export async function verifyAdminToken(token: string): Promise<boolean> {
  try { const claims = await getAdminAuth().verifyIdToken(token); return isAdminRole(claims); } catch { return false; }
}

export async function listApiClients() {
  const snap = await getDb().collection('api_clients').orderBy('createdAt', 'desc').limit(500).get();
  const iso = (value: unknown) => value instanceof Timestamp ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : null;
  return snap.docs.map((doc) => { const d = doc.data(); return { clientId: doc.id, clientName: d.clientName, schoolName: d.schoolName, tenantId: d.tenantId, contactName: d.contactName || '', contactEmail: d.contactEmail || '', keyPrefix: d.keyPrefix || '', status: d.status, permissions: d.permissions || [], rateLimit: d.rateLimit, createdAt: iso(d.createdAt), lastUsedAt: iso(d.lastUsedAt), expiresAt: iso(d.expiresAt), requestCount: d.requestCount || 0 }; });
}
export async function createApiClient(input: { clientName: string; schoolName: string; tenantId: string; contactName?: string; contactEmail?: string; permissions: ApiPermission[]; rateLimit: number; expiresAt?: Date | null }) {
  const db = getDb(); const id = randomUUID(); const credential = newApiCredential();
  const record = { clientId: id, clientName: input.clientName, schoolName: input.schoolName, tenantId: input.tenantId, contactName: input.contactName || '', contactEmail: input.contactEmail || '', keyPrefix: credential.prefix, keyHash: credential.hash, status: 'active', permissions: input.permissions, rateLimit: input.rateLimit, createdAt: FieldValue.serverTimestamp(), lastUsedAt: null, expiresAt: input.expiresAt || null, requestCount: 0, webhookEnabled: false };
  await db.collection('api_clients').doc(id).set(record);
  await audit(id, 'CLIENT_CREATED'); await audit(id, 'API_KEY_CREATED');
  return { clientId: id, apiKey: credential.key, keyPrefix: credential.prefix };
}
export async function changeClientStatus(id: string, status: 'active' | 'disabled' | 'revoked') {
  const ref = getDb().collection('api_clients').doc(id); const snap = await ref.get(); if (!snap.exists) return false;
  if (status === 'active' && (!snap.get('keyHash') || snap.get('status') === 'revoked')) return false;
  const current = snap.get('status'); await ref.update({ status, ...(status === 'revoked' ? { keyHash: '' } : {}) });
  if (status === 'revoked') await audit(id, 'API_KEY_REVOKED');
  else if (status === 'disabled') await audit(id, 'CLIENT_DISABLED');
  else if (current === 'disabled' || current === 'revoked') await audit(id, 'CLIENT_ENABLED');
  return true;
}
export async function rotateClientKey(id: string) {
  const ref = getDb().collection('api_clients').doc(id); const snap = await ref.get(); if (!snap.exists) return null;
  const credential = newApiCredential(); await ref.update({ keyPrefix: credential.prefix, keyHash: credential.hash, status: 'active', lastUsedAt: null });
  await audit(id, 'API_KEY_ROTATED'); return { clientId: id, apiKey: credential.key, keyPrefix: credential.prefix };
}
export async function changeClientPermissions(id: string, permissions: ApiPermission[]) {
  const ref = getDb().collection('api_clients').doc(id); const snap = await ref.get(); if (!snap.exists) return false;
  await ref.update({ permissions }); await audit(id, 'PERMISSION_CHANGED'); return true;
}
async function audit(clientId: string, event: string) { await getDb().collection('client_audit_logs').add({ clientId, event, timestamp: FieldValue.serverTimestamp() }); }
