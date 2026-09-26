import { initializeApp, getApps } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type DocumentData, type DocumentReference } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { randomUUID } from 'node:crypto';
import { buildWebhookPayload, decryptWebhookSecret, deliverWebhook, deliveryLeaseDue, eventDeliveryDisposition, formatIsoIndia, retryDelayMs, tenantClientOwnershipMatches, verifiedAttendanceEligible, webhookDeliveryId, type WebhookPayload } from '../../shared/webhooks.ts';

if (!getApps().length) initializeApp();
const db = getFirestore();
const encryptionKey = defineSecret('WEBHOOK_SECRET_ENCRYPTION_KEY');
const maxAttempts = Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5);
const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 10_000);
const maxPayloadBytes = Number(process.env.WEBHOOK_MAX_PAYLOAD_BYTES || 65_536);
const maxResponseBytes = Number(process.env.WEBHOOK_MAX_RESPONSE_BYTES || 8_192);
const workerConcurrency = Math.max(1, Math.min(100, Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 10)));
const maxPerMinute = Math.max(1, Number(process.env.WEBHOOK_MAX_PER_MINUTE || 60));
const failureThreshold = Math.max(1, Number(process.env.WEBHOOK_FAILURE_THRESHOLD || 10));
const retryDelays = (process.env.WEBHOOK_RETRY_DELAYS_MS || '60000,300000,900000,3600000').split(',').map(Number);
const development = process.env.NODE_ENV !== 'production';
const urlOptions = { production: !development, allowHttp: development && process.env.WEBHOOK_ALLOW_HTTP === 'true', allowLocalhost: development && process.env.WEBHOOK_ALLOW_LOCALHOST === 'true' };

function toDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}
function eligibleAttendance(data: DocumentData): boolean {
  return verifiedAttendanceEligible(data);
}
async function resolveOwner(data: DocumentData, attendanceRef: DocumentReference) {
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId : '';
  if (!tenantId) return null;
  let clientId = typeof data.clientId === 'string' ? data.clientId : '';
  if (!clientId && typeof data.deviceId === 'string') {
    const device = await db.collection('devices').doc(data.deviceId).get();
    if (device.exists && device.get('tenantId') === tenantId && typeof device.get('clientId') === 'string') clientId = device.get('clientId');
  }
  if (clientId) {
    const client = await db.collection('api_clients').doc(clientId).get();
    if (!client.exists || client.get('status') !== 'active' || !tenantClientOwnershipMatches({ tenantId, clientId }, { tenantId: client.get('tenantId'), clientId: client.id })) return null;
    return { clientId, tenantId, clientRef: client.ref };
  }
  // Legacy fallback is deliberately only allowed for a one-client tenant.
  const candidates = await db.collection('api_clients').where('tenantId', '==', tenantId).where('status', '==', 'active').limit(2).get();
  if (candidates.size !== 1) {
    logger.warn('Webhook skipped because tenant ownership is missing or ambiguous', { attendanceId: attendanceRef.id, candidateCount: candidates.size });
    return null;
  }
  return { clientId: candidates.docs[0].id, tenantId, clientRef: candidates.docs[0].ref };
}
async function makePayload(attendanceId: string, data: DocumentData): Promise<WebhookPayload> {
  const attendanceTime = toDate(data.timestamp ?? data.attendanceTime);
  const createdAt = toDate(data.createdAt) || new Date();
  const payloadData: Record<string, unknown> = { attendance_id: attendanceId };
  for (const [source, target] of [['studentId', 'student_id'], ['deviceUserId', 'device_user_id'], ['deviceId', 'device_id'], ['method', 'method'], ['status', 'status']] as const) if (data[source] !== undefined && data[source] !== null && data[source] !== '') payloadData[target] = data[source];
  if (attendanceTime) payloadData.attendance_time = formatIsoIndia(attendanceTime);
  const studentId = typeof data.studentId === 'string' ? data.studentId : '';
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId : '';
  if (studentId && tenantId) {
    const matches = await db.collection('students').where('tenantId', '==', tenantId).where('studentId', '==', studentId).limit(2).get();
    if (matches.size === 1) {
      const student = matches.docs[0].data();
      for (const [source, target] of [['name', 'student_name'], ['class', 'class'], ['section', 'section']] as const) if (student[source] !== undefined && student[source] !== null && student[source] !== '') payloadData[target] = student[source];
    }
  }
  return buildWebhookPayload(`evt_attendance_${attendanceId}`, createdAt, payloadData);
}
async function enqueueForWebhook(webhookRef: DocumentReference, owner: { clientId: string; tenantId: string; clientRef: DocumentReference }, eventId: string, payload: WebhookPayload) {
  const deliveryId = webhookDeliveryId(webhookRef.id, eventId); const deliveryRef = db.collection('webhook_deliveries').doc(deliveryId);
  const created = await db.runTransaction(async (tx) => {
    const [existing, webhook, client] = await Promise.all([tx.get(deliveryRef), tx.get(webhookRef), tx.get(owner.clientRef)]);
    if (existing.exists) return false;
    if (!webhook.exists || webhook.get('clientId') !== owner.clientId || webhook.get('tenantId') !== owner.tenantId || webhook.get('status') !== 'active' || !Array.isArray(webhook.get('events')) || !webhook.get('events').includes('attendance.created')) return false;
    if (!client.exists || client.get('status') !== 'active' || client.get('tenantId') !== owner.tenantId) return false;
    tx.create(deliveryRef, { deliveryId, webhookId: webhookRef.id, clientId: owner.clientId, tenantId: owner.tenantId, eventId, eventType: 'attendance.created', payload, attempt: 0, status: 'pending', nextAttemptAt: Timestamp.now(), createdAt: FieldValue.serverTimestamp(), sentAt: null, responseStatus: null, responseTimeMs: null, errorCode: null, errorMessage: null, lockUntil: null, lockToken: null });
    return true;
  });
  return created ? deliveryId : null;
}

