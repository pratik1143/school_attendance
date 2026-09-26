import test from 'node:test';
import assert from 'node:assert/strict';
import { autoStudentDocId, deviceUserDocId, enrollmentMetadata, resolveDeviceUserStudentMatch, studentDeviceLinkId } from '../src/deviceEnrollment/model.ts';

const input = (overrides = {}) => ({ deviceId: 'T800_01', tenantId: 'school-a', deviceUserId: '1002', links: [], students: [], knownDeviceUsers: [], ...overrides });

test('new device-user identity has deterministic device-scoped key', () => assert.equal(deviceUserDocId('T800_01', '1002'), deviceUserDocId('T800_01', '1002')));
test('existing device-user identity remains stable when name changes', () => assert.equal(deviceUserDocId('T800_01', '1002'), deviceUserDocId('T800_01', '1002')));
test('duplicate sync for one device user resolves to one document key', () => assert.equal(deviceUserDocId('T800_01', '1002'), deviceUserDocId('T800_01', '1002')));
test('renamed user does not create a second identity', () => assert.equal(autoStudentDocId('T800_01', '1002'), autoStudentDocId('T800_01', '1002')));
test('unmapped device user does not match by name', () => assert.deepEqual(resolveDeviceUserStudentMatch(input()), { studentId: null, match: 'none' }));
test('exact device and user link takes priority', () => assert.deepEqual(resolveDeviceUserStudentMatch(input({ links: [{ deviceId: 'T800_01', deviceUserId: '1002', studentId: 'STU1002' }] })), { studentId: 'STU1002', match: 'exact' }));
test('existing student can be safely matched by exact device identity', () => assert.deepEqual(resolveDeviceUserStudentMatch(input({ students: [{ studentId: 'STU1002', deviceUserId: '1002', deviceId: 'T800_01', tenantId: 'school-a' }] })), { studentId: 'STU1002', match: 'exact' }));
test('multi-device mapping keeps the same user ID separate', () => assert.notEqual(deviceUserDocId('T800_01', '1002'), deviceUserDocId('T800_02', '1002')));
test('student device link identity is unique per device and device user', () => assert.notEqual(studentDeviceLinkId('T800_01', '1002'), studentDeviceLinkId('T800_02', '1002')));
test('same identity uses one stable student-device link on repeated delivery', () => assert.equal(studentDeviceLinkId('T800_01', '1002'), studentDeviceLinkId('T800_01', '1002')));
test('legacy unique device-user match is allowed only within its tenant and without collisions', () => assert.deepEqual(resolveDeviceUserStudentMatch(input({ students: [{ studentId: 'STU1002', deviceUserId: '1002', tenantId: 'school-a' }] })), { studentId: 'STU1002', match: 'unique' }));
test('ambiguous legacy ID across devices stays unlinked', () => assert.deepEqual(resolveDeviceUserStudentMatch(input({ students: [{ studentId: 'STU1002', deviceUserId: '1002', tenantId: 'school-a' }], knownDeviceUsers: [{ deviceId: 'T800_01', deviceUserId: '1002' }, { deviceId: 'T800_02', deviceUserId: '1002' }] })), { studentId: null, match: 'ambiguous' }));
test('biometric metadata accepts only explicit booleans', () => assert.deepEqual(enrollmentMetadata({ fingerprintEnrolled: true, faceEnrolled: false, palmEnrolled: 'yes', cardEnrolled: null }), { fingerprintEnrolled: true, faceEnrolled: false, palmEnrolled: null, cardEnrolled: null, passwordEnrolled: null }));
test('raw biometric templates are discarded by the metadata allowlist', () => assert.deepEqual(enrollmentMetadata({ fingerprintTemplate: 'raw-template', faceTemplate: 'raw-face', palmTemplate: 'raw-palm' }), { fingerprintEnrolled: null, faceEnrolled: null, palmEnrolled: null, cardEnrolled: null, passwordEnrolled: null }));
test('device-scoped generated onboarding student ID is deterministic', () => assert.equal(autoStudentDocId('T800_01', '1002'), autoStudentDocId('T800_01', '1002')));
