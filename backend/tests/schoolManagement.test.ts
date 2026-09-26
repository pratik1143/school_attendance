import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceSummary, csvCell, lateThresholdStatus, normalizeRole, resolveSchoolScope, roleCan, safeSchoolId, validateCsvRows, validateStudentInput, workingDaysBetween, zonedMidnightUtc } from '../src/schoolManagement/model.ts';

test('school roles derive only from signed token claims and permissions stay role-specific', () => {
  assert.equal(normalizeRole({ role: 'teacher' }), 'teacher');
  assert.equal(normalizeRole({ admin: true }), 'school_admin');
  assert.equal(normalizeRole({ role: 'student' }), null);
  assert.equal(roleCan('teacher', 'reports:read'), true);
  assert.equal(roleCan('teacher', 'students:manage'), false);
  assert.equal(roleCan('principal', 'school:manage'), false);
  assert.equal(roleCan('super_admin', 'platform:anything'), true);
});

test('authenticated school scope cannot be replaced by a caller supplied schoolId', () => {
  const identity = { uid: 'u1', role: 'school_admin' as const, schoolId: 'school-a', teacherId: null };
  assert.equal(resolveSchoolScope(identity, 'school-b'), 'school-a');
  assert.equal(resolveSchoolScope({ ...identity, role: 'super_admin', schoolId: null }, 'school-b'), 'school-b');
  assert.throws(() => resolveSchoolScope({ ...identity, schoolId: null }, 'school-b'));
  assert.equal(safeSchoolId('../other'), false);
});

test('student validation permits optional family and device fields but validates identifiers and dates', () => {
  assert.equal(validateStudentInput({ studentId: 'STU1001', name: 'Asha' }).valid, true);
  assert.equal(validateStudentInput({ studentId: 'STU1001', name: 'Asha', dateOfBirth: '2026-02-30' }).valid, false);
  assert.equal(validateStudentInput({ studentId: '../x', name: 'Asha' }).valid, false);
});

test('daily attendance counts first valid day classifications once and uses present percentage', () => {
  assert.deepEqual(attendanceSummary(4, ['present', 'late', 'absent']), { totalStudents: 4, present: 1, absent: 1, late: 1, excused: 0, unknown: 0, notMarked: 1, attendancePercentage: 25 });
});

test('working-day calculator excludes configured holidays and future dates', () => {
  const days = workingDaysBetween('2026-09-28', '2026-10-04', [1, 2, 3, 4, 5], new Set(['2026-10-02']), 'Asia/Kolkata', '2026-10-04');
  assert.deepEqual(days, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
});

test('school date boundaries honor Asia/Kolkata and late classification uses policy time', () => {
  assert.equal(zonedMidnightUtc('2026-09-27', 'Asia/Kolkata').toISOString(), '2026-09-26T18:30:00.000Z');
  assert.equal(lateThresholdStatus(new Date('2026-09-27T03:16:00Z'), '2026-09-27', '08:30', 15, 'Asia/Kolkata'), 'late');
  assert.equal(lateThresholdStatus(new Date('2026-09-27T03:15:00Z'), '2026-09-27', '08:30', 15, 'Asia/Kolkata'), 'present');
});

test('CSV import flags duplicate/invalid rows and export escapes formula cells', () => {
  const rows = validateCsvRows([{ studentId: 'A1', name: 'Asha' }, { studentId: 'A1', name: 'Duplicate' }, { studentId: '', name: 'No ID' }]);
  assert.deepEqual(rows.map((r) => r.status), ['valid', 'duplicate', 'invalid']);
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
});
