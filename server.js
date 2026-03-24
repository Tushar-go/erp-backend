require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { db, messaging } = require('./src/config/firebase.js');
const PollingService = require('./src/services/pollingService.js');
const userRoutes = require('./src/routes/userRoutes.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 1. MIDDLEWARE ──────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ── 2. POLLING SERVICE (before routes that reference it) ───
const pollingService = new PollingService(db, messaging);

// ── 3. ROUTES ──────────────────────────────────────────────
app.use('/api/users', userRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'Task-Lead Notification Backend',
    version: '1.0.0',
    firebase: 'Connected',
    polling: pollingService.isRunning ? 'Running' : 'Stopped',
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Task & Lead Notification Backend',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      register: 'POST /api/users/register',
      updateToken: 'POST /api/users/update-token',
      logout: 'POST /api/users/logout',
      status: 'GET /api/users/status/:user_id',
    },
  });
});

app.post('/api/test-notification', async (req, res) => {
  try {
    const { user_id, type = 'task', title, body } = req.body;
    if (!user_id) return res.status(400).json({ success: false, message: 'Missing user_id' });

    const userDoc = await db.collection('users').doc(user_id).get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: 'User not found' });

    const userData = userDoc.data();
    if (!userData.fcm_token) return res.status(400).json({ success: false, message: 'User has no FCM token' });

    const message = {
      token: userData.fcm_token,
      notification: { title: title || `Test ${type.toUpperCase()} Notification`, body: body || `Test ${type} notification at ${new Date().toLocaleTimeString()}` },
      data: { type, test: 'true', timestamp: new Date().toISOString() },
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    };

    const response = await messaging.send(message);
    console.log(`✅ Test notification sent to ${user_id}`, response);
    return res.json({ success: true, message: 'Test notification sent', fcm_response: response, sent_to: userData.username });
  } catch (error) {
    console.error('❌ Test notification error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send', error: error.message });
  }
});

// 404 handler
app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({ success: false, message: 'Internal server error', error: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// ── 4. START POLLING ───────────────────────────────────────
if (process.env.ENABLE_POLLING !== 'false') {
  pollingService.start();
} else {
  console.log('⚠️ Polling disabled');
}

// ── 5. START SERVER ────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT} | ENV: ${process.env.NODE_ENV}`);
  console.log(`⏰ Polling: ${pollingService.isRunning ? 'Running' : 'Stopped'}`);
});

// ── 6. GRACEFUL SHUTDOWN ───────────────────────────────────
const shutdown = (signal) => {
  console.log(`📴 ${signal} received, shutting down...`);
  pollingService.stop();
  server.close(() => { console.log('✅ Server closed'); process.exit(0); });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));