import { collection, getDocs, query, orderBy, onSnapshot, or, where, limit } from 'firebase/firestore';
import { auth, db } from '../lib/firebase.js';

async function queryForSchool(base, extra = [], sortField = '') {
  if (!auth?.currentUser) throw new Error('Sign in to access school data.');
  const { claims } = await auth.currentUser.getIdTokenResult();
  const superAdmin = claims.role === 'super_admin' || claims.roles?.includes?.('super_admin');
  const schoolId = claims.schoolId || claims.tenantId; const tenantId = claims.tenantId || claims.schoolId;
  if (superAdmin) return query(base, ...extra, ...(sortField ? [orderBy(sortField, 'desc')] : []), limit(500));
  if (!schoolId && !tenantId) throw new Error('A school-scoped role is required to read school records.');
  const scope = schoolId && tenantId && schoolId !== tenantId ? or(where('schoolId', '==', schoolId), where('tenantId', '==', tenantId)) : where(schoolId ? 'schoolId' : 'tenantId', '==', schoolId || tenantId);
  return query(base, scope, ...extra, ...(sortField ? [orderBy(sortField, 'desc')] : []), limit(500));
}

export async function readCollection(name, sortField) {
  if (!db) throw new Error('Firebase is not configured. Add your VITE_FIREBASE_* values to .env.local.');
  const base = collection(db, name);
  const snapshot = await getDocs(await queryForSchool(base, [], sortField));
  return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
}
export function watchCollection(name, sortField, onData, onError) {
  if (!db) {
    onError(new Error('Firebase is not configured. Add your VITE_FIREBASE_* values to .env.local.'));
    return () => {};
  }
  let unsubscribe = () => {}; let cancelled = false;
  void queryForSchool(collection(db, name), [], sortField).then((target) => { if (!cancelled) unsubscribe = onSnapshot(target, (snapshot) => onData(snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }))), onError); }).catch(onError);
  return () => { cancelled = true; unsubscribe(); };
}
export { queryForSchool };
export function asDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function formatTime(value) { const d = asDate(value); return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'; }
export function formatDate(value) { const d = asDate(value); return d ? d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—'; }
