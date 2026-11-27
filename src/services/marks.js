import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { watchCollection } from './common.js';
import { writeTenant } from './teachers.js';

/** Manual day marks (present / late / absent / leave) that override what the device saw. */
export const watchMarks = (onData, onError) => watchCollection('attendance_marks', 'date', onData, onError);

export const markId = (kind, personId, date) => `${kind}_${personId}_${date}`;

export async function setMark({ kind, personId, date, status, note = '' }) {
  if (!db || !auth?.currentUser) throw new Error('Sign in first.');
  const ref = doc(db, 'attendance_marks', markId(kind, personId, date));
  if (status === 'auto') { await deleteDoc(ref); return; }
  await setDoc(ref, {
    kind, personId: String(personId), date, status, note: String(note).slice(0, 200),
    markedBy: auth.currentUser.email || auth.currentUser.uid, tenantId: await writeTenant(), updatedAt: serverTimestamp(),
  });
}
