# Phase 2: T800 TCP capture and Firestore foundation

## Architecture

`backend/src/server.ts` starts two listeners: the Node `net` TCP server on configurable port 8001 and the monitoring HTTP server on port 8080, bound to `127.0.0.1` by default. The TCP port is the only listener intended to receive device connections. The HTTP server exposes only `GET /health` and `GET /status` and should remain loopback-only unless a later deployment design adds an authenticated/private health path.

TCP connections are assigned an ephemeral connection ID and tracked with remote IP, start time, last received chunk, and byte counters. The configured T800 is mapped to `T800_01`; remote IP is recorded for inspection, not used as the device identity. Since the application protocol and framing are unknown, each Node `data` event is treated as a raw TCP chunk. TCP chunks are stream delivery units and are not claimed to be complete device messages.

Each chunk is kept as bytes, represented as hex and base64, and written to `raw_device_logs` with `parserStatus: "unknown"`. Raw payload logging to console is off by default. `sync_logs` records connect, raw capture, unknown parser, and disconnect events. The existing `devices/T800_01` document is merged with backend connection state; other fields and existing collections are preserved. `attendanceIngestion.ts` provides deterministic duplicate protection for a future verified normalized event, but the unknown parser cannot produce such an event and does not call that service.

## Firestore collections

- `raw_device_logs`: `deviceId`, `cloudId`, `connectionId`, `remoteIp`, server `receivedAt`, `byteLength`, `rawHex`, `rawBase64`, and `parserStatus`.
- `sync_logs`: server `timestamp`, `deviceId`, `connectionId`, `eventType`, `status`, and `message`.
- `devices/T800_01`: existing device fields plus backend-managed `status`, `lastSeen`, `remoteIp`, `connectionId`, `connectedAt`, and `disconnectedAt`.
- `attendance`: unchanged by this phase. Only the future verified ingestion service can write a normalized attendance event; raw/unknown chunks never call it.

## Credentials and environment

Copy `backend/.env.example` to `backend/.env`. The Firebase project ID is not a credential. The backend uses Firebase Admin SDK and Application Default Credentials (ADC). On a Google Cloud VM, attach a dedicated service account with only the Firestore permissions this backend needs; do not download or commit a service-account key file. For local development, use a separately provisioned, rotated developer identity with `gcloud auth application-default login` and grant it access to the intended project. Do not reuse any private key that has been pasted into a chat or otherwise exposed; revoke it in Google Cloud IAM.

`TCP_PORT`, `HEALTH_PORT`, and `HEALTH_HOST` set listener configuration. `MAX_CONNECTIONS`, `MAX_PACKET_BYTES`, `MAX_PACKETS_PER_SECOND`, and `MAX_BYTES_PER_SECOND` cap connection and inbound data rates. Because message boundaries are not known, the byte limit applies per Node TCP chunk and the rate limit applies per connection over a rolling one-second window. Packets over the configured limits cause that connection to close. `LOG_RAW_PACKETS=true` is for controlled development inspection only; raw packets may contain sensitive data.

## Local testing

Use Node.js 22.18 or newer (Node's built-in TypeScript type stripping is used; source remains `.ts`). From the repository root:

```sh
npm install
npm --prefix backend install
Copy-Item backend/.env.example backend/.env
```

Configure ADC for the intended Firebase project before testing Firestore writes. The Firebase Admin SDK bypasses client Firestore rules; the VM's service-account IAM permissions are the backend security boundary. Never add the Admin SDK credentials to the Vite `.env.local` frontend file.

Terminal 1:

```sh
npm run backend:dev
```

Terminal 2:

```sh
npm --prefix backend run test-client
```

The client sends only the literal `TEST_PACKET_PHASE2`. The listener should report a connection, byte count, and unknown protocol. With valid ADC and Firestore IAM, it creates one raw log and sync records, updates the device connection state, then marks it offline when the test connection closes. It must create no attendance record. The client is development tooling and the test bytes are never attendance.

Inspect local health/status with `Invoke-RestMethod http://127.0.0.1:8080/health` and `Invoke-RestMethod http://127.0.0.1:8080/status`. Unit tests cover unknown-protocol behavior, binary-safe raw conversion, and deterministic attendance IDs. A real Firestore integration check requires rotated credentials/ADC for the intended project; it is not safe to perform with an exposed service-account key.

## Google Cloud VM deployment

1. Create a Linux Compute Engine VM with a reserved static external IP and a dedicated service account attached to the VM. Grant only the required Firestore IAM permissions.
2. Install Node.js 22.18+ and deploy this repository. From the repository root run `npm install`, then `npm --prefix backend install`, and `npm --prefix backend run build`.
3. Create `/etc/school-attendance/backend.env` from the backend environment template, set `FIREBASE_PROJECT_ID`, listener ports, and the device mapping, and restrict file access to the service account/operator. Do not put service-account JSON or private keys there.
4. Run `npm --prefix backend start` under a `systemd` service configured with `WorkingDirectory`, `EnvironmentFile=/etc/school-attendance/backend.env`, `Restart=on-failure`, and `RestartSec=5`. Check `systemctl status` and the VM journal for startup errors.
5. Configure the Google Cloud VPC firewall for **inbound TCP 8001 only** to the VM, restricted to the device's known source range where available. No HTTP health port needs to be exposed; it binds to loopback. Do not change the T800's configured server IP until the VM static IP is provisioned and a separate approved device-change step is ready.

The app does not create VMs, firewall rules, IAM bindings, or change device settings. The health endpoint can be checked over SSH/loopback; a private monitoring design can be added later if needed.

## Protocol status and unknowns

The exact application protocol, message framing, encoding, checksum, heartbeat semantics, and ACK requirements for firmware `ALDS37_NYTTM8WT16EN v103` are unconfirmed. The detector and parser therefore always return `unknown`; they do not interpret HTTP, JSON, text, ADMS, FK, ZKTeco, or binary formats. No ACK is sent. No attendance event is synthesized. Capturing a TCP chunk does not prove that it is one complete protocol packet.

Raw packet documents are retained in Firestore with full payload data. Restrict access and retention appropriately for student/biometric data. Payload bytes are not written to console unless explicitly enabled for controlled development.

## Next step (Phase 3)

Collect a small set of timestamped raw captures from the real device while performing known test actions (boot, idle heartbeat, and one supervised check-in). Compare capture boundaries and byte changes against those actions, identify the framing/protocol from device documentation or evidence, and only then implement and test a parser. Keep unknown chunks out of `attendance` until the parser can verify the event fields and idempotency key.
