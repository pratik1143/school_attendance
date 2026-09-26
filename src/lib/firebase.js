import { initializeApp, getApps, deleteApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyDnTY1-vZIgh54y8FgUb5tvYtLYgpsKYZg',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'school-project-717c3.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'school-project-717c3',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'school-project-717c3.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '870007774740',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:870007774740:web:275e5410b27d66bb909101',
};

export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

function initApp() {
  if (!firebaseConfigured) return null;
  const existing = getApps()[0];
  if (existing) {
    if (existing.options && existing.options.apiKey === config.apiKey) {
      return existing;
    }
    try {
      deleteApp(existing);
    } catch {
      // ignore
    }
  }
  return initializeApp(config);
}

const app = initApp();
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const googleProvider = new GoogleAuthProvider();
