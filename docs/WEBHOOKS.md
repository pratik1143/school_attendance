# Attendance webhooks

Webhooks send only verified `attendance.created` records to a client school system. A Firestore `onDocumentCreated` function creates durable delivery jobs; a separate scheduled worker sends them. The T800 TCP listener stays on the VM and is not part of Cloud Functions.

## Setup and secret handling

1. Deploy the Firestore indexes and Functions from the project root with a current Firebase CLI (`firebase deploy --only firestore:indexes,functions`). This config targets Functions 2nd gen / Node.js 22.
2. Configure a random 32-byte AES key as 64 hex characters in Secret Manager / Functions secret `WEBHOOK_SECRET_ENCRYPTION_KEY`. Generate it with a cryptographically secure random generator and retain it in your organization's secret manager. Do not put the key in source control or Firestore. The API process also needs this secret to create, rotate, and decrypt endpoint secrets.
3. Set the optional `WEBHOOK_*` values described below in the backend and Functions environment. Configure Firebase Admin with workload identity / Application Default Credentials; never reuse the credential pasted into chat.
4. In API Management, select a client, add an HTTPS endpoint and select `attendance.created`. Copy the returned signing secret immediately; it is shown only once. Rotation invalidates the old secret.
5. Configure the receiving service to verify the signature and persist processed event IDs before handling the attendance.

Production endpoints must use HTTPS. HTTP and localhost are accepted only when development mode is explicitly enabled. URL validation rejects credentials, fragments, non-public DNS results, and private, loopback, link-local, multicast, and metadata addresses. The worker resolves and pins the destination for the request, does not follow redirects, and rejects oversized responses. This is defense in depth; deploy egress firewall rules as well.

## Event contract

The only production event is `attendance.created`. Attendance must have `verified: true`, `webhookEligible: true`, and a resolvable client/tenant owner. Duplicate, test, invalid, or unknown records are not eligible. Delivery jobs use deterministic identity derived from webhook ID and event ID, so repeated Firestore trigger invocations cannot enqueue another logical job.

Headers:

```http
Content-Type: application/json
X-Webhook-ID: wh_...
X-Webhook-Event: attendance.created
X-Webhook-Timestamp: 1790491335
X-Webhook-Event-ID: evt_...
X-Webhook-Signature: sha256=<hex>
```

The body is JSON with `id`, `event`, `created_at`, and an allowlisted `data` object containing only attendance fields actually present. Raw device packets and internal Firestore metadata are excluded. The exact serialized body bytes are signed; do not parse and reserialize it before verification. `webhook.test` requests are sent only by the admin test action and never create attendance.

## Signature verification

The signature is HMAC-SHA-256 over the UTF-8 bytes of `${timestamp}.${rawBody}` using the endpoint's signing secret, encoded as lowercase hex and prefixed with `sha256=`. Compare signatures in constant time and reject timestamps outside a short tolerance (five minutes by default). The raw request body must be captured before JSON parsing.

### Node.js (Express)

```js
import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.post('/api/attendance', express.raw({ type: 'application/json', limit: '64kb' }), (req, res) => {
  const raw = req.body; // Buffer, before JSON parsing
  const timestamp = req.get('X-Webhook-Timestamp') ?? '';
  const supplied = req.get('X-Webhook-Signature') ?? '';
  const match = /^sha256=([a-f0-9]{64})$/.exec(supplied);
  if (!match || !/^\d{10,13}$/.test(timestamp)) return res.sendStatus(401);
  const seconds = Number(timestamp.length === 13 ? Number(timestamp) / 1000 : timestamp);
  if (Math.abs(Date.now() / 1000 - seconds) > 300) return res.sendStatus(401);
  const expected = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(timestamp).update('.').update(raw).digest();
  const actual = Buffer.from(match[1], 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.sendStatus(401);
  const eventId = req.get('X-Webhook-Event-ID');
  // Persist eventId with a unique constraint/transaction. Return 2xx for an already-processed ID.
  const payload = JSON.parse(raw.toString('utf8'));
  void payload;
  return res.sendStatus(204);
});
```

### PHP

