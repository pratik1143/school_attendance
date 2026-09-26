# Phase 8 School Management

## Scope and protocol boundary

This phase adds a school administration layer over the existing Firebase and verified-attendance pipeline. It does not alter the T800 parser, invent device events, or migrate old records. Only verified attendance documents explicitly associated with a school are eligible for school reports. Map each existing device to exactly one school before expecting its new verified attendance to appear in school analytics; old attendance records are left unchanged.

## Setup

1. Deploy `firestore.rules` and `firestore.indexes.json` with Firebase CLI after reviewing the target project.
2. Create a school profile, academic session, classes, sections and teachers in the School Management UI.
3. Assign the device to its school in Settings. The device must already be tenant-authorized; assignment does not send a command or change TCP behavior.
4. Set Firebase Auth custom claims on existing accounts through the authenticated School Users operation: `role`, `schoolId`, and, for teachers, `teacherId`. Claims take effect after the user refreshes their ID token. Super-admin accounts are provisioned out of band with `role: super_admin`.
5. Attach students to the active academic session, class and section. A `student_device_links` record is created when a school-owned device and its device user ID are provided.
6. Configure the attendance policy and calendar. Dates use the school's IANA timezone. Applicable days exclude configured non-working days, holidays, and future dates.

## Collections

The school layer uses `schools`, `academic_sessions`, `classes`, `sections`, `teachers`, `class_teacher_assignments`, `school_users`, `attendance_policies`, `school_holidays`, and `attendance_adjustments`, with school IDs on every record. Student and attendance documents retain their existing root collections and are augmented only for newly written, verified events when the device has an explicit school mapping. All student/admission/device links are scoped to a school or device.

## Roles and privacy

`super_admin` can administer multiple schools; `school_admin` manages one school; `principal` reads school reports and profiles; `teacher` access is limited to assigned sections; `operator` has attendance/device operations. Firestore client writes are denied for protected operational data; privileged mutations use authenticated server endpoints. Do not put service-account keys in the frontend. Do not store biometric templates.

## Attendance interpretation

Reports count the first verified punch per student per local school day. Late status is derived from configured start time and grace minutes. Manual changes are stored separately in `attendance_adjustments` with actor and reason, preserving raw device events. Future-dated attendance is excluded. Historical data without school/session metadata is not silently backfilled; use a separately reviewed migration if needed.

## Limitations

The currently observed T800 protocol remains unverified for enrollment or command support. This phase adds no enrollment parser, remote device command, attendance write API, or fake device traffic. CSV exports are server-generated and formula escaped. CSV import and hands-on Firebase emulator/deployment validation must be completed only where specifically exposed by the UI and environment.
