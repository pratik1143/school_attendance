# Phase 3: protocol discovery status

## Current result

The parser remains disabled because there is no real T800 traffic to analyze. The device’s configured destination is `198.38.84.30:8001`, but this workspace has no deployment evidence that the new listener owns that address, and no T800-originated packet capture or Firestore raw-log reference is available. The only observed payload in local testing was the synthetic `TEST_PACKET_PHASE2` sample; it does not establish any T800 protocol behavior.

Per the Phase 3 stop condition, this phase does not guess framing, identify the device from packet contents, label heartbeat traffic, send acknowledgements, or create attendance from received bytes. The exact findings and unknown fields are tracked in [T800-PROTOCOL.md](T800-PROTOCOL.md).

## Capture tooling ready

The passive listener now stores one ordered capture record per Node TCP data-event chunk, retaining the actual chunk boundary, connection ID, sequence number, direction, timestamp, byte count, hex, base64, and printable ASCII. It does not concatenate or split chunks into invented messages. Raw console diagnostics are off by default and can be enabled with `DIAGNOSTIC_MODE=true`. Known text markers such as `password=`, `token:`, and `authorization=` are redacted from diagnostic text and hex output; Firestore raw payloads with these markers are stored redacted and marked `sensitiveRedacted`.

Replay a captured JSON object (or array) containing `rawBase64` fields through the current unknown parser:

```powershell
node --experimental-strip-types backend/scripts/replay-packet.ts .\capture.json
```

The replay harness does not contact Firestore, the device, or send a response. Its result remains unknown until protocol evidence supports implementation.

## Getting real traffic safely

1. Provision the Linux VM with its static external IP and attach a dedicated VM service account with the required Firestore IAM permissions. Use ADC; do not place service-account JSON or private keys in this project.
2. Install Node.js 22.18+, deploy the repository, install root and backend dependencies, and run the backend under a process manager such as `systemd` with `Restart=on-failure`.
3. Configure the VM environment from `backend/.env.example`. Set `FIREBASE_PROJECT_ID`; use the VM service identity. Keep `HEALTH_HOST=127.0.0.1`. For a controlled capture window, set `DIAGNOSTIC_MODE=true`, restrict access to logs, then turn diagnostics off and apply an appropriate raw-log retention policy.
4. Configure the cloud firewall for inbound TCP 8001 to the VM, restricting source ranges where the device network permits. The health port does not need to be public.
5. Verify `/health` locally on the VM and confirm TCP port 8001 is listening. Compare the VM's static IP with the device's currently configured server IP (`198.38.84.30`). If they differ, an authorized operator must update the T800 server IP to the VM static IP and leave its port, Cloud ID, and heartbeat unchanged. No device setting was changed by this implementation.
6. Observe the listener while performing controlled, timestamped device actions, one method at a time. Save the associated `raw_device_logs` document IDs and exact local/UTC times. Do not assume heartbeat interval semantics, supported modalities, or offline backlog behavior.
7. Analyze multiple samples for each action and verify candidate frame boundaries against chunk captures. Update [T800-PROTOCOL.md](T800-PROTOCOL.md) with evidence references. Only after repeatable evidence identifies a frame and event format should a parser and verified ingestion adapter be implemented.

For offline-sync behavior, record the device local attendance log, temporarily disconnect its network under operator supervision, generate one test event, restore connectivity, and observe captures. This test has not been performed; no backlog or batch behavior is claimed.

## Attendance and dashboard behavior

The normalized attendance repository now supports the Phase 3 schema, a transaction-based deterministic event ID, raw-log links, and mapping by a unique `students.deviceUserId`. Missing or ambiguous mappings are retained with `studentId: null` and `mappingStatus: "unmapped"`. The ingestion service rejects `protocol: "unknown"`. No current parser calls this service, so the attendance collection remains untouched by raw/unknown traffic.

The dashboard uses authenticated Firestore snapshots for students, attendance, and devices, so subsequent backend updates appear without a manual reload. Firebase client rules are unchanged. Server Admin writes continue to depend on the VM service account's IAM permissions.

## Test limits

Unit tests cover unknown input, chunk-order preservation, diagnostic redaction, deterministic attendance IDs, and unique/unmapped student mapping decisions. A physical T800 connection, packet format, Firestore write, duplicate transaction, and offline synchronization have not been verified. The local backend environment may still reference the deleted exposed service-account file; configure ADC before enabling Firestore writes. Revoke that exposed key in IAM.
