const fetch = require('node-fetch');

class ThirdPartyService {

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔍 VALIDATE CREDENTIALS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  isValidCredentials(credentials) {
    return (
      credentials &&
      typeof credentials === 'object' &&
      typeof credentials.web_url === 'string' && credentials.web_url.trim() !== '' &&
      typeof credentials.username === 'string' && credentials.username.trim() !== '' &&
      typeof credentials.password === 'string' && credentials.password.trim() !== ''
    );
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
      return Array.isArray(data) ? data : [];

    } catch (error) {
      console.error('❌ Error fetching assigned tasks:', error.message);
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 FETCH CREATED TASKS (tasks created BY this user)
  // Used for: acceptance, completion, delayed notifications to creator
  // Assignee does NOT need to be a registered user
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
      return Array.isArray(data) ? data : [];

    } catch (error) {
      console.error('❌ Error fetching assigned leads:', error.message);
      throw error;
    }
  }
}

module.exports = new ThirdPartyService();