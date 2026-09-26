import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import path from 'node:path';
import { env } from '../config/env.ts';
import { logger } from '../utils/logger.ts';

let firestore: ReturnType<typeof getFirestore> | null = null;
let unavailableReason = '';

function resolveCredential() {
  const configuredPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const knownWorkspaceKeys = [path.resolve(process.cwd(), 'service-account.json'), path.resolve(process.cwd(), 'backend/service-account.json')];
  if (configuredPath && knownWorkspaceKeys.includes(path.resolve(process.cwd(), configuredPath))) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS points to a workspace service-account file. Revoke exposed keys and configure fresh Application Default Credentials.');
  }
  return applicationDefault();
}

if (env.firestoreWritesEnabled) {
  try {
    const app = getApps()[0] ?? initializeApp({
      credential: resolveCredential(),
      ...(env.projectId ? { projectId: env.projectId } : {}),
    });
    firestore = getFirestore(app);
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : 'Firebase Admin initialization failed.';
    logger.error('Firestore initialization failed; TCP raw capture will continue without persistence.', { error: unavailableReason });
  }
} else {
  unavailableReason = 'Firestore writes are disabled by FIRESTORE_WRITES_ENABLED.';
  logger.warn(unavailableReason);
}

export function getDb(): ReturnType<typeof getFirestore> {
  if (!firestore) throw new Error(unavailableReason || 'Firestore is unavailable. Configure Google Application Default Credentials.');
  return firestore;
}
export function isFirestoreReady(): boolean { return firestore !== null; }
export function getAdminAuth() {
  const app = getApps()[0];
  if (!app) throw new Error('Firebase Admin is unavailable.');
  return getAuth(app);
}
