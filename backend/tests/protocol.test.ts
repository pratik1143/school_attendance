import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocol } from '../src/tcp/protocolDetector.ts';
import { parseProtocol } from '../src/tcp/protocolParser.ts';
import { rawFields } from '../src/tcp/packetLogger.ts';
import { attendanceEventId, resolveStudentMapping } from '../src/firestore/attendanceRepository.ts';
import { TcpStreamBuffer } from '../src/tcp/tcpStreamBuffer.ts';
import { unknownProtocolAdapter } from '../src/tcp/deviceProtocolAdapter.ts';
import { parseDeviceUser } from '../src/tcp/deviceUserParser.ts';
import { redactPrintableSecrets } from '../src/utils/hex.ts';

test('unrecognized bytes remain unknown and are not parsed as attendance', () => {
  const bytes = Buffer.from([0, 0xff, 0x41, 0x42]);
  assert.deepEqual(detectProtocol(bytes), { protocol: 'unknown', confidence: 0 });
  assert.deepEqual(parseProtocol(bytes), { type: 'unknown', parsed: false });
});

test('unrecognized T800 data cannot be treated as a device user enrollment packet', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('TEST_PACKET_PHASE2'), Buffer.from([0, 255, 1, 2])]) {
    assert.deepEqual(parseDeviceUser(bytes), { type: 'unknown', parsed: false, reason: 'no_verified_enrollment_format' });
    assert.deepEqual(unknownProtocolAdapter.parseDeviceUser(bytes), { type: 'unknown', parsed: false, reason: 'no_verified_enrollment_format' });
  }
});

test('raw capture keeps byte-accurate hex and base64 for binary data', () => {
  assert.deepEqual(rawFields(Buffer.from([0, 0xff, 0x41]), 'DEVICE_TO_SERVER', 1), {
    byteLength: 3,
    rawHex: '00ff41',
    rawBase64: 'AP9B',
    printableAscii: '..A',
    direction: 'DEVICE_TO_SERVER',
    sequence: 1,
  });
});

test('TCP stream buffer preserves fragmented and coalesced delivery chunks separately', () => {
  const stream = new TcpStreamBuffer();
  const first = stream.push(Buffer.from([0xaa, 0xbb]), 'DEVICE_TO_SERVER', new Date('2026-09-27T10:00:00Z'));
  const second = stream.push(Buffer.from([0xcc]), 'DEVICE_TO_SERVER', new Date('2026-09-27T10:00:00.010Z'));
  const combined = stream.push(Buffer.from([1, 2, 3, 4]), 'DEVICE_TO_SERVER');
  assert.deepEqual([first.sequence, second.sequence, combined.sequence], [1, 2, 3]);
  assert.equal(stream.chunkCount, 3);
  assert.equal(stream.byteCount, 7);
  assert.equal(first.bytes.toString('hex'), 'aabb');
});

test('heartbeat-like and malformed input stays unknown; adapter never replies', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('TEST_PACKET_PHASE2')]) {
    assert.deepEqual(unknownProtocolAdapter.parseFrame(bytes), { type: 'unknown', parsed: false });
    assert.equal(unknownProtocolAdapter.parseHeartbeat(bytes), null);
    assert.equal(unknownProtocolAdapter.parseAttendance(bytes), null);
    assert.deepEqual(unknownProtocolAdapter.identifyDevice(bytes), { supported: false });
    assert.deepEqual(unknownProtocolAdapter.buildCommand('device.info'), { supported: false });
    assert.deepEqual(unknownProtocolAdapter.parseCommandResponse(bytes), { supported: false });
    assert.equal(unknownProtocolAdapter.createResponse(bytes), null);
  }
});

test('diagnostic ASCII output redacts marked secret text', () => {
  assert.equal(redactPrintableSecrets('password=do-not-log token:123'), 'password=<redacted> token=<redacted>');
});

test('student mapping requires exactly one matching device user ID', () => {
  assert.deepEqual(resolveStudentMapping([{ documentId: 'STU1001', studentId: 'STU1001' }]), { studentId: 'STU1001', mappingStatus: 'mapped' });
  assert.deepEqual(resolveStudentMapping([]), { studentId: null, mappingStatus: 'unmapped' });
  assert.deepEqual(resolveStudentMapping([{ documentId: 'A' }, { documentId: 'B' }]), { studentId: null, mappingStatus: 'unmapped' });
});

test('attendance event identity is deterministic and prefers a verified transaction ID', () => {
  const event = {
    deviceId: 'T800_01', deviceUserId: '1001', timestamp: new Date('2026-09-27T10:00:00Z'),
    method: 'fingerprint', status: 'present', source: 't800', protocol: 'verified-test-protocol', verified: true as const,
    rawLogId: 'raw-1', receivedAt: new Date('2026-09-27T10:00:01Z'), transactionId: 'evt-42',
  };
  assert.equal(attendanceEventId(event), attendanceEventId(event));
  assert.equal(attendanceEventId(event), attendanceEventId({ ...event, timestamp: new Date('2026-09-27T10:05:00Z') }));
});
