const fetch = require('node-fetch');

class ThirdPartyService {

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔍 VALIDATE CREDENTIAL FIELDS (structural check only)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  isValidCredentials(credentials) {
    return (
      credentials &&
      typeof credentials === 'object' &&
      typeof credentials.web_url  === 'string' && credentials.web_url.trim()  !== '' &&
      typeof credentials.username === 'string' && credentials.username.trim() !== '' &&
      typeof credentials.password === 'string' && credentials.password.trim() !== ''
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔐 VALIDATE CREDENTIALS AGAINST CRM (AUTH endpoint)
  //
  // URL pattern:  /URLApi/api/UDApi?APIKEY={api_key}AUTH&UID=...&UPW=...
  // Request body: {} (empty)
  //
  // CRM responses:
  //   Bad UID  → 200  { Status: "Error", Message: "Invalid UserID." }
  //   Bad PWD  → 200  { Status: "Error", Message: "Invalid User PW." }
  //   Success  → 200  [{ UserName: "API", AdminUser: 1 }]
  //
  // Returns { valid: true, username } or { valid: false, message }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async validateCredentials(credentials) {
    try {
      if (!this.isValidCredentials(credentials)) {
        return { valid: false, message: 'Missing required credential fields.' };
      }

      const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}AUTH&UID=${credentials.username}&UPW=${credentials.password}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        timeout: 15000,
      });

      // 4xx / 5xx — CRM itself is unreachable or misconfigured web_url
      if (!response.ok) {
        return {
          valid: false,
          message: `CRM server returned ${response.status}. Please check your web URL.`,
        };
      }

      const data = await response.json();

      // { Status: "Error", Message: "Invalid UserID." | "Invalid User PW." }
      if (data && data.Status === 'Error') {
        return { valid: false, message: data.Message };
      }

      // Success: [{ UserName, AdminUser }]
      if (Array.isArray(data) && data.length > 0) {
        return { valid: true, username: data[0].UserName };
      }

      return { valid: false, message: 'Unexpected response from CRM during auth.' };
    } catch (error) {
      console.error('❌ validateCredentials error:', error.message);
      return {
        valid: false,
        message: 'Could not reach CRM server. Check your web URL.',
      };
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📊 FETCH ASSIGNED TASKS (tasks assigned TO this user)
  // Used for: new task alerts, deadline warnings, delayed notifications
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async fetchAssignedTasks(credentials) {
    try {
      if (!this.isValidCredentials(credentials)) {
        console.warn('⚠️ fetchAssignedTasks — invalid credentials');
        return null;
      }
      const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}ASSIGNEDTASK&UID=${credentials.username}&UPW=${credentials.password}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompleteDaysLimit: '1' }),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data && data.Status === 'Error') {
        console.warn(`⚠️ fetchAssignedTasks — CRM error: ${data.Message}`);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('❌ Error fetching assigned tasks:', error.message);
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 FETCH CREATED TASKS (tasks created BY this user)
  // Used for: acceptance, completion, delayed notifications to creator
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async fetchCreatedTasks(credentials) {
    try {
      if (!this.isValidCredentials(credentials)) {
        console.warn('⚠️ fetchCreatedTasks — invalid credentials');
        return null;
      }
      const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}CREATEDTASK&UID=${credentials.username}&UPW=${credentials.password}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompleteDaysLimit: '1' }),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data && data.Status === 'Error') {
        console.warn(`⚠️ fetchCreatedTasks — CRM error: ${data.Message}`);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('❌ Error fetching created tasks:', error.message);
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🎯 FETCH ASSIGNED LEADS
  // Used for: new lead allotment, follow-up reminders
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async fetchAssignedLeads(credentials) {
    try {
      if (!this.isValidCredentials(credentials)) {
        console.warn('⚠️ fetchAssignedLeads — invalid credentials');
        return null;
      }
      const url = `https://${credentials.web_url}/URLApi/api/UDApi?APIKEY=${credentials.api_key}ASSIGNEDLEAD&UID=${credentials.username}&UPW=${credentials.password}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CompleteDaysLimit: '1' }),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = await response.json();
      if (data && data.Status === 'Error') {
        console.warn(`⚠️ fetchAssignedLeads — CRM error: ${data.Message}`);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('❌ Error fetching assigned leads:', error.message);
      throw error;
    }
  }
}

module.exports = new ThirdPartyService();