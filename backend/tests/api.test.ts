import test from 'node:test';
import assert from 'node:assert/strict';

process.env.API_KEY_PEPPER = 'test-only-pepper-that-is-at-least-32-chars';
process.env.FIRESTORE_WRITES_ENABLED = 'false';
const clients = await import('../src/api/clients.ts');
const apiFns = await import('../src/api/apiServer.ts');
const { createApiServer } = apiFns;

test('generated API keys use the recognizable format and store only a keyed hash', () => {
  const credential = clients.newApiCredential();
  assert.match(credential.key, /^sca_live_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.prefix, clients.safeKeyPrefix(credential.key));
  assert.equal(credential.hash.length, 64);
  assert.notEqual(credential.hash, credential.key);
  assert.equal(clients.isApiSecretValid(credential.key, credential.hash), true);
  assert.equal(clients.isApiSecretValid(`${credential.key}x`, credential.hash), false);
  assert.equal(clients.isApiSecretValid(credential.key, 'not-a-hash'), false);
});

test('admin role abstraction accepts only an explicit admin claim', () => {
  assert.equal(clients.isAdminRole({ admin: true }), true);
  assert.equal(clients.isAdminRole({ role: 'admin' }), true);
  assert.equal(clients.isAdminRole({ roles: ['teacher', 'admin'] }), true);
  assert.equal(clients.isAdminRole({ admin: false, role: 'teacher' }), false);
  assert.equal(clients.isAdminRole({}), false);
});

test('device command scope recognizes only an explicit admin or operator claim', () => {
  assert.equal(clients.isDeviceOperatorRole({ operator: true }), true);
  assert.equal(clients.isDeviceOperatorRole({ role: 'operator' }), true);
  assert.equal(clients.isDeviceOperatorRole({ roles: ['teacher', 'operator'] }), true);
  assert.equal(clients.isDeviceOperatorRole({ role: 'teacher' }), false);
  assert.equal(clients.isDeviceOperatorRole({}), false);
  assert.equal(clients.isAdminRole({ role: 'operator' }), false);
});

test('public API issues a request ID, rejects missing credentials, returns 404, and hides health internals', async (t) => {
  const api = createApiServer(); const port = await api.listen(0, '127.0.0.1');
  t.after(async () => api.close());
  const base = `http://127.0.0.1:${port}`;
  const missing = await fetch(`${base}/api/v1/students`);
  assert.equal(missing.status, 401);
  assert.ok(missing.headers.get('x-request-id'));
  assert.equal((await missing.json()).error.code, 'MISSING_API_KEY');
  const missingWithCustomId = await fetch(`${base}/api/v1/students`, { headers: { 'X-Request-ID': 'client.req-123' } });
  assert.equal(missingWithCustomId.headers.get('x-request-id'), 'client.req-123');
  const replacedId = await fetch(`${base}/api/v1/students`, { headers: { 'X-Request-ID': 'bad id' } });
  assert.notEqual(replacedId.headers.get('x-request-id'), 'bad id');
  const notFound = await fetch(`${base}/api/v1/not-a-route`);
  assert.equal(notFound.status, 404);
  const health = await fetch(`${base}/api/v1/health`);
  const healthBody = await health.json();
  assert.equal(healthBody.data.service, 'school-attendance-api');
  assert.equal('tcpPort' in healthBody.data, false);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
});

test('API request log mapper is allowlisted and excludes credentials and headers', () => {
  const secret = 'sca_live_0123456789ab_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijk';
  const record = apiFns.buildApiLogRecord({ requestId: 'req-1', clientId: 'client-1', method: 'GET', path: `/api/v1/students/${secret}`, statusCode: 200, responseTime: 8, ip: '127.0.0.1', userAgent: `test ${secret}`, errorCode: null, authorization: `Bearer ${secret}`, rawApiKey: secret } as never);
  assert.deepEqual(Object.keys(record).sort(), ['requestId', 'clientId', 'method', 'path', 'statusCode', 'responseTime', 'ip', 'userAgent', 'errorCode'].sort());
  assert.equal(JSON.stringify(record).includes(secret), false);
});