export const queueVerifiedAttendance = onDocumentCreated({ document: 'attendance/{attendanceId}', retry: true, region: process.env.FUNCTION_REGION || 'us-central1', memory: '256MiB', timeoutSeconds: 60 }, async (event) => {
  const snapshot = event.data; if (!snapshot) return;
  const attendance = snapshot.data(); if (!eligibleAttendance(attendance)) return;
  const owner = await resolveOwner(attendance, snapshot.ref); if (!owner) return;
  const payload = await makePayload(snapshot.id, attendance); const eventId = payload.id;
  const endpointSnap = await db.collection('webhook_endpoints').where('clientId', '==', owner.clientId).where('status', '==', 'active').limit(200).get();
  for (const endpoint of endpointSnap.docs) {
    const record = endpoint.data(); if (record.tenantId !== owner.tenantId || !Array.isArray(record.events) || !record.events.includes('attendance.created')) continue;
    const deliveryId = await enqueueForWebhook(endpoint.ref, owner, eventId, payload);
    if (deliveryId) logger.info('Webhook delivery queued', { deliveryId, webhookId: endpoint.id, clientId: owner.clientId, eventId });
  }
});

type ClaimedDelivery = { deliveryId: string; webhookId: string; clientId: string; payload: WebhookPayload; endpoint: DocumentData; attempt: number; lockToken: string };
async function claimDelivery(ref: DocumentReference): Promise<ClaimedDelivery | null> {
  const now = Timestamp.now(); const token = randomUUID();
  return db.runTransaction(async (tx) => {
    const job = await tx.get(ref); if (!job.exists) return null;
    const d = job.data()!; const due = deliveryLeaseDue(d.status, d.nextAttemptAt instanceof Timestamp ? d.nextAttemptAt.toMillis() : null, d.lockUntil instanceof Timestamp ? d.lockUntil.toMillis() : null, now.toMillis());
    if (!due) return null;
    const webhookRef = db.collection('webhook_endpoints').doc(String(d.webhookId)); const clientRef = db.collection('api_clients').doc(String(d.clientId));
    const [webhook, client] = await Promise.all([tx.get(webhookRef), tx.get(clientRef)]);
    if (!webhook.exists || webhook.get('clientId') !== d.clientId || webhook.get('tenantId') !== d.tenantId || !['active', 'degraded'].includes(String(webhook.get('status'))) || !client.exists || client.get('status') !== 'active' || client.get('tenantId') !== d.tenantId) {
      tx.update(ref, { status: 'failed', errorCode: 'WEBHOOK_INACTIVE', errorMessage: 'Webhook or client is no longer active.', updatedAt: FieldValue.serverTimestamp(), lockUntil: null, lockToken: null }); return null;
    }
    const minute = Math.floor(Date.now() / 60_000); const rateRef = db.collection('webhook_rate_limits').doc(`${d.webhookId}_${minute}`); const rate = await tx.get(rateRef); const count = Number(rate.get('count') || 0);
    if (count >= maxPerMinute) { tx.update(ref, { status: 'pending', nextAttemptAt: Timestamp.fromMillis((minute + 1) * 60_000), lockUntil: null, lockToken: null }); return null; }
    tx.set(rateRef, { webhookId: d.webhookId, count: count + 1, expireAt: new Date((minute + 2) * 60_000) }, { merge: true });
    const attempt = Number(d.attempt || 0) + 1;
    tx.update(ref, { status: 'processing', attempt, lockToken: token, lockUntil: Timestamp.fromMillis(Date.now() + timeoutMs + 30_000), updatedAt: FieldValue.serverTimestamp() });
    return { deliveryId: ref.id, webhookId: d.webhookId, clientId: d.clientId, payload: d.payload as WebhookPayload, endpoint: webhook.data()!, attempt, lockToken: token };
  });
}
async function finishDelivery(claim: ClaimedDelivery, result: { ok: boolean; statusCode: number | null; responseTimeMs: number; errorCode: string | null; errorMessage: string | null }) {
  const ref = db.collection('webhook_deliveries').doc(claim.deliveryId); const webhookRef = db.collection('webhook_endpoints').doc(claim.webhookId); const now = Timestamp.now();
  const disposition = result.ok ? 'delivered' : eventDeliveryDisposition(result.statusCode, result.errorCode === 'WEBHOOK_TIMEOUT' || result.errorCode === 'WEBHOOK_NETWORK_ERROR' || result.errorCode === 'WEBHOOK_DNS_FAILED' || result.errorCode === 'WEBHOOK_RESPONSE_ERROR', false);
  const delay = retryDelays[claim.attempt - 1] ?? retryDelayMs(claim.attempt);
  const nextStatus = disposition === 'delivered' ? 'delivered' : disposition === 'failed' ? 'failed' : claim.attempt >= maxAttempts || delay === null ? 'dead_letter' : 'pending';
  await db.runTransaction(async (tx) => {
    const [job, webhook] = await Promise.all([tx.get(ref), tx.get(webhookRef)]);
    if (!job.exists || job.get('status') !== 'processing' || job.get('lockToken') !== claim.lockToken) return;
    tx.update(ref, { status: nextStatus, responseStatus: result.statusCode, responseTimeMs: result.responseTimeMs, errorCode: result.errorCode, errorMessage: result.errorMessage?.slice(0, 240) || null, sentAt: nextStatus === 'delivered' ? now : null, nextAttemptAt: nextStatus === 'pending' ? Timestamp.fromMillis(Date.now() + delay!) : null, lockUntil: null, lockToken: null, updatedAt: FieldValue.serverTimestamp() });
    if (webhook.exists && webhook.get('clientId') === claim.clientId) {
      const failures = nextStatus === 'delivered' ? 0 : Number(webhook.get('failureCount') || 0) + 1;
      const current = webhook.get('status');
      tx.update(webhookRef, { lastDeliveryAt: now, lastDeliveryStatus: nextStatus, failureCount: failures, ...(nextStatus === 'delivered' && current === 'degraded' ? { status: 'active' } : failures >= failureThreshold && current === 'active' ? { status: 'degraded' } : {}), updatedAt: FieldValue.serverTimestamp() });
    }
  });
  logger.info(nextStatus === 'delivered' ? 'Webhook delivery succeeded' : nextStatus === 'dead_letter' ? 'Webhook delivery dead lettered' : nextStatus === 'pending' ? 'Webhook retry scheduled' : 'Webhook delivery failed', { deliveryId: claim.deliveryId, webhookId: claim.webhookId, clientId: claim.clientId, eventId: claim.payload.id, attempt: claim.attempt, status: nextStatus, responseStatus: result.statusCode, responseTimeMs: result.responseTimeMs, errorCode: result.errorCode });
}
async function processOne(ref: DocumentReference) {
  const claim = await claimDelivery(ref); if (!claim) return;
  logger.info('Webhook delivery started', { deliveryId: claim.deliveryId, webhookId: claim.webhookId, clientId: claim.clientId, eventId: claim.payload.id, attempt: claim.attempt });
  let result;
  try {
    const secret = decryptWebhookSecret({ secretEncrypted: claim.endpoint.secretEncrypted, secretIv: claim.endpoint.secretIv, secretTag: claim.endpoint.secretTag }, encryptionKey.value());
    result = await deliverWebhook({ webhookId: claim.webhookId, url: String(claim.endpoint.url), secret, payload: claim.payload, timeoutMs, maxPayloadBytes, maxResponseBytes, urlOptions });
  } catch (e) { result = { ok: false, statusCode: null, responseTimeMs: 0, errorCode: 'WEBHOOK_SECRET_ERROR', errorMessage: 'Webhook could not be signed or decrypted.' }; }
  await finishDelivery(claim, result);
}
async function pollCandidateRefs() {
  const now = Timestamp.now(); const limit = Math.max(workerConcurrency * 4, 20);
  const [pending, processing] = await Promise.all([db.collection('webhook_deliveries').where('status', '==', 'pending').where('nextAttemptAt', '<=', now).orderBy('nextAttemptAt', 'asc').limit(limit).get(), db.collection('webhook_deliveries').where('status', '==', 'processing').where('lockUntil', '<=', now).orderBy('lockUntil', 'asc').limit(limit).get()]);
  const map = new Map([...pending.docs, ...processing.docs].map((doc) => [doc.id, doc.ref])); return [...map.values()];
}
export const deliverWebhookQueue = onSchedule({ schedule: 'every 1 minutes', region: process.env.FUNCTION_REGION || 'us-central1', timeoutSeconds: 540, memory: '512MiB', maxInstances: 1, secrets: [encryptionKey] }, async () => {
  const refs = await pollCandidateRefs(); let cursor = 0;
  const runners = Array.from({ length: Math.min(workerConcurrency, refs.length) }, async () => { while (cursor < refs.length) { const index = cursor++; await processOne(refs[index]); } });
  await Promise.all(runners);
});
