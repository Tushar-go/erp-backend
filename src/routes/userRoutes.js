const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const thirdPartyService = require('../services/thirdPartyService');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📝 REGISTER USER
// Validates credentials against CRM AUTH endpoint before saving.
// Returns 401 with the CRM's exact error message if auth fails
// so the app can display "Invalid UserID." / "Invalid User PW."
// directly to the user.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/register', async (req, res) => {
  try {
    const { api_credentials, fcm_token, platform, crm_user_id } = req.body;

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 Registration request received');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (!api_credentials || !fcm_token) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: api_credentials and fcm_token',
      });
    }

    const { api_key, web_url, username, password } = api_credentials;

    if (!web_url || !username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Incomplete API credentials: web_url, username and password are required',
      });
    }

    // ── VALIDATE CREDENTIALS AGAINST CRM ──────────────────────
    console.log(`🔐 Validating credentials for ${username}...`);
    const authResult = await thirdPartyService.validateCredentials(api_credentials);

    if (!authResult.valid) {
      console.log(`❌ Auth failed for ${username}: ${authResult.message}`);
      return res.status(401).json({
        success: false,
        // CRM message passed through directly:
        // "Invalid UserID." or "Invalid User PW."
        message: authResult.message,
      });
    }

    console.log(`✅ Credentials valid for ${username}`);
    // ──────────────────────────────────────────────────────────

    const userId = `${web_url}_${username}`.replace(/[^a-zA-Z0-9]/g, '_');
    console.log(`📝 Registering user: ${username} (${userId})`);

    const plainCredentials = {
      api_key: api_key || '',
      web_url,
      username,
      password,
    };

    const userDoc = await db.collection('users').doc(userId).get();

    const userData = {
      username,
      web_url,
      fcm_token,
      platform: platform || 'unknown',
      api_credentials: plainCredentials,
      updated_at: new Date().toISOString(),
    };

    if (crm_user_id) {
      userData.crm_user_id = crm_user_id.toString();
      console.log(`📋 CRM User ID: ${crm_user_id}`);
    }

    if (userDoc.exists) {
      // Update existing user — preserve all polling state fields
      await db.collection('users').doc(userId).update(userData);
      console.log(`✅ User ${username} updated`);
      return res.json({
        success: true,
        message: 'User updated successfully',
        user_id: userId,
        is_new: false,
      });
    }

    // New user — initialise ALL fields the polling service expects.
    // Missing fields cause first-run guards to misbehave.
    await db.collection('users').doc(userId).set({
      ...userData,
      created_at: new Date().toISOString(),
      last_checked: null,
      // Assigned task tracking
      task_data: {},
      last_task_count: 0,
      delayed_task_ids: [],
      deadline_warnings_sent: {},
      // Created task tracking (accepted / completed / delayed → to creator)
      created_task_data: {},
      created_delayed_task_ids: [],
      // Lead tracking
      known_lead_ids: [],
      last_lead_count: 0,
      follow_up_reminders_sent: {},
    });

    console.log(`✅ New user ${username} registered`);
    return res.json({
      success: true,
      message: 'User registered successfully',
      user_id: userId,
      is_new: true,
    });
  } catch (error) {
    console.error('❌ Registration error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔄 UPDATE FCM TOKEN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/update-token', async (req, res) => {
  try {
    const { user_id, fcm_token } = req.body;

    if (!user_id || !fcm_token) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: user_id and fcm_token',
      });
    }

    const userDoc = await db.collection('users').doc(user_id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await db.collection('users').doc(user_id).update({
      fcm_token,
      updated_at: new Date().toISOString(),
    });

    console.log(`✅ FCM token updated for ${user_id}`);
    return res.json({ success: true, message: 'FCM token updated successfully' });
  } catch (error) {
    console.error('❌ Token update error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🗑️ LOGOUT (soft delete — clears FCM token only)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/logout', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: user_id',
      });
    }

    const userDoc = await db.collection('users').doc(user_id).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await db.collection('users').doc(user_id).update({
      fcm_token: null,
      logged_out_at: new Date().toISOString(),
    });

    console.log(`✅ User ${user_id} logged out`);
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('❌ Logout error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 GET USER STATUS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/status/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const userDoc = await db.collection('users').doc(user_id).get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const d = userDoc.data();
    return res.json({
      success: true,
      user: {
        user_id,
        username: d.username,
        web_url: d.web_url,
        platform: d.platform,
        has_fcm_token: !!d.fcm_token,
        last_task_count: d.last_task_count,
        last_lead_count: d.last_lead_count,
        last_checked: d.last_checked,
        created_at: d.created_at,
        updated_at: d.updated_at,
      },
    });
  } catch (error) {
    console.error('❌ Status check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

module.exports = router;