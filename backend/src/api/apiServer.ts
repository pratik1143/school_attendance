import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { env } from '../config/env.ts';
import { getDb, isFirestoreReady } from '../firestore/admin.ts';
import { logger } from '../utils/logger.ts';
import { API_PERMISSIONS, authenticateApiKey, changeClientPermissions, changeClientStatus, consumeRateLimit, createApiClient, getAdminIdentity, getAdminUserId, listApiClients, rateLimitAllowed, rotateClientKey, verifyAdminToken, type ApiClient, type ApiPermission } from './clients.ts';
import { createWebhook, deleteWebhook, listWebhooks, getWebhook, updateWebhook, rotateWebhookSecret, testWebhook, webhookDeliveries, WebhookServiceError } from '../webhooks/service.ts';
import { completeDeviceUserProfile, EnrollmentServiceError, linkDeviceUser, listDeviceEnrollment, registerManualDeviceUser, setDeviceUserStatus } from '../deviceEnrollment/service.ts';
import { createDeviceCommand, DeviceCommandError, listDeviceCommands, listSafeDeviceLogs } from '../deviceCommands/service.ts';
import { handleSchoolManagementRequest, SchoolServiceError } from '../schoolManagement/service.ts';

type ApiError = { status: number; code: string; message: string };
const error = (status: number, code: string, message: string): ApiError => ({ status, code, message });
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
const success = (data: unknown, extra: Record<string, unknown> = {}) => ({ success: true, data, ...extra });
const failure = (e: ApiError) => ({ success: false, error: { code: e.code, message: e.message } });
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const apiSecretPattern = /sca_live_[a-f0-9]{12}_[A-Za-z0-9_-]{40,}/g;
const scrubApiSecrets = (value: string) => value.replace(apiSecretPattern, '[REDACTED_API_KEY]');

