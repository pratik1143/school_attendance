import { readCollection, watchCollection } from './common.js';
export async function listDevices() { return readCollection('devices', 'createdAt'); }
export function watchDevices(onData, onError) { return watchCollection('devices', 'createdAt', onData, onError); }
export async function listDeviceUsers() { return readCollection('device_users', 'updatedAt'); }
export function watchDeviceUsers(onData, onError) { return watchCollection('device_users', 'updatedAt', onData, onError); }
