const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { encryptCredentials } = require('../utils/encryption');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📝 REGISTER USER WITH FCM TOKEN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.post('/register', async (req, res) => {
  try {
    const { api_credentials, fcm_token, platform, crm_user_id } = req.body; // ✅ Add crm_user_id
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📥 Received registration request');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    if (!api_credentials || !fcm_token) {
      console.log('❌ Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: api_credentials and fcm_token',
      });
    }
    
    const { api_key, web_url, username, password } = api_credentials;
    
    if (!web_url || !username || !password) {
      console.log('❌ Incomplete API credentials');
      return res.status(400).json({
        success: false,
        message: 'Incomplete API credentials',
      });
    }
    
    // Create unique user ID
    const userId = `${web_url}_${username}`.replace(/[^a-zA-Z0-9]/g, '_');
    console.log(`📝 Registering user: ${username} (${userId})`);
    
    // Encrypt credentials
    const encryptedCredentials = encryptCredentials({
      api_key: api_key || '',
      web_url,
      username,
      password,
    });
    
    // Check if user exists
    const userDoc = await db.collection('users').doc(userId).get();
    
    const userData = {
      username,
      web_url,
      fcm_token,
      platform: platform || 'unknown',
      api_credentials: encryptedCredentials,
      updated_at: new Date().toISOString(),
    };
    
    // ✅ ADD CRM USER ID IF PROVIDED
    if (crm_user_id) {
      userData.crm_user_id = crm_user_id.toString();
      console.log(`📋 CRM User ID: ${crm_user_id}`);
    }
    
    if (userDoc.exists) {
      // Update existing user
      await db.collection('users').doc(userId).update(userData);
      
      console.log(`✅ User ${username} updated successfully`);
      
      return res.json({
        success: true,
        message: 'User updated successfully',
        user_id: userId,
        is_new: false,
      });
    }
    
    // Create new user
    await db.collection('users').doc(userId).set({
      ...userData,
      last_task_count: 0,
      last_lead_count: 0,
      task_data: {},
      deadline_warnings_sent: {},
      created_at: new Date().toISOString(),
      last_checked: null,
    });
    
    console.log(`✅ New user ${username} registered successfully`);
    
    return res.json({
      success: true,
      message: 'User registered successfully',
      user_id: userId,
      is_new: true,
    });
    
  } catch (error) {
    console.error('❌ Registration error:', error);
    console.error('Error stack:', error.stack);
    
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
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    await db.collection('users').doc(user_id).update({
      fcm_token,
      updated_at: new Date().toISOString(),
    });

    console.log(`✅ FCM token updated for user ${user_id}`);

    return res.json({
      success: true,
      message: 'FCM token updated successfully',
    });

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
// 🗑️ DELETE USER / LOGOUT
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
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Remove FCM token (soft delete - keep user data)
    await db.collection('users').doc(user_id).update({
      fcm_token: null,
      logged_out_at: new Date().toISOString(),
    });

    console.log(`✅ User ${user_id} logged out successfully`);

    return res.json({
      success: true,
      message: 'Logged out successfully',
    });

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
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const userData = userDoc.data();

    return res.json({
      success: true,
      user: {
        user_id,
        username: userData.username,
        web_url: userData.web_url,
        platform: userData.platform,
        has_fcm_token: !!userData.fcm_token,
        last_task_count: userData.last_task_count,
        last_lead_count: userData.last_lead_count,
        last_checked: userData.last_checked,
        created_at: userData.created_at,
        updated_at: userData.updated_at,
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔍 DEBUG: LIST ALL USERS (TEMPORARY - REMOVE IN PRODUCTION)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
router.get('/debug/list-all', async (req, res) => {
  try {
    const usersSnapshot = await db.collection('users').get();
    
    const users = [];
    usersSnapshot.forEach(doc => {
      const data = doc.data();
      users.push({
        firebase_id: doc.id,
        username: data.username,
        web_url: data.web_url,
        crm_user_id: data.crm_user_id || 'NOT SET',
        has_fcm_token: !!data.fcm_token,
        created_at: data.created_at,
      });
    });
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 ALL REGISTERED USERS:');
    users.forEach((user, index) => {
      console.log(`\n${index + 1}. Firebase ID: ${user.firebase_id}`);
      console.log(`   Username: ${user.username}`);
      console.log(`   Web URL: ${user.web_url}`);
      console.log(`   CRM User ID: ${user.crm_user_id}`);
      console.log(`   Has FCM Token: ${user.has_fcm_token}`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    return res.json({
      success: true,
      total_users: users.length,
      users: users,
    });
  } catch (error) {
    console.error('❌ Error listing users:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});




module.exports = router;