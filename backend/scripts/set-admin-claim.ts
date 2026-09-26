import { getAdminAuth } from '../src/firestore/admin.ts';

const uid = process.env.ADMIN_UID?.trim();
const email = process.env.ADMIN_EMAIL?.trim();
if (Boolean(uid) === Boolean(email)) throw new Error('Set exactly one of ADMIN_UID or ADMIN_EMAIL.');
const auth = getAdminAuth();
const user = uid ? await auth.getUser(uid) : await auth.getUserByEmail(email!);
await auth.setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
console.info(`Administrator claim enabled for Firebase user ${user.uid}.`);
