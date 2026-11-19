/**
 * Grant admin rights to an existing account. Runs on YOUR computer; free, no Blaze plan needed.
 *
 *   cd scripts && npm install
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json node set-admin.js you@example.com
 *
 * Get the key: Firebase console > Project settings > Service accounts > Generate new private key.
 * Keep that key file private: never upload it, share it, or commit it to git.
 */
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const email = process.argv[2];
if (!email) {
  console.error("Usage: GOOGLE_APPLICATION_CREDENTIALS=key.json node set-admin.js <email>");
  process.exit(1);
}

initializeApp();

(async () => {
  const user = await getAuth().getUserByEmail(email);
  await getAuth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), admin: true });
  // Hide the admin from Discover and protect them from being banned.
  const ref = getFirestore().collection("users").doc(user.uid);
  if ((await ref.get()).exists) await ref.update({ hidden: true });
  console.log(`${email} is now an admin. Sign out and back in for it to take effect.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