test('attendance date filters require real YYYY-MM-DD calendar dates', () => {
  assert.equal(new Date(apiFns.dateOnly('2026-09-01')!).toISOString(), '2026-08-31T18:30:00.000Z');
  assert.throws(() => apiFns.dateOnly('2026-02-30'), (e: { code?: string }) => e.code === 'INVALID_DATE');
});

test('pagination rejects malformed and excessive page sizes', () => {
  assert.deepEqual(apiFns.pageParams(new URL('http://local/api?page=2&limit=25')), { page: 2, limit: 25 });
  assert.throws(() => apiFns.pageParams(new URL('http://local/api?page=0')), (e: { code?: string }) => e.code === 'INVALID_PAGINATION');
  assert.throws(() => apiFns.pageParams(new URL('http://local/api?limit=101')), (e: { code?: string }) => e.code === 'INVALID_PAGINATION');
});

test('attendance timestamps serialize in Asia/Kolkata with an explicit offset', () => {
  assert.equal(apiFns.formatIndia(new Date('2026-09-27T03:12:15.000Z')), '2026-09-27T08:42:15+05:30');
  assert.equal(apiFns.formatIndia(null), null);
});

test('tenant checks match only the authenticated client tenant', () => {
  assert.equal(apiFns.belongsToTenant({ tenantId: 'school-a' }, 'school-a'), true);
  assert.equal(apiFns.belongsToTenant({ tenantId: 'school-b' }, 'school-a'), false);
  assert.equal(apiFns.belongsToTenant({ studentId: 'private-legacy-record' }, 'school-a'), false);
});

test('permission checks deny access unless the client was explicitly granted it', () => {
  const client = { permissions: ['students:read'] as Array<'students:read'> };
  assert.equal(apiFns.hasPermission(client, 'students:read'), true);
  assert.equal(apiFns.hasPermission(client, 'attendance:read'), false);
});

test('per-client rate-limit decision rejects only counts above the configured limit', () => {
  assert.equal(clients.rateLimitAllowed(60, 60), true);
  assert.equal(clients.rateLimitAllowed(61, 60), false);
  assert.equal(clients.rateLimitAllowed(1, 10), true);
});

test('student and attendance API mappers omit internal Firestore fields', () => {
  const student = apiFns.pickStudent('doc-id', { studentId: 'STU1', name: 'A Student', class: '8', section: 'A', deviceUserId: '1001', status: 'active', tenantId: 'school-a', guardianPhone: 'secret', internalNotes: 'private' });
  assert.deepEqual(Object.keys(student).sort(), ['class', 'device_user_id', 'name', 'section', 'status', 'student_id'].sort());
  const event = apiFns.pickAttendance('event-doc', { eventId: 'event-1', studentId: 'STU1', deviceId: 'gate-1', timestamp: new Date('2026-09-27T03:12:15Z'), method: 'fingerprint', status: 'present', rawLogId: 'raw-secret-reference', protocol: 'wire-private', tenantId: 'school-a', internal: 'private' }, { name: 'A Student', class: '8', section: 'A' });
  assert.equal(event.student_name, 'A Student');
  assert.equal('rawLogId' in event, false);
  assert.equal('tenantId' in event, false);
});

test('client lifecycle returns distinct disabled, revoked and expired outcomes', () => {
  const now = new Date('2026-09-27T00:00:00Z');
  assert.equal(clients.clientUsable('active', new Date('2026-09-28T00:00:00Z'), now), 'active');
  assert.equal(clients.clientUsable('disabled', null, now), 'CLIENT_DISABLED');
  assert.equal(clients.clientUsable('revoked', null, now), 'INVALID_API_KEY');
  assert.equal(clients.clientUsable('active', new Date('2026-09-26T00:00:00Z'), now), 'API_KEY_EXPIRED');
});
