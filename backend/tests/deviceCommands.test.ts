import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEVICE_CAPABILITIES, commandCanBeClaimed, commandExpiry, commandRequestStatus, commandResultStatus, commandIsSupported, deviceOwnedByAdmin, isKnownCommandType, validRestartConfirmation } from '../src/deviceCommands/model.ts';

const scope = { clientId: 'client-a', tenantId: 'school-a' };
const device = { clientId: 'client-a', tenantId: 'school-a' };
const client = { status: 'active', tenantId: 'school-a' };

test('only enumerated command types are recognized', () => { assert.equal(isKnownCommandType('device.info'), true); assert.equal(isKnownCommandType('shell.exec'), false); });
test('arbitrary raw command data is not a command type', () => assert.equal(isKnownCommandType({ rawHex: 'AA BB' }), false));
test('all default capabilities remain disabled without real captures', () => assert.equal(Object.values(ALL_DEVICE_CAPABILITIES).every((enabled) => enabled === false), true));
test('Firestore capability values cannot enable a command absent verified protocol support', () => assert.equal(commandIsSupported('device.info', { deviceInfo: true }), false));
test('unverified commands are unsupported whether the device is online or offline', () => { assert.equal(commandRequestStatus('device.info', {}, true), 'unsupported'); assert.equal(commandRequestStatus('device.restart', { deviceRestart: true }, false), 'unsupported'); });
test('restart requires exact device-specific confirmation', () => { assert.equal(validRestartConfirmation('Main Gate T800', 'Restart Main Gate T800?'), true); assert.equal(validRestartConfirmation('Main Gate T800', 'restart'), false); });
test('tenant-scoped admin ownership requires matching client and tenant', () => assert.equal(deviceOwnedByAdmin(scope, device, client), true));
test('another client device is denied', () => assert.equal(deviceOwnedByAdmin(scope, { ...device, clientId: 'client-b' }, client), false));
test('another tenant device is denied', () => assert.equal(deviceOwnedByAdmin(scope, { ...device, tenantId: 'school-b' }, client), false));
test('disabled client is denied even when identifiers match', () => assert.equal(deviceOwnedByAdmin(scope, device, { ...client, status: 'disabled' }), false));
test('global admin without client and tenant scope cannot manage device commands', () => assert.equal(deviceOwnedByAdmin({ clientId: null, tenantId: null }, device, client), false));
test('command expiry is bounded and defaults to five minutes', () => assert.equal(commandExpiry(10_000), 310_000));
test('expired queued command cannot be claimed', () => assert.equal(commandCanBeClaimed('queued', 99, 100, true, null), false));
test('offline queued command cannot be claimed', () => assert.equal(commandCanBeClaimed('queued', 200, 100, false, null), false));
test('per-device lock prevents a concurrent queued command claim', () => assert.equal(commandCanBeClaimed('queued', 200, 100, true, 150), false));
test('completed or failed command cannot be claimed again', () => { assert.equal(commandCanBeClaimed('completed', 200, 100, true, null), false); assert.equal(commandCanBeClaimed('failed', 200, 100, true, null), false); });
test('verified valid response completes and malformed response fails', () => { assert.equal(commandResultStatus({ supported: true, online: true, expired: false, responseValid: true }), 'completed'); assert.equal(commandResultStatus({ supported: true, online: true, expired: false, responseValid: false }), 'failed'); });
test('unsupported, offline, and expired outcomes never become completed', () => { assert.equal(commandResultStatus({ supported: false, online: true, expired: false, responseValid: true }), 'unsupported'); assert.equal(commandResultStatus({ supported: true, online: false, expired: false, responseValid: true }), 'failed'); assert.equal(commandResultStatus({ supported: true, online: true, expired: true, responseValid: false }), 'timeout'); });