export function dateOnly(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw error(400, 'INVALID_DATE', 'Dates must use YYYY-MM-DD format.');
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw error(400, 'INVALID_DATE', 'The date is not valid.');
  return parsed - 330 * 60_000;
}
export function pageParams(url: URL) {
  const page = Number(url.searchParams.get('page') || 1); const limit = Number(url.searchParams.get('limit') || 50);
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, 'INVALID_PAGINATION', 'page must be at least 1 and limit must be between 1 and 100.');
  return { page, limit };
}
function validateQuery(url: URL, allowed: string[]) {
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key)) throw error(400, 'INVALID_QUERY', `Unsupported query parameter: ${key}.`);
    if (url.searchParams.getAll(key).length > 1) throw error(400, 'INVALID_QUERY', `Query parameter ${key} may only be supplied once.`);
    if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw error(400, 'INVALID_QUERY', `Query parameter ${key} is invalid.`);
  }
}
function asDate(value: unknown): Date | null {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; }
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') return value.toDate();
  return null;
}
export function formatIndia(date: Date | null): string | null {
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+05:30`;
}
function dayBoundsIndia(now = new Date()) {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const start = Date.parse(`${localDate}T00:00:00Z`) - 330 * 60_000;
  return { start, end: start + 86_400_000 };
}
function getDataDate(d: FirebaseFirestore.DocumentData): Date | null { return asDate(d.timestamp ?? d.attendanceTime ?? d.attendance_time); }
export function pickStudent(id: string, d: FirebaseFirestore.DocumentData) { return { student_id: String(d.studentId || id), name: String(d.name || ''), class: String(d.class || ''), section: String(d.section || ''), device_user_id: String(d.deviceUserId || ''), status: String(d.status || 'active') }; }
export function pickAttendance(id: string, d: FirebaseFirestore.DocumentData, student?: FirebaseFirestore.DocumentData) {
  return { event_id: String(d.eventId || id), student_id: String(d.studentId || ''), device_user_id: String(d.deviceUserId || ''), student_name: String(d.studentName || student?.name || ''), class: String(d.class || student?.class || ''), section: String(d.section || student?.section || ''), attendance_time: formatIndia(getDataDate(d)), method: String(d.method || ''), status: String(d.status || ''), device_id: String(d.deviceId || '') };
}
export function belongsToTenant(record: Record<string, unknown>, tenantId: string): boolean { return typeof record.tenantId === 'string' && record.tenantId === tenantId; }
export function hasPermission(client: Pick<ApiClient, 'permissions'>, permission: ApiPermission): boolean { return client.permissions.includes(permission); }
async function tenantDocs(collection: 'attendance' | 'students' | 'devices', tenantId: string) {
  // Explicit tenant equality is mandatory; legacy documents without tenantId are never returned.
  const snap = await getDb().collection(collection).where('tenantId', '==', tenantId).limit(5001).get();
  if (snap.size > 5000) throw error(503, 'TENANT_DATA_LIMIT', 'This tenant has too many records for the current API query configuration.');
  return snap.docs.filter((doc) => belongsToTenant(doc.data(), tenantId));
}
function requirePermission(client: ApiClient, permission: ApiPermission) { if (!hasPermission(client, permission)) throw error(403, 'PERMISSION_DENIED', 'This API key does not have permission to access this resource.'); }

async function attendanceRows(client: ApiClient, url: URL, today = false) {
  validateQuery(url, today ? ['page', 'limit'] : ['page', 'limit', 'from', 'to', 'studentId', 'deviceUserId', 'deviceId', 'class', 'section', 'method', 'status']);
  for (const parameter of ['studentId', 'deviceId']) { const value = url.searchParams.get(parameter); if (value && !safeId(value)) throw error(400, parameter === 'studentId' ? 'INVALID_STUDENT_ID' : 'INVALID_DEVICE_ID', `${parameter} contains unsupported characters.`); }
  const { page, limit } = pageParams(url); const docs = await tenantDocs('attendance', client.tenantId); const students = await tenantDocs('students', client.tenantId);
  const studentById = new Map<string, FirebaseFirestore.DocumentData>();
  for (const student of students) { const d = student.data(); studentById.set(String(d.studentId || student.id), d); }
  let from = dateOnly(url.searchParams.get('from')); let to = dateOnly(url.searchParams.get('to'));
  if (today) ({ start: from, end: to } = dayBoundsIndia()); else if (from !== null && to !== null && from > to) throw error(400, 'INVALID_DATE_RANGE', 'from must be on or before to.');
  if (to !== null) to += 86_400_000;
  const filters = ['studentId', 'deviceUserId', 'deviceId', 'class', 'section', 'method', 'status'] as const;
  const rows = docs.map((doc) => ({ id: doc.id, d: doc.data() })).filter(({ d }) => {
    const date = getDataDate(d); const student = studentById.get(String(d.studentId || ''));
    if ((from !== null || to !== null) && !date) return false;
    if (from !== null && date!.getTime() < from) return false; if (to !== null && date!.getTime() >= to) return false;
    for (const f of filters) { const wanted = url.searchParams.get(f); if (wanted && String(f === 'class' || f === 'section' ? (d[f] ?? student?.[f]) : d[f] ?? '') !== wanted) return false; }
    return true;
  }).sort((a, b) => (getDataDate(b.d)?.getTime() || 0) - (getDataDate(a.d)?.getTime() || 0));
  const start = (page - 1) * limit;
  return success(rows.slice(start, start + limit).map(({ id, d }) => pickAttendance(id, d, studentById.get(String(d.studentId || '')))), { pagination: { page, limit, total: rows.length, hasMore: start + limit < rows.length } });
}
async function studentRows(client: ApiClient, url: URL) {
  validateQuery(url, ['page', 'limit', 'search', 'class', 'section', 'status']);
  const { page, limit } = pageParams(url); const docs = await tenantDocs('students', client.tenantId);
  const search = (url.searchParams.get('search') || '').trim().toLowerCase(); if (search.length > 100) throw error(400, 'INVALID_SEARCH', 'search must be 100 characters or fewer.');
  const rows = docs.map((doc) => pickStudent(doc.id, doc.data())).filter((s) => (!search || `${s.student_id} ${s.name} ${s.device_user_id}`.toLowerCase().includes(search)) && ['class', 'section', 'status'].every((f) => !url.searchParams.get(f) || s[f as keyof typeof s] === url.searchParams.get(f))).sort((a, b) => a.name.localeCompare(b.name));
  const start = (page - 1) * limit; return success(rows.slice(start, start + limit), { pagination: { page, limit, total: rows.length, hasMore: start + limit < rows.length } });
}
async function handleClientRoute(client: ApiClient, method: string, path: string, url: URL) {
  if (method !== 'GET') throw error(405, 'METHOD_NOT_ALLOWED', 'Only GET requests are allowed for these resources.');
  if (path === '/api/v1/attendance' || path === '/api/v1/attendance/today') { requirePermission(client, 'attendance:read'); return attendanceRows(client, url, path.endsWith('/today')); }
  if (path === '/api/v1/students') { requirePermission(client, 'students:read'); return studentRows(client, url); }
  if (path === '/api/v1/devices') {
    validateQuery(url, []);
    requirePermission(client, 'devices:read'); const docs = await tenantDocs('devices', client.tenantId);
    const data = docs.map((doc) => { const d = doc.data(); return { device_id: String(d.deviceId || doc.id), device_name: String(d.deviceName || ''), model: String(d.model || ''), cloud_id: String(d.cloudId || ''), connection_type: String(d.connectionType || ''), status: String(d.status || 'unknown'), last_seen: formatIndia(asDate(d.lastSeen)) }; });
    return success(data);
  }
  const studentMatch = path.match(/^\/api\/v1\/students\/([^/]+)(?:\/attendance)?$/);
  if (studentMatch) {
    requirePermission(client, 'students:read'); let id = ''; try { id = decodeURIComponent(studentMatch[1]); } catch { throw error(400, 'INVALID_STUDENT_ID', 'studentId encoding is invalid.'); } if (!safeId(id)) throw error(400, 'INVALID_STUDENT_ID', 'studentId contains unsupported characters.');
    validateQuery(url, path.endsWith('/attendance') ? ['from', 'to', 'page', 'limit'] : []);
    const docs = await tenantDocs('students', client.tenantId); const found = docs.find((doc) => doc.id === id || String(doc.get('studentId') || '') === id); if (!found) throw error(404, 'NOT_FOUND', 'Student not found.');
    if (path.endsWith('/attendance')) { requirePermission(client, 'attendance:read'); const { page, limit } = pageParams(url); let from = dateOnly(url.searchParams.get('from')); let to = dateOnly(url.searchParams.get('to')); if (from !== null && to !== null && from > to) throw error(400, 'INVALID_DATE_RANGE', 'from must be on or before to.'); if (to !== null) to += 86_400_000;
      const records = await tenantDocs('attendance', client.tenantId); const rows = records.filter((doc) => String(doc.get('studentId') || '') === String(found.get('studentId') || found.id)).filter((doc) => { const d = getDataDate(doc.data()); return (!from || (d && d.getTime() >= from)) && (!to || (d && d.getTime() < to)); }).sort((a, b) => (getDataDate(b.data())?.getTime() || 0) - (getDataDate(a.data())?.getTime() || 0));
      const start = (page - 1) * limit; return success(rows.slice(start, start + limit).map((doc) => pickAttendance(doc.id, doc.data(), found.data())), { pagination: { page, limit, total: rows.length, hasMore: start + limit < rows.length } }); }
    return success({ ...pickStudent(found.id, found.data()), contact_email: undefined });
  }
  throw error(404, 'NOT_FOUND', 'Endpoint not found.');
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''; for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 16_384) throw error(400, 'INVALID_REQUEST', 'Request body is too large.'); }
  if (!raw) return {}; try { const body = JSON.parse(raw); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw error(400, 'INVALID_REQUEST', 'Request body must be a valid JSON object.'); }
}
function bearer(req: IncomingMessage) { const value = req.headers.authorization || ''; return value.startsWith('Bearer ') ? value.slice(7) : ''; }
async function handleAdmin(req: IncomingMessage, method: string, path: string): Promise<unknown> {
  const commandRoute = path.match(/^\/api\/v1\/admin\/devices\/([A-Za-z0-9_-]{1,128})\/(commands|logs)$/);
  if (commandRoute) {
    const identity = await getAdminIdentity(bearer(req)); if (!identity) throw error(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
    const [, deviceId, action] = commandRoute;
    if (method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost'); validateQuery(url, ['limit']); const limit = Number(url.searchParams.get('limit') || 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error(400, 'INVALID_LIMIT', 'limit must be between 1 and 100.');
      return success(action === 'commands' ? await listDeviceCommands(deviceId, identity, limit) : await listSafeDeviceLogs(deviceId, identity, limit));
    }
    if (method === 'POST' && action === 'commands') {
      const body = await readBody(req); if (Object.keys(body).some((key) => !['commandType', 'confirmation'].includes(key))) throw error(400, 'INVALID_COMMAND_REQUEST', 'Only an allowlisted commandType and explicit confirmation are accepted; arbitrary payloads are forbidden.');
      return success(await createDeviceCommand({ deviceId, commandType: body.commandType, confirmation: body.confirmation, scope: identity }));
    }
    throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  }
  if (!await verifyAdminToken(bearer(req))) throw error(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
  if (path === '/api/v1/admin/device-enrollment' && method === 'GET') return success(await listDeviceEnrollment());
  if (path === '/api/v1/admin/device-enrollment/manual' && method === 'POST') {
    const adminUserId = await getAdminUserId(bearer(req)); if (!adminUserId) throw error(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
    return success(await registerManualDeviceUser({ ...await readBody(req), adminUserId }));
  }
  const enrollmentAction = path.match(/^\/api\/v1\/admin\/device-enrollment\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/(link|profile|status)$/);
  if (enrollmentAction && method === 'POST') {
    const [, deviceId, deviceUserId, action] = enrollmentAction; const adminUserId = await getAdminUserId(bearer(req)); if (!adminUserId) throw error(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
    const body = await readBody(req);
    if (action === 'link') { if (typeof body.studentId !== 'string') throw error(400, 'INVALID_STUDENT_ID', 'Choose a student.'); return success(await linkDeviceUser({ deviceId, deviceUserId, studentId: body.studentId, adminUserId })); }
    if (action === 'profile') return success(await completeDeviceUserProfile({ deviceId, deviceUserId, studentId: String(body.studentId || ''), name: String(body.name || ''), className: String(body.class || ''), section: String(body.section || ''), status: typeof body.status === 'string' ? body.status : undefined, adminUserId }));
    if (!['new', 'pending_profile', 'ignored', 'disabled'].includes(String(body.status))) throw error(400, 'INVALID_DEVICE_USER_STATUS', 'Status is invalid.');
    return success(await setDeviceUserStatus({ deviceId, deviceUserId, status: body.status as 'new' | 'pending_profile' | 'ignored' | 'disabled', adminUserId }));
  }
  if (path === '/api/v1/admin/clients' && method === 'GET') {
    const clients = await listApiClients(); const { start, end } = dayBoundsIndia(); const logs = getDb().collection('api_logs');
    const deliveries = getDb().collection('webhook_deliveries'); const endpoints = getDb().collection('webhook_endpoints');
    const today = (collection: FirebaseFirestore.CollectionReference, status?: string | string[]) => { let query: FirebaseFirestore.Query = collection.where('createdAt', '>=', new Date(start)).where('createdAt', '<', new Date(end)); if (typeof status === 'string') query = query.where('status', '==', status); if (Array.isArray(status)) query = query.where('status', 'in', status); return query.count().get(); };
    const [requests, errors, activeWebhooks, deliveriesToday, successfulDeliveries, failedDeliveries] = await Promise.all([
      logs.where('timestamp', '>=', new Date(start)).where('timestamp', '<', new Date(end)).count().get(),
      logs.where('timestamp', '>=', new Date(start)).where('timestamp', '<', new Date(end)).where('statusCode', '>=', 400).count().get(),
      endpoints.where('status', '==', 'active').count().get(),
      today(deliveries), today(deliveries, 'delivered'), today(deliveries, ['failed', 'dead_letter']),
    ]);
    return success({ clients, metrics: { activeClients: clients.filter((c) => c.status === 'active').length, activeKeys: clients.filter((c) => c.status === 'active' && c.keyPrefix).length, requestsToday: requests.data().count, errorsToday: errors.data().count }, webhookMetrics: { activeWebhooks: activeWebhooks.data().count, deliveriesToday: deliveriesToday.data().count, successfulDeliveries: successfulDeliveries.data().count, failedDeliveries: failedDeliveries.data().count } });
  }
  if (path === '/api/v1/admin/clients' && method === 'POST') {
    const body = await readBody(req); const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : ''; const schoolName = typeof body.schoolName === 'string' ? body.schoolName.trim() : ''; const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : '';
    if (!clientName || clientName.length > 120 || !schoolName || schoolName.length > 120 || !safeId(tenantId)) throw error(400, 'INVALID_CLIENT', 'Client name, school name and a valid tenant ID are required.');
    const permissions = body.permissions === undefined ? [...API_PERMISSIONS] : body.permissions;
    if (!Array.isArray(permissions) || permissions.some((p) => !API_PERMISSIONS.includes(p))) throw error(400, 'INVALID_PERMISSIONS', 'Only attendance:read, students:read and devices:read are available in Phase 4.');
    const rateLimit = Number(body.rateLimit ?? env.apiRateLimit); if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > 100_000) throw error(400, 'INVALID_RATE_LIMIT', 'rateLimit must be between 1 and 100000.');
    if (body.contactEmail && (typeof body.contactEmail !== 'string' || body.contactEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contactEmail))) throw error(400, 'INVALID_CONTACT_EMAIL', 'contactEmail must be a valid email address.');
    let expiresAt: Date | null = null; if (body.expiresAt) { expiresAt = new Date(String(body.expiresAt)); if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw error(400, 'INVALID_EXPIRY', 'Expiry must be a valid future date.'); }
    const result = await createApiClient({ clientName, schoolName, tenantId, contactName: typeof body.contactName === 'string' ? body.contactName.slice(0, 120) : '', contactEmail: typeof body.contactEmail === 'string' ? body.contactEmail.slice(0, 254) : '', permissions, rateLimit, expiresAt }); return success(result);
  }
  const match = path.match(/^\/api\/v1\/admin\/clients\/([A-Za-z0-9_-]+)(?:\/(key|status|permissions))?$/); if (!match) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
  const id = match[1];
  if (method === 'POST' && match[2] === 'key') { const result = await rotateClientKey(id); if (!result) throw error(404, 'NOT_FOUND', 'Client not found.'); return success(result); }
  if (method === 'PATCH' && match[2] === 'status') { const body = await readBody(req); if (!['active', 'disabled', 'revoked'].includes(String(body.status))) throw error(400, 'INVALID_STATUS', 'status must be active, disabled or revoked.'); if (!await changeClientStatus(id, body.status as 'active' | 'disabled' | 'revoked')) throw error(404, 'NOT_FOUND', 'Client not found.'); return success({ clientId: id, status: body.status }); }
  if (method === 'PATCH' && match[2] === 'permissions') { const body = await readBody(req); if (!Array.isArray(body.permissions) || body.permissions.some((p) => !API_PERMISSIONS.includes(p as ApiPermission))) throw error(400, 'INVALID_PERMISSIONS', 'Only Phase 4 read permissions are available.'); if (!await changeClientPermissions(id, body.permissions as ApiPermission[])) throw error(404, 'NOT_FOUND', 'Client not found.'); return success({ clientId: id, permissions: body.permissions }); }
  throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

async function handleWebhookAdmin(req: IncomingMessage, method: string, url: URL): Promise<unknown> {
  if (!await verifyAdminToken(bearer(req))) throw error(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
  const match = url.pathname.match(/^\/api\/v1\/clients\/([A-Za-z0-9_-]{1,128})\/webhooks(?:\/([A-Za-z0-9_-]{1,128})(?:\/(test|secret|deliveries))?)?$/);
  if (!match) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
  const [, clientId, webhookId, action] = match;
  if (!webhookId && method === 'GET') return success(await listWebhooks(clientId));
  if (!webhookId && method === 'POST') return success(await createWebhook(clientId, await readBody(req)));
  if (!webhookId) throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  if (method === 'GET' && action === 'deliveries') {
    validateQuery(url, ['page', 'limit']); const { page, limit } = pageParams(url); return success(await webhookDeliveries(clientId, webhookId, page, limit));
  }
  if (method === 'GET' && !action) return success(await getWebhook(clientId, webhookId));
  if (method === 'PATCH' && !action) return success(await updateWebhook(clientId, webhookId, await readBody(req)));
  if (method === 'DELETE' && !action) return success(await deleteWebhook(clientId, webhookId));
  if (method === 'POST' && action === 'secret') return success(await rotateWebhookSecret(clientId, webhookId));
  if (method === 'POST' && action === 'test') return success(await testWebhook(clientId, webhookId));
  throw error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

async function writeApiLog(entry: Record<string, unknown>) { try { await getDb().collection('api_logs').add({ ...entry, timestamp: FieldValue.serverTimestamp() }); } catch (e) { logger.warn('Could not persist API request log', { message: e instanceof Error ? e.message : 'unknown' }); } }
export function buildApiLogRecord(input: { requestId: string; clientId: string | null; method: string; path: string; statusCode: number; responseTime: number; ip: string; userAgent: string; errorCode: string | null }) {
  return { requestId: scrubApiSecrets(input.requestId), clientId: input.clientId, method: scrubApiSecrets(input.method), path: scrubApiSecrets(input.path), statusCode: input.statusCode, responseTime: input.responseTime, ip: input.ip, userAgent: scrubApiSecrets(input.userAgent), errorCode: input.errorCode };
}

export function createApiServer() {
  let server: Server | null = null;
  return {
    async listen(port = env.apiPort, host = env.apiHost): Promise<number> {
      server = createServer(async (req, res) => {
        const requestIdHeader = req.headers['x-request-id']; const requestedId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader;
        const requestId = requestedId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestedId) && !apiSecretPattern.test(requestedId) ? requestedId : randomUUID();
        apiSecretPattern.lastIndex = 0;
        res.setHeader('X-Request-ID', requestId); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); res.setHeader('Cache-Control', 'no-store');
        const origin = req.headers.origin; if (origin) { if (env.corsOrigins.length && env.corsOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS'); } else if (env.corsOrigins.length) { json(res, 403, failure(error(403, 'CORS_ORIGIN_DENIED', 'Origin is not allowed.'))); return; } }
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        const start = Date.now(); let path = '/'; let clientId = ''; let statusCode = 500; let errorCode: string | null = null; const logEnabled = true;
        res.once('finish', () => { if (logEnabled && path.startsWith('/api/v1/')) void writeApiLog(buildApiLogRecord({ requestId, clientId: clientId || null, method: req.method || 'GET', path, statusCode, responseTime: Date.now() - start, ip: req.socket.remoteAddress || '', userAgent: String(req.headers['user-agent'] || '').slice(0, 256), errorCode })); });
        try {
          const url = new URL(req.url || '/', 'http://localhost'); path = url.pathname;
          if (path === '/api/v1/health' && req.method === 'GET') { const ready = isFirestoreReady() && env.apiKeyPepper.length >= 32; statusCode = ready ? 200 : 503; json(res, statusCode, { success: ready, data: { service: 'school-attendance-api', status: ready ? 'ready' : 'unavailable' } }); return; }
          if (!path.startsWith('/api/v1/')) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
          if (path.startsWith('/api/v1/school/')) { const body = ['POST', 'PATCH', 'PUT'].includes(req.method || '') ? await readBody(req) : undefined; const data = await handleSchoolManagementRequest({ token: bearer(req), method: req.method || 'GET', path, url, body }); statusCode = 200; if (data && typeof data === 'object' && 'csv' in data && typeof data.csv === 'string') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${String(data.filename).replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'no-store' }); res.end(data.csv); return; } json(res, statusCode, success(data)); return; }
          if (path.startsWith('/api/v1/clients/')) { clientId = path.match(/^\/api\/v1\/clients\/([A-Za-z0-9_-]{1,128})/)?.[1] || ''; const body = await handleWebhookAdmin(req, req.method || 'GET', url); statusCode = 200; json(res, statusCode, body); return; }
          if (path.startsWith('/api/v1/admin/')) { const body = await handleAdmin(req, req.method || 'GET', path); statusCode = 200; json(res, statusCode, body); return; }
          if (!['/api/v1/attendance', '/api/v1/attendance/today', '/api/v1/students', '/api/v1/devices'].includes(path) && !/^\/api\/v1\/students\/[^/]+(?:\/attendance)?$/.test(path)) throw error(404, 'NOT_FOUND', 'Endpoint not found.');
          const credential = bearer(req); if (!credential) throw error(401, 'MISSING_API_KEY', 'Provide an API key using Authorization: Bearer.');
          const result = await authenticateApiKey(credential); if (!result.client) throw error(401, result.error, result.error === 'API_KEY_EXPIRED' ? 'API key has expired.' : result.error === 'CLIENT_DISABLED' ? 'This API client is disabled.' : 'Invalid API credentials.');
          const client = result.client; clientId = client.clientId;
          const rate = await consumeRateLimit(client); res.setHeader('X-RateLimit-Limit', String(rate.limit)); res.setHeader('X-RateLimit-Remaining', String(rate.remaining)); res.setHeader('X-RateLimit-Reset', String(Math.floor(rate.resetAt / 1000)));
          if (!rate.allowed) throw error(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests.');
          const body = await handleClientRoute(client, req.method || 'GET', path, url); statusCode = 200; json(res, statusCode, body, { 'X-RateLimit-Limit': String(rate.limit), 'X-RateLimit-Remaining': String(rate.remaining), 'X-RateLimit-Reset': String(Math.floor(rate.resetAt / 1000)) });
        } catch (caught) {
          const e = caught instanceof WebhookServiceError || caught instanceof EnrollmentServiceError || caught instanceof DeviceCommandError || caught instanceof SchoolServiceError ? error(caught.statusCode, caught.code, caught.message) : caught && typeof caught === 'object' && 'status' in caught ? caught as ApiError : error(500, 'INTERNAL_ERROR', 'An internal error occurred.');
          statusCode = e.status; errorCode = e.code;
          if (e.status >= 500) logger.error('Public API request failed', { requestId, code: e.code, message: scrubApiSecrets(caught instanceof Error ? caught.message : 'unknown') });
          json(res, e.status, { ...failure(e), requestId });
        }
      });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(port, host, resolve); });
      const address = server!.address(); const boundPort = address && typeof address === 'object' ? address.port : port;
      logger.info('Public API ready', { host, port: boundPort, version: 'v1' }); return boundPort;
    },
    close(): Promise<void> { return new Promise((resolve) => server ? server.close(() => resolve()) : resolve()); },
  };
}
