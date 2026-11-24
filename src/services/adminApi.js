import { auth } from '../lib/firebase.js';

const apiBase = (import.meta.env.VITE_PUBLIC_API_BASE_URL || 'http://localhost:8081').replace(/\/$/, '');

/** Calls an admin-only backend route with the signed-in user's ID token. */
export async function adminRequest(path, method = 'GET', body) {
  const user = auth?.currentUser;
  if (!user) throw new Error('Sign in first.');
  const token = await user.getIdToken();
  let response;
  try {
    response = await fetch(`${apiBase}/api/v1/admin${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error('Backend is not reachable. Make sure the backend server is running.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || `Request failed (${response.status})`);
  return result.data;
}

export const saveStudentRecord = (student) => adminRequest('/students', 'POST', student);
export const deleteStudentRecord = (studentId) => adminRequest(`/students/${encodeURIComponent(studentId)}`, 'DELETE');
export const deleteAttendanceRecords = (ids) => adminRequest('/attendance', 'DELETE', { ids });
