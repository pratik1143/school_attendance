# Remote device management

## Protocol gate and current support

The T800 parser remains `unknown`; there are no physical packet captures establishing a device identity handshake, command codes, request/response format, or correlation ID. Therefore **no remote T800 command is supported**. The controls in Devices are disabled with “Not supported by current verified device protocol.” The server-side command builder and response parser return `{ supported: false }` and produce no bytes. There are no invented protocol fixtures.

The command type allowlist is prepared for `device.info`, `device.status`, `device.sync`, user read/write/disable/delete, attendance read, restart, and time get/set. `VERIFIED_DEVICE_COMMANDS` is empty and every capability defaults to false. A capability stored in Firestore cannot alone enable a command: the code's verified command registry must also be updated after evidence review.

## Current request behavior

Only a Firebase-authenticated administrator or explicitly claimed device operator can access `/api/v1/admin/devices/{deviceId}/commands` and `/logs`. Device-specific operations additionally require `clientId` and `tenantId` custom claims matching the active API client and device ownership. Public school API keys have no command route. The command request accepts an allowlisted `commandType` plus optional explicit confirmation; arbitrary payloads, raw hex, and binary commands are rejected.

Because all commands are unverified, an authenticated, correctly scoped request is recorded in `device_commands` with status `unsupported`, explanatory error, protocol `unknown`, and a five-minute expiry. It is audited in `device_command_audit_logs`. No command is put into an active send queue, no VM-to-TCP bridge is invoked, and no device bytes are sent. This is deliberate. The queue/lock/claim helpers are only groundwork; implementing a live worker is blocked on verified protocol support.

`device_commands` and the audit log do not contain command payloads, request bytes, response bytes, or secrets. Safe diagnostic log views expose timestamp, direction, packet size, parser status, and connection ID only; raw packet bytes are not returned by the admin logs endpoint. The Device detail page includes Overview, Connection, Firmware, Capabilities, Commands, Users, Attendance, and Logs sections. It does not poll continually; Firestore listeners provide current device/user/attendance view data while admin command/log history is loaded on entering the detail view.

## Firestore model

`device_commands` includes command ID, device/client, allowlisted type, state, create/expiry timestamps, admin ID, protocol, safe error/result fields, and connection/correlation placeholders. Supported state values are defined in `backend/src/deviceCommands/model.ts`; at present only `unsupported` is generated. `device_command_audit_logs` records the command ID, device, admin, type, action, status, and a safe result string. Required composite indexes are included in `firestore.indexes.json`.

## Enabling a future verified command

For each proposed command, keep before/after raw captures restricted and record the device model/firmware, exact action and UTC time, connection ID, sequence, request bytes, response bytes, timeout behavior, and repeatability. Verify the device identity binding and response correlation. Add only captured request/response fixtures under `tests/fixtures/t800/`, tests for valid and malformed responses, explicit capability mapping, and a protocol implementation. Review destructive-command confirmation, retry/idempotency behavior, lock lease and expiration before enabling it. Never accept bytes from the browser. `device.restart`, user disable/delete and time changes must be explicitly confirmed and must never be automatically retried without verified idempotency.

Offline commands must not be sent on a stale connection. A future worker must atomically claim one command per device, check expiry and current device-to-client ownership at send time, correlate only with protocol-defined connection/sequence/request identity, and transition to completed/failed/timeout with an audit entry. Until that worker and command protocol exist, the API only records unsupported requests.

No `device.command.completed`, `device.command.failed`, or `device.status.changed` webhook events are implemented. Remote enrollment and automatic time changes remain unsupported. Firebase Cloud Tasks or another task service can be evaluated after a verified command worker is designed; no Cloud Task or command transport is deployed in this phase.

See [`T800-PROTOCOL.md`](T800-PROTOCOL.md) for the evidence inventory and [`DEVICE-ENROLLMENT.md`](DEVICE-ENROLLMENT.md) for the manual enrollment limitation.
