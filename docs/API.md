# Public REST API v1

Phase 4 exposes read-only attendance data to client school software. Phase 5 adds platform-admin managed webhooks for verified `attendance.created` events. Client writes, billing, and new T800 protocol behavior remain out of scope.

## Base URL and setup

Routes are versioned under `/api/v1`. Configure `API_BASE_URL` for the externally reachable HTTPS origin and `API_PORT`/`API_HOST` for the listener. The API process currently runs beside the TCP and health listeners; expose the API port through a TLS reverse proxy or load balancer before production use. Keep port 8001 dedicated to the T800 TCP listener.

Configure `API_KEY_PEPPER` with at least 32 random characters, `API_RATE_LIMIT` (default 60 requests per minute), `CORS_ORIGINS` (comma-separated exact browser origins), and Firebase Admin ADC. Do not use or publish the Firebase browser `apiKey` as an API credential. The API does not return Firebase credentials. Workspace `service-account.json` files are not auto-discovered; if `GOOGLE_APPLICATION_CREDENTIALS` points at one, backend startup refuses it. Use workload identity/ADC or a newly rotated external credential after revoking any key exposed in chat.

The API Management page and `/api/v1/admin/*` routes require a verified Firebase ID token with one of these custom claims: `admin: true`, `role: "admin"`, or `roles` containing `"admin"`. Set a claim through a trusted Firebase Admin process with ADC configured. In PowerShell, set `$env:ADMIN_EMAIL='admin@school.example'` and run `npm run set-admin`. The dashboard does not let users grant themselves a role. Admin endpoints are intended for the authenticated dashboard, not client school software.

## Authentication

Client software sends the generated key in:

```http
Authorization: Bearer sca_live_<prefix>_<secret>
```

Keys are generated using a cryptographic random source. Only an HMAC-SHA-256 digest using `API_KEY_PEPPER` is stored in `api_clients`; the full key is returned once at creation or rotation. It cannot be recovered afterward. Disable, revoke, rotate, and expiry are checked on every request. Revocation clears the stored key hash and takes effect on the next request.

