# T800 protocol findings

**Status: UNKNOWN. No T800 wire protocol has been identified.** No protocol parser or response behavior is enabled.

## Device information

- Model: T800
- Firmware: `ALDS37_NYTTM8WT16EN v103`
- Face engine: Face Pro Ver 107
- Palm: Palm Pro Ver 111
- Fingerprint: FP Pro Ver 221
- Configured Cloud ID: `02010A964EDF2575`
- Serial: `202607220022`
- Device-side server configuration supplied by the operator: `198.38.84.30:8001`
- Configured heartbeat value: 20 (meaning and wire behavior UNKNOWN)

## Evidence inventory

- Confirmed T800-originated packet captures in this workspace: **none**.
- Synthetic local test data: the Phase 2 TCP client sent the literal `TEST_PACKET_PHASE2` (18 bytes). This confirms only that the local listener accepts TCP data; it is not evidence of T800 protocol behavior and was run with Firestore writes disabled.
- Listener deployment at `198.38.84.30` and a connection from the physical device: **not verified**.
- Capture file / Firestore raw-log IDs from the physical T800: **none available**.

## Connection and transport

- TCP listener implementation: CONFIRMED in code, configurable port defaults to 8001.
- Physical T800 connection behavior: UNKNOWN.
- Remote address and application identity on the wire: UNKNOWN. `T800_01` is currently an operator-configured association, not a wire-verified identity.
- TCP data-event chunks are preserved with sequence and timestamp. Their boundaries are not asserted to be application frames.

## Frame structure

| Field | Finding |
| --- | --- |
| Header / magic bytes | UNKNOWN |
| Length field | UNKNOWN |
| Command / message type | UNKNOWN |
| Device identifier in payload | UNKNOWN |
| Payload encoding | UNKNOWN |
| Checksum / integrity field | UNKNOWN |
| Authentication / handshake | UNKNOWN |
| Heartbeat frame or interval on wire | UNKNOWN |
| Attendance frame | UNKNOWN |
| User ID, timestamp, verification method | UNKNOWN |
| Server acknowledgement / response | UNKNOWN; listener remains passive |
| Offline attendance transfer, ordering, and batches | UNKNOWN |
| Device-user enrollment packet / user list sync | UNKNOWN; no physical enrollment capture is available |
| User ID / name / privilege / enabled state on wire | UNKNOWN |
| Fingerprint / face / palm / card enrollment metadata on wire | UNKNOWN |
| Offline user enrollment sync after reconnect | UNKNOWN; not tested |

## Device user enrollment gate

`backend/src/tcp/deviceUserParser.ts` intentionally returns `unknown` for all frames until a repeatable, real T800 enrollment frame is captured and decoded. The admin UI currently offers a manual workflow to record a user after on-device enrollment. It must not be described as automatic T800 synchronization. See [`DEVICE-ENROLLMENT.md`](DEVICE-ENROLLMENT.md).

## Remote command gate

No T800 command request/response has been captured. `unknownProtocolAdapter.buildCommand()` and `parseCommandResponse()` report `{ supported: false }` and never create packet bytes. Every remote capability is disabled, and admin requests are recorded as `unsupported` only. No command worker or VM-to-device send path is active. See [`REMOTE-DEVICE-MANAGEMENT.md`](REMOTE-DEVICE-MANAGEMENT.md).

## Evidence references

There are no real device `raw_device_logs` or capture artifacts to cite yet. Once collected, record raw log document IDs, device action, local and UTC action time, connection ID, direction, sequence, and byte length here. Keep raw captures access-controlled because they may contain personal or authentication data.

## Parser gate

The protocol detector and parser always return `unknown`. The adapter returns no heartbeat, attendance, or response. Unknown input cannot call attendance ingestion. Do not mark a protocol, frame, field, heartbeat, acknowledgement, or offline-sync behavior as confirmed until a repeatable real-device capture supports it.
