import { readCollection, watchCollection } from './common.js';
export async function listAttendance() { return readCollection('attendance', 'timestamp'); }
export function watchAttendance(onData, onError) { return watchCollection('attendance', 'timestamp', onData, onError); }
