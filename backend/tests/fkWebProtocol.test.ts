import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFkResponse, decodeFkJsonBody, parseFkPunch, parseFkRequest, parseFkTime } from '../src/tcp/fkWebProtocol.ts';
import { handleFkRequest } from '../src/services/fkRequestHandler.ts';

// Shape of a real T800 capture (2026-11-24), with a fixed test user.
function sampleRequest(json = '{"fk_bin_data_lib":"FKDataHS105","io_mode":285212681,"io_time":"20261124162704","log_image":null,"user_id":"1003","verify_mode":1073741824}\n'): Buffer {
  const jsonBytes = Buffer.from(json, 'utf8');
  const body = Buffer.concat([Buffer.alloc(4), jsonBytes, Buffer.from([0])]);
  body.writeUInt32LE(jsonBytes.length, 0);
  const head = [
    'POST / HTTP/1.0',
    'User-Agent: Mozilla/4.0',
    'Content-Type: application/octet-stream',
    'request_code: realtime_glog',
    'Content-Type: application/octet-stream',
    `Content-Length: ${body.length}`,
    'trans_id: RTLogSendAction',
    'dev_id: 02010A964EDF2575',
    'blk_no: 0',
    `blk_len: ${body.length}`,
    'HOST: 192.168.29.227:8001',
    '', '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

test('parses a complete FK realtime_glog request into a punch', () => {
  const result = parseFkRequest(sampleRequest());
  assert.ok(result.complete && 'request' in result);
  assert.equal(result.request.requestCode, 'realtime_glog');
  assert.equal(result.request.devId, '02010A964EDF2575');
  const punch = parseFkPunch(result.request, '+05:30');
  assert.ok(punch);
  assert.equal(punch.userId, '1003');
  assert.equal(punch.timestamp.toISOString(), '2026-11-24T10:57:04.000Z');
  assert.equal(punch.verifyMode, 1073741824);
});

test('waits for the rest of a request split across TCP chunks', () => {
  const full = sampleRequest();
  assert.deepEqual(parseFkRequest(full.subarray(0, 100)), { complete: false });
  assert.deepEqual(parseFkRequest(full.subarray(0, full.length - 5)), { complete: false });
  const result = parseFkRequest(full);
  assert.ok(result.complete);
  assert.equal(result.consumed, full.length);
});

test('rejects malformed bodies and times', () => {
  assert.equal(decodeFkJsonBody(Buffer.from([1, 0, 0, 0, 0x7b])), null);
  assert.equal(parseFkTime('2026112416', '+05:30'), null);
  const bad = parseFkRequest(sampleRequest('{"user_id":"","io_time":"20261124162704"}'));
  assert.ok(bad.complete && 'request' in bad);
  assert.equal(parseFkPunch(bad.request, '+05:30'), null);
});

test('response echoes trans_id and response code', () => {
  const text = buildFkResponse('RTLogSendAction', 'OK').toString('latin1');
  assert.match(text, /^HTTP\/1\.0 200 OK\r\n/);
  assert.match(text, /response_code: OK\r\n/);
  assert.match(text, /trans_id: RTLogSendAction\r\n/);
});

test('acknowledges only after the punch is stored', async () => {
  const result = parseFkRequest(sampleRequest());
  assert.ok(result.complete && 'request' in result);
  const context = { connectionId: 'c1', rawLogId: 'raw1', receivedAt: new Date() };
  const stored: unknown[] = [];
  const ok = await handleFkRequest(result.request, context, { ingest: async (event) => { stored.push(event); } });
  assert.match(ok.toString('latin1'), /response_code: OK/);
  assert.equal(stored.length, 1);

  const failed = await handleFkRequest(result.request, context, { ingest: async () => { throw new Error('offline'); } });
  assert.match(failed.toString('latin1'), /response_code: ERROR/);

  const noRaw = await handleFkRequest(result.request, { ...context, rawLogId: null }, { ingest: async () => { throw new Error('must not be called'); } });
  assert.match(noRaw.toString('latin1'), /response_code: ERROR/);
});
