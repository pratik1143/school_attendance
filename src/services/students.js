import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase.js';
import { readCollection, watchCollection, queryForSchool } from './common.js';
export async function listStudents() {
  return readCollection('students', 'name');
}
export function watchStudents(onData, onError) {
  return watchCollection('students', 'name', onData, onError);
}
export async function saveStudent(student) {
  throw new Error('Student updates must use the authenticated school management API.');
}
export async function getStudent(id) { if (!db) throw new Error('Firebase is not configured.'); const snap = await getDoc(doc(db, 'students', id)); return snap.exists() ? { ...snap.data(), id: snap.id } : null; }
export async function studentAttendance(id) {
  if (!db) throw new Error('Firebase is not configured.');
  const snap = await getDocs(await queryForSchool(collection(db, 'attendance'), [where('studentId', '==', id)], 'timestamp'));
  return snap.docs.map((d) => ({ ...d.data(), id: d.id })).filter((row) => row.studentId === id);
}
