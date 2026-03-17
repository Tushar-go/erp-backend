require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { db, messaging } = require('./src/config/firebase.js');
const PollingService = require('./src/services/pollingService.js');
const userRoutes = require('./src/routes/userRoutes.js');

const app = express();
const PORT = process.env.PORT || 3000;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MIDDLEWARE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROUTES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.use('/api/users', userRoutes);

// Health check endpoint
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

// Root endpoint
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TEST NOTIFICATION ENDPOINT (for manual testing)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/test-notification', async (req, res) => {
  try {
    const { user_id, type = 'task', title, body } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing user_id',
      });
    }

    // Get user from database
    const userDoc = await db.collection('users').doc(user_id).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const userData = userDoc.data();
    
    if (!userData.fcm_token) {
      return res.status(400).json({
        success: false,
        message: 'User has no FCM token',
      });
    }

    // Send test notification
    const message = {
      token: userData.fcm_token,
      notification: {
        title: title || `Test ${type.toUpperCase()} Notification`,
        body: body || `This is a test ${type} notification sent at ${new Date().toLocaleTimeString()}`,
      },
      data: {
        type: type,
        test: 'true',
        timestamp: new Date().toISOString(),
      },
      android: {
        priority: 'high',
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    const response = await messaging.send(message);
    
    console.log(`✅ Test notification sent to ${user_id}`);
    console.log('FCM Response:', response);

    return res.json({
      success: true,
      message: 'Test notification sent successfully',
      fcm_response: response,
      sent_to: userData.username,
    });

  } catch (error) {
    console.error('❌ Test notification error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send test notification',
      error: error.message,
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// INITIALIZE POLLING SERVICE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const pollingService = new PollingService(db, messaging);

// Start polling if enabled
if (process.env.ENABLE_POLLING !== 'false') {
  pollingService.start();
} else {
  console.log('⚠️ Polling service disabled (ENABLE_POLLING=false)');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 SIGTERM received, shutting down gracefully...');
  pollingService.stop();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('📴 SIGINT received, shutting down gracefully...');
  pollingService.stop();
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// START SERVER
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log('🚀 Task & Lead Notification Backend');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase: Connected`);
  console.log(`⏰ Polling: ${pollingService.isRunning ? 'Running' : 'Stopped'}`);
  console.log(`⏱️  Interval: ${process.env.POLLING_INTERVAL || 60000}ms`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`📱 Local Network URLs:`);
  console.log(`   http://192.168.1.15:${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════════════════');
});