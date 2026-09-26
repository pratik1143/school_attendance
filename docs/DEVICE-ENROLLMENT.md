# Device user enrollment sync

## Device user and student are separate

A `device_users` record represents one identity on one machine. Its stable document key is derived from `deviceId + deviceUserId`; the same numeric ID on `T800_01` and `T800_02` is a different identity. A `students` record represents the school roster. `student_device_links` connects one student to one device-scoped ID and permits one student to have different IDs across devices. Existing student fields (`studentId`, `name`, `class`, `section`, `deviceUserId`, `status`) remain in place for older dashboard and API consumers.

The system stores only enrollment flags (`true`, `false`, or `null` when unknown). It discards any template-shaped input and never stores face, fingerprint, or palm templates.

## T800 protocol findings

**Automatic enrollment sync is not available from the evidence currently observed.** The repository contains no physical T800 packet capture. `docs/T800-PROTOCOL.md` records that the current passive adapter identifies frames as unknown. No enrollment action time, before/after capture, or offline/reconnect trace is available.

Therefore these T800 fields have not been confirmed as transmitted: device user ID, name, privilege, enabled/disabled state, fingerprint count/status, face status, palm status, and card number. Offline enrollment synchronization is also unknown. The `parseDeviceUser()` abstraction intentionally returns `unknown`; it does not synthesize an enrollment event. The TCP listener still captures raw chunks and does not move into Functions.

To verify the protocol, capture raw traffic immediately before and after a controlled enrollment, record local and UTC time, connection ID, raw-log IDs and byte sequence, and compare multiple repetitions. Repeat with a device offline during enrollment and online afterward. Keep biometric templates out of captures where possible and restrict access to raw logs. Only add parser fields supported by repeatable captures.

## Current safe workflow

Until a user packet is verified:

1. Enroll the person on the T800.
2. In the signed-in admin dashboard, open **Device Enrollment** and record the device, its exact device user ID, and the name shown on the terminal.
3. The platform upserts one `device_users` record and creates a `pending_profile` student with only the supplied name, device ID, device user ID, and a deterministic generated ID if no safely scoped student match exists. Class, section, roll number and family/contact fields are not invented.
4. Choose **Link** to associate an existing student, or **Profile** to enter the actual student ID, class and section. The completion action replaces the generated student record logically and marks the prior stub `superseded`; it does not delete it.
5. **Ignore** and **Disable** change only the device-user state. They do not delete or disable the school student.

Manual records show biometric flags as unknown and do not claim a device sync timestamp. The dashboard shows pending-profile device users in a realtime alert when Firestore `onSnapshot` access is available. Manual entry does not send any command to the terminal.

## Collections and event logs

- `device_users`: unique device + user identity, name, status, enrollment metadata, source, and optional linked student.
- `student_device_links`: many-to-many-ready per-device association; its deterministic key prevents duplicate links.
- `students`: existing roster documents, plus `registrationSource`, `deviceId`, `deviceUserId`, `deviceEnrollmentStatus`, and `needsStudentProfile` where useful.
- `device_user_sync_logs`: detected/manual-created/updated/linked/ignored/disabled/profile-completed events and raw log reference when available.
- `enrollment_audit_logs`: admin ID and enrollment lifecycle action.

Only the authenticated platform admin endpoints can modify enrollment records. Client API keys have no device-enrollment routes. The Functions/TCP service account can write operational records using Admin SDK; the web browser does not directly write device-user mappings.

Admin endpoints use the Firebase ID token and explicit admin claim:

- `GET /api/v1/admin/device-enrollment`
- `POST /api/v1/admin/device-enrollment/manual`
- `POST /api/v1/admin/device-enrollment/{deviceId}/{deviceUserId}/link`
- `POST /api/v1/admin/device-enrollment/{deviceId}/{deviceUserId}/profile`
- `POST /api/v1/admin/device-enrollment/{deviceId}/{deviceUserId}/status`

These are private platform operations; they are not part of the public school API.

## Matching and updates

Matching prefers an exact `student_device_links` association for this device and user ID, then an exact student device/user pair, then one tenant-scoped legacy device-user match only when the ID is unambiguous across devices. Name is never used for matching. Ambiguous IDs remain unlinked for an admin to resolve. Device enrollment does not overwrite class, section, parent, or other manually maintained school fields.

A future verified device name change may update the device-user name. Updating a linked student's name must be an explicit policy decision; it must not overwrite school-maintained profile fields by default. A device-side disable event must not delete the student.

## Limitations and future work

- No real T800 enrollment or offline-sync packet has been observed or tested.
- Automatic student creation from a real T800 packet is not active; only the manual fallback can currently create the onboarding stub.
- Fingerprint/face/palm/card enrollment flags remain unknown for manual entries.
- No cloud-to-device enrollment commands are implemented. A later phase must first verify the command protocol and acknowledgement behavior from vendor documentation and controlled device traces.
- The attendance ingestion mapping now checks the device-scoped student link before legacy matching, but the existing T800 attendance parser remains unknown.

The current protocol evidence is maintained in [`T800-PROTOCOL.md`](T800-PROTOCOL.md). Firestore composite indexes are declared in [`firestore.indexes.json`](../firestore.indexes.json).
