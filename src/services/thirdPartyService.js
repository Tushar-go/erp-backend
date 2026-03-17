const fetch = require('node-fetch');
const { decryptCredentials } = require('../utils/encryption');

class ThirdPartyService {
  
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📊 FETCH ASSIGNED TASKS FROM THIRD-PARTY API
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async fetchAssignedTasks(encryptedCredentials) {
  try {
    const credentials = decryptCredentials(encryptedCredentials);
    
    const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}ASSIGNEDTASK&UID=${credentials.username}&UPW=${credentials.password}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        CompleteDaysLimit: "1"  
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data || [];
    
  } catch (error) {
    console.error('❌ Error fetching assigned tasks:', error.message);
    throw error;
  }
}

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🎯 FETCH ASSIGNED LEADS FROM THIRD-PARTY API
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async fetchAssignedLeads(encryptedCredentials) {
  try {
    const credentials = decryptCredentials(encryptedCredentials);
    
    const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}ASSIGNEDLEAD&UID=${credentials.username}&UPW=${credentials.password}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        CompleteDaysLimit: "1"  
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    return data || [];
    
  } catch (error) {
    console.error('❌ Error fetching assigned leads:', error.message);
    throw error;
  }
}
}

module.exports = new ThirdPartyService();