## Public endpoints

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/v1/health` | none | Minimal service readiness |
| `GET /api/v1/attendance` | `attendance:read` | Filtered attendance with pagination |
| `GET /api/v1/attendance/today` | `attendance:read` | Current day in Asia/Kolkata |
| `GET /api/v1/students` | `students:read` | Student list, search and filters |
| `GET /api/v1/students/{studentId}` | `students:read` | One student's allowlisted fields |
| `GET /api/v1/students/{studentId}/attendance` | `students:read`, `attendance:read` | Student attendance history |
| `GET /api/v1/devices` | `devices:read` | Safe device summary |

`POST /api/v1/attendance` and all student/device write operations are unavailable. Public routes do not accept a `clientId` parameter as an identity or tenant selector.

Dashboard-only client administration is authenticated with the Firebase ID token and server-side admin claim:

| Method and path | Action |
| --- | --- |
| `GET /api/v1/admin/clients` | List clients and daily metrics |
| `POST /api/v1/admin/clients` | Create a tenant-scoped client and return its API key once |
| `POST /api/v1/admin/clients/{clientId}/key` | Rotate the key and return replacement once |
| `PATCH /api/v1/admin/clients/{clientId}/status` | Activate, disable or revoke |
| `PATCH /api/v1/admin/clients/{clientId}/permissions` | Change the Phase 4 read permissions |

Webhook management is also admin-only and uses the same Firebase ID token and admin claim. External client API keys cannot call these routes.

| Method and path | Action |
| --- | --- |
| `GET /api/v1/clients/{clientId}/webhooks` | List endpoint metadata (never secrets) |
| `POST /api/v1/clients/{clientId}/webhooks` | Create endpoint; returns signing secret once |
| `GET /api/v1/clients/{clientId}/webhooks/{webhookId}` | Read endpoint metadata |
| `PATCH /api/v1/clients/{clientId}/webhooks/{webhookId}` | Edit URL, description, events, or status |
| `DELETE /api/v1/clients/{clientId}/webhooks/{webhookId}` | Disable endpoint |
| `POST /api/v1/clients/{clientId}/webhooks/{webhookId}/test` | Send a `webhook.test` request |
| `POST /api/v1/clients/{clientId}/webhooks/{webhookId}/secret` | Rotate secret; returns replacement once |
| `GET /api/v1/clients/{clientId}/webhooks/{webhookId}/deliveries` | Read safe delivery history |

Phase 6 device enrollment operations are also authenticated-admin-only, separate from client API-key access. See [`DEVICE-ENROLLMENT.md`](DEVICE-ENROLLMENT.md) for paths and request shapes. No public client API can create or link device users.

Phase 7 device command history/log routes are admin-only and require tenant-scoped `clientId` and `tenantId` token claims. `GET /api/v1/admin/devices/{deviceId}/commands`, `POST /api/v1/admin/devices/{deviceId}/commands`, and `GET /api/v1/admin/devices/{deviceId}/logs` are private management routes. Unverified commands are recorded as unsupported and never transmitted. Public API keys cannot call them. See [`REMOTE-DEVICE-MANAGEMENT.md`](REMOTE-DEVICE-MANAGEMENT.md).

### Pagination and filters

All paginated routes accept `page` (default `1`) and `limit` (default `50`, maximum `100`). Paginated responses contain `page`, `limit`, `total`, and `hasMore`.

`GET /api/v1/attendance` supports `from`, `to` (`YYYY-MM-DD`, inclusive Asia/Kolkata school dates), `studentId`, `deviceUserId`, `deviceId`, `class`, `section`, `method`, and `status`. `GET /api/v1/attendance/today` always uses Asia/Kolkata day boundaries. `GET /api/v1/students` supports `search`, `class`, `section`, and `status`. Student attendance history supports `from` and `to` using the same school-date timezone.

Success responses use `{ "success": true, "data": ... }`. Errors use `{ "success": false, "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Each request has a response `X-Request-ID`. Safe caller IDs matching `[A-Za-z0-9._:-]{1,128}` are preserved; other IDs are replaced with a generated UUID.

Example attendance response:

```json
{
  "success": true,
  "data": [{
    "event_id": "event-123",
    "student_id": "STU1001",
    "device_user_id": "1001",
    "student_name": "Test Student",
    "class": "8",
    "section": "A",
    "attendance_time": "2026-09-27T08:42:15+05:30",
    "method": "fingerprint",
    "status": "present",
    "device_id": "T800_01"
  }],
  "pagination": { "page": 1, "limit": 50, "total": 1, "hasMore": false }
}
```

## Status and error codes

| HTTP | Error codes | Meaning |
| --- | --- | --- |
| 400 | `INVALID_DATE`, `INVALID_DATE_RANGE`, `INVALID_PAGINATION`, `INVALID_*` | Invalid input |
| 401 | `MISSING_API_KEY`, `INVALID_API_KEY`, `API_KEY_EXPIRED`, `CLIENT_DISABLED` | Missing or unusable client credential |
| 403 | `PERMISSION_DENIED`, `ADMIN_REQUIRED`, `CORS_ORIGIN_DENIED` | Authenticated identity lacks access |
| 404 | `NOT_FOUND` | Resource/route is not available in this tenant |
| 405 | `METHOD_NOT_ALLOWED` | Unsupported method |
| 429 | `RATE_LIMIT_EXCEEDED` | Per-client limit reached |
| 500 | `INTERNAL_ERROR` | Generic server error; internal traces are not returned |
| 503 | `TENANT_DATA_LIMIT` or health unavailable | Service/data query unavailable |

Rate limits use `api_clients.rateLimit` per client (default `API_RATE_LIMIT` or 60 per minute). Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. Counters are Firestore-backed and shared between API instances. The included [`firestore.indexes.json`](../firestore.indexes.json) defines the API log composite index and TTL for `api_rate_limits.expireAt`; deploy those indexes/TTL settings before using the dashboard metrics at scale.

## Tenant isolation and data migration

Each API client is assigned one `tenantId`. Every public data query explicitly filters Firestore by that server-resolved tenant ID; request parameters cannot override it. Documents without `tenantId` are intentionally omitted. Set `VITE_DEFAULT_TENANT_ID` for new dashboard-created students and `DEFAULT_TENANT_ID` for backend-created attendance/device records. Existing student, attendance, and device documents need a reviewed migration that assigns the correct tenant before clients can read historical data. Never bulk-assign a tenant until ownership has been checked.

The current endpoint implementation scans up to 5,000 records per tenant collection and filters/paginates in memory. It returns a safe 503 above that cap. Before larger production datasets, replace scans with indexed tenant/date/filter queries and cursor pagination; publish the required Firestore indexes.

## Firestore collections

- `api_clients`: client metadata, tenant, permissions, status, key prefix, HMAC hash and usage metadata; never the raw key.
- `api_logs`: request ID, client ID, timestamp, method, path without query string, response status/time, IP, user agent and error code. Authorization headers and API secrets are excluded.
- `api_rate_limits`: per-client minute counters, with `expireAt` for TTL cleanup.
- `client_audit_logs`: client lifecycle and permission events.
- `webhook_endpoints`: tenant-bound endpoint metadata and encrypted secret; never stores the raw signing secret.
- `webhook_deliveries`: durable jobs and safe delivery history; never exposed to client API keys.
- `webhook_rate_limits`: per-webhook minute counters with TTL cleanup.

## CORS, HTTPS and logging

Server-to-server clients do not need CORS. If browser clients are required, list exact origins in `CORS_ORIGINS`; wildcard origin is not enabled by default. Put the API behind HTTPS. Security headers are set by the API process; a TLS proxy should add its own deployment hardening. Request logs never store the Authorization header or raw API key. Avoid enabling raw T800 packet diagnostics in production without an explicit retention/access policy.

## Versioning

All public routes begin with `/api/v1`. Breaking contract changes require a new version prefix; additive response fields may be added within v1.
