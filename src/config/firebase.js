const admin = require('firebase-admin');

// Initialize Firebase Admin SDK

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();
const messaging = admin.messaging();

console.log('✅ Firebase Admin SDK initialized');

module.exports = { admin, db, messaging };