```php
<?php
$raw = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_WEBHOOK_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] ?? '';
if (!preg_match('/^\d{10,13}$/', $timestamp) || abs(time() - (int)($timestamp > 9999999999 ? $timestamp / 1000 : $timestamp)) > 300) {
    http_response_code(401); exit;
}
$expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $raw, getenv('WEBHOOK_SECRET'));
if (!hash_equals($expected, $signature)) { http_response_code(401); exit; }
$eventId = $_SERVER['HTTP_X_WEBHOOK_EVENT_ID'] ?? '';
// Insert eventId into a table with a UNIQUE constraint; a duplicate is acknowledged without reprocessing.
$payload = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
http_response_code(204);
```

### Python

```python
import hashlib, hmac, os, time
from flask import Flask, request, abort

app = Flask(__name__)
@app.post('/api/attendance')
def attendance():
    raw = request.get_data(cache=False)  # exact bytes, before JSON parsing
    timestamp = request.headers.get('X-Webhook-Timestamp', '')
    signature = request.headers.get('X-Webhook-Signature', '')
    if not timestamp.isdigit(): abort(401)
    stamp = int(timestamp) / (1000 if len(timestamp) == 13 else 1)
    if abs(time.time() - stamp) > 300: abort(401)
    expected = 'sha256=' + hmac.new(os.environ['WEBHOOK_SECRET'].encode(), timestamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature): abort(401)
    event_id = request.headers.get('X-Webhook-Event-ID')
    # Persist event_id with a uniqueness constraint and acknowledge duplicates without reprocessing.
    payload = request.get_json(force=True)
    return ('', 204)
```

Store the event ID with a database uniqueness constraint or equivalent transaction. Acknowledge an already-seen ID with 2xx and do not run business logic twice. A timestamp tolerance limits replay exposure but does not replace event-ID deduplication.

## Delivery, retries and responses

Requests time out after 10 seconds by default. `2xx` marks delivery complete. Network failures, `408`, `429`, and `5xx` are retried; other `4xx` responses are permanent failures and are not retried. Retry intervals after the initial attempt are 1 minute, 5 minutes, 15 minutes, and 1 hour; after five total attempts a job becomes `dead_letter`. Use `WEBHOOK_MAX_ATTEMPTS`, `WEBHOOK_RETRY_DELAYS_MS`, `WEBHOOK_TIMEOUT_MS`, `WEBHOOK_WORKER_CONCURRENCY`, `WEBHOOK_MAX_PAYLOAD_BYTES`, `WEBHOOK_MAX_RESPONSE_BYTES`, `WEBHOOK_MAX_PER_MINUTE`, and `WEBHOOK_FAILURE_THRESHOLD` to tune worker limits. Defaults are bounded (5 attempts, 10 seconds, concurrency 10, 64 KiB body, and 8 KiB response).

Jobs are transactionally claimed with a lease, so overlapping scheduler invocations cannot claim the same live job. Expired processing leases are recoverable. Delivery is at-least-once: the receiver must deduplicate by `X-Webhook-Event-ID`. A webhook disabled before claim is not sent; a request already in flight may finish. Repeated failures mark the endpoint `degraded` for admin attention and do not automatically disable it.

The admin dashboard/API shows safe delivery status, attempt count, response status/time, and timestamps. Response bodies, authorization headers, API keys, and webhook secrets are not stored in delivery history or logs. External client API keys cannot inspect delivery history or manage endpoints.

## Local development

Run `npm run webhook:test-server` (or `node --experimental-strip-types backend/scripts/test-webhook-server.ts`) to start the local receiver on `127.0.0.1`. It can be configured with `WEBHOOK_TEST_PORT`, `WEBHOOK_TEST_STATUS`, and `WEBHOOK_TEST_DELAY_MS`; the signature header is masked in output. Use development mode to allow localhost only for local testing. Do not expose this server to the network.

## Firestore and deployment

Collections: `webhook_endpoints`, `webhook_deliveries`, and `webhook_rate_limits`. The deployment indexes in `firestore.indexes.json` cover due jobs, expired leases, and admin history queries; rate-limit counters use TTL. Enable Firestore, Cloud Functions, Cloud Scheduler, and Secret Manager APIs. Deploy indexes before enabling the scheduled worker. The VM's TCP port 8001 and protocol listener remain independent of Functions.

The Phase 3 parser is still unverified in this workspace. No live device event or production Firestore end-to-end delivery has been validated. Production must not treat parser output as eligible until the verified parser is actually connected to the attendance creation path.
