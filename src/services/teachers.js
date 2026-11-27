import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';
import { readCollection, watchCollection } from './common.js';

export const listTeachers = () => readCollection('teachers', 'name');
export const watchTeachers = (onData, onError) => watchCollection('teachers', 'name', onData, onError);

/** Tenant that new records are stamped with (kept so the public API can see them later). */
export async function writeTenant() {
  const { claims } = await auth.currentUser.getIdTokenResult();
  return claims.tenantId || claims.schoolId || import.meta.env.VITE_DEFAULT_TENANT_ID || 'school-main';
}

/** Next free TCH001-style id. */
export function nextTeacherId(teachers) {
  const used = teachers.map((t) => /^TCH(\d+)$/.exec(String(t.teacherId || t.id))).filter(Boolean).map((m) => Number(m[1]));
  return `TCH${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`;
}

export async function saveTeacher(form, existingId) {
  if (!db || !auth?.currentUser) throw new Error('Sign in first.');
  const teacherId = String(form.teacherId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(teacherId)) throw new Error('Teacher ID may use letters, numbers, - and _ only.');
  const name = String(form.name || '').trim();
  if (!name) throw new Error('Name is required.');
  const deviceUserId = String(form.deviceUserId || '').trim();
  if (deviceUserId && !/^[0-9]{1,32}$/.test(deviceUserId)) throw new Error('Device user ID must be the number shown on the device.');
  const email = String(form.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Email address is invalid.');
  const data = {
    teacherId, name: name.slice(0, 120), subject: String(form.subject || '').trim().slice(0, 80),
    phone: String(form.phone || '').trim().slice(0, 30), email, deviceUserId,
    status: form.status === 'inactive' ? 'inactive' : 'active',
    tenantId: await writeTenant(), updatedAt: serverTimestamp(),
    ...(existingId ? {} : { createdAt: serverTimestamp() }),
  };
  await setDoc(doc(db, 'teachers', existingId || teacherId), data, { merge: true });
  return teacherId;
}

export const deleteTeacher = (docId) => deleteDoc(doc(db, 'teachers', docId));
