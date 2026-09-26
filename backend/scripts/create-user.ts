import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const saPath = path.resolve(currentDir, '../service-account.json');

if (!fs.existsSync(saPath)) {
  console.error(`Service account key not found at: ${saPath}`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));

const app = getApps()[0] ?? initializeApp({
  credential: cert(serviceAccount),
  projectId: serviceAccount.project_id
});

const auth = getAuth(app);

const email = process.argv[2] || 'admin@school.edu';
const password = process.argv[3] || 'Admin@123456';
const displayName = process.argv[4] || 'School Administrator';

async function main() {
  try {
    let user;
    try {
      user = await auth.getUserByEmail(email);
      console.log(`User ${email} already exists (UID: ${user.uid}). Updating password...`);
      await auth.updateUser(user.uid, {
        password,
        displayName
      });
      console.log(`Successfully updated password for ${email}.`);
    } catch (err: any) {
      if (err.code === 'auth/user-not-found') {
        user = await auth.createUser({
          email,
          password,
          displayName,
          emailVerified: true
        });
        console.log(`Successfully created new admin user: ${email} (UID: ${user.uid})`);
      } else {
        throw err;
      }
    }
    console.log('\n--- Login Credentials ---');
    console.log(`Email:    ${email}`);
    console.log(`Password: ${password}`);
    console.log('-------------------------\n');
  } catch (err) {
    console.error('Error creating/updating user:', err);
    process.exit(1);
  }
}

main();
