const { decryptCredentials } = require('../utils/encryption.js');

class UserService {
  
  // Fetch current user details from CRM API
  async fetchCurrentUserDetails(encryptedCredentials) {
    try {
      const credentials = decryptCredentials(encryptedCredentials);
      
      // ✅ ASSUMING YOUR API HAS A "CURRENT USER" OR "USER INFO" ENDPOINT
      // Adjust this URL based on your actual API
      const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}&USERINFO&UID=${credentials.username}&UPW=${credentials.password}`;
      
      console.log('🔍 Fetching user details from CRM...');
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // ✅ EXTRACT USER ID FROM RESPONSE
      // Adjust based on your API response structure
      const userId = data.UserID || data.user_id || data.ID;
      
      console.log(`✅ Fetched CRM User ID: ${userId}`);
      
      return {
        crm_user_id: userId,
        username: data.Username || credentials.username,
        // Add other fields as needed
      };
      
    } catch (error) {
      console.error('❌ Error fetching user details:', error.message);
      throw error;
    }
  }
}

module.exports = new UserService();