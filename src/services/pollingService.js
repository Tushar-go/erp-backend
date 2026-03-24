const cron = require('node-cron');
const thirdPartyService = require('./thirdPartyService');
const NotificationService = require('./notificationService');

class PollingService {
  constructor(db, messaging) {
    this.db = db;
    this.notificationService = new NotificationService(messaging);
    this.isRunning = false;
    this.intervalId = null;
  }

  start() {
    if (this.isRunning) {
      console.log('⚠️ Polling service already running');
      return;
    }

    const interval = parseInt(process.env.POLLING_INTERVAL || 60000);
    console.log(`🚀 Starting polling service - interval: ${interval}ms (${interval / 1000}s)`);

    this.pollAllUsers();
    this.intervalId = setInterval(() => {
      this.pollAllUsers();
    }, interval);

    this.isRunning = true;
    console.log('✅ Polling service started successfully');
  }

  stop() {
    if (!this.isRunning) {
      console.log('⚠️ Polling service not running');
      return;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.isRunning = false;
    console.log('⏹️ Polling service stopped');
  }

  async pollAllUsers() {
    try {
      console.log('🔄 Polling all users...');

      const usersSnapshot = await this.db.collection('users').get();

      if (usersSnapshot.empty) {
        console.log('⚠️ No users registered yet');
        return;
      }

      console.log(`👥 Found ${usersSnapshot.size} registered user(s)`);

      const promises = [];
      usersSnapshot.forEach(doc => {
        promises.push(this.pollUser(doc.id, doc.data()));
      });

      await Promise.allSettled(promises);
      console.log('✅ Polling cycle complete');

    } catch (error) {
      console.error('❌ Error polling users:', error);
    }
  }

  async pollUser(userId, userData) {
    try {
      // ✅ Always read fresh data from Firestore — never trust the
      // snapshot from pollAllUsers() which may be stale mid-cycle
      const freshDoc = await this.db.collection('users').doc(userId).get();
      const freshData = freshDoc.data();

      const { fcm_token, api_credentials, username } = freshData;

      if (!fcm_token) {
        console.log(`⚠️ User ${userId} has no FCM token`);
        return;
      }

      if (!api_credentials) {
        console.log(`⚠️ User ${userId} has no API credentials`);
        return;
      }

      const [tasks, leads] = await Promise.all([
        thirdPartyService.fetchAssignedTasks(api_credentials).catch(err => {
          console.error(`❌ Error fetching tasks for ${userId}:`, err.message);
          return [];
        }),
        thirdPartyService.fetchAssignedLeads(api_credentials).catch(err => {
          console.error(`❌ Error fetching leads for ${userId}:`, err.message);
          return [];
        }),
      ]);

      // ✅ Pass freshData, not the stale userData from the snapshot
      await this.processTaskChanges(userId, freshData, tasks, fcm_token);
      await this.processLeadChanges(userId, freshData, leads, fcm_token);

      await this.db.collection('users').doc(userId).update({
        last_checked: new Date().toISOString(),
      });

    } catch (error) {
      console.error(`❌ Error polling user ${userId}:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🛠️ IST DATE HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  getISTDate(date = null) {
    const targetDate = date ? new Date(date) : new Date();
    return new Date(targetDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  }

  getISTDateString(date = null) {
    const d = this.getISTDate(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 PROCESS TASK CHANGES
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processTaskChanges(userId, userData, currentTasks, fcmToken) {
    try {
      const { username } = userData;
      const prevTaskData = userData.task_data || {};

      // ✅ FIXED: Track delayed tasks separately so the notification
      // only fires once per task — not on every poll cycle forever.
      // prevStatus from task_data reflects the API status, not 'Delayed',
      // so without this set the delayed check would re-fire every 60s.
      const delayedTaskIds = new Set(
        (userData.delayed_task_ids || []).map(id => id.toString())
      );

      const currentTaskData = {};
      currentTasks.forEach(task => {
        currentTaskData[task.DocID] = {
          status: task.TaskStatus,
          statusId: task.TaskStatusID,
          deadline: task.TaskDeadline,
        };
      });

      // ── NEW TASKS ───────────────────────────────────────────────
      const newTasks = currentTasks.filter(task => !prevTaskData[task.DocID]);

      if (newTasks.length > 0) {
        console.log(`🆕 ${newTasks.length} new task(s) for ${username}`);

        const result = await this.notificationService.sendTaskNotification(
          fcmToken,
          newTasks,
          newTasks.length
        );

        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
      }

      // ── STATUS CHANGES & DEADLINE CHECKS ───────────────────────
      for (const task of currentTasks) {
        const prevTask = prevTaskData[task.DocID];
        if (!prevTask) continue;

        const prevStatus = prevTask.status;
        const currentStatus = task.TaskStatus;

        if (prevStatus !== currentStatus) {
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(`🔄 Status change: ${task.TaskSubject}`);
          console.log(`   "${prevStatus}" → "${currentStatus}"`);
          console.log(`   Creator: ${task.CreateUserNm}`);
          console.log(`   Assigned: ${task.AssignToUserNm}`);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }

        // Task Accepted: "Pending For Acceptance" → "In-Progress"
        if (prevStatus === 'Pending For Acceptance' && currentStatus === 'In-Progress') {
          console.log(`✅ Task accepted: ${task.TaskSubject}`);
          await this.notifyTaskCreator(task, 'accepted');
        }

        // Task Completed: "In-Progress" → "Completed"
        if (prevStatus === 'In-Progress' && currentStatus === 'Completed') {
          console.log(`✅ Task completed: ${task.TaskSubject}`);
          await this.notifyTaskCreator(task, 'completed');
        }

        // ── DEADLINE CHECKS (time-based, not status-based) ────────
        const now = this.getISTDate();
        const deadline = this.getISTDate(task.TaskDeadline);
        const deadlinePassed = now > deadline;

        if (currentStatus !== 'Completed') {

          // Deadline warning: 1 hour before
          const oneHourBefore = new Date(deadline.getTime() - 60 * 60 * 1000);
          if (now >= oneHourBefore && now < deadline) {
            await this.checkDeadlineWarning(userId, task, fcmToken);
          }

          // ✅ FIXED: Use delayedTaskIds set instead of prevStatus check.
          // Previously used `prevStatus !== 'Delayed'` which never matched
          // because the API never returns 'Delayed' — caused notification
          // to fire on every single poll cycle after deadline passed.
          if (deadlinePassed && !delayedTaskIds.has(task.DocID.toString())) {
            console.log(`🚨 Deadline passed for task: ${task.TaskSubject}`);
            console.log(`   Deadline: ${deadline.toISOString()}`);
            console.log(`   Now: ${now.toISOString()}`);

            const result1 = await this.notificationService.sendTaskDelayedNotification(
              fcmToken,
              task,
              false
            );

            if (result1 && result1.error === 'invalid_token') {
              await this.handleInvalidToken(userId);
              return;
            }

            await this.notifyTaskCreator(task, 'delayed');

            // Mark as delayed so it never fires again for this task
            delayedTaskIds.add(task.DocID.toString());
          }
        } else {
          // Task is now completed — remove from delayed set if it was there
          delayedTaskIds.delete(task.DocID.toString());
        }
      }

      // Single Firestore write with all task state
      await this.db.collection('users').doc(userId).update({
        task_data: currentTaskData,
        last_task_count: currentTasks.length,
        delayed_task_ids: [...delayedTaskIds],
      });

    } catch (error) {
      console.error(`❌ Error processing tasks for ${userId}:`, error);
    }
  }

  async checkDeadlineWarning(userId, task, fcmToken) {
    try {
      const userDoc = await this.db.collection('users').doc(userId).get();
      const userData = userDoc.data();
      const warningsSent = userData.deadline_warnings_sent || {};

      if (!warningsSent[task.DocID]) {
        console.log(`⏰ Deadline warning: ${task.TaskSubject}`);

        const result = await this.notificationService.sendDeadlineWarningNotification(
          fcmToken,
          task
        );

        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }

        warningsSent[task.DocID] = new Date().toISOString();
        await this.db.collection('users').doc(userId).update({
          deadline_warnings_sent: warningsSent,
        });
      }
    } catch (error) {
      console.error(`❌ Error checking deadline warning:`, error);
    }
  }

  async notifyTaskCreator(task, notificationType) {
    try {
      const creatorUsername = task.CreateUserNm;
      console.log(`🔍 Looking for creator: "${creatorUsername}"`);

      const allUsersSnapshot = await this.db.collection('users').get();

      const matchingUsers = [];
      allUsersSnapshot.forEach(doc => {
        const userData = doc.data();
        if (userData.username &&
            userData.username.toLowerCase() === creatorUsername.toLowerCase()) {
          matchingUsers.push({ id: doc.id, data: userData });
        }
      });

      if (matchingUsers.length === 0) {
        console.log(`⚠️ Creator "${creatorUsername}" not registered`);
        return;
      }

      console.log(`✅ Found creator: ${creatorUsername}`);

      for (const user of matchingUsers) {
        if (!user.data.fcm_token) {
          console.log(`⚠️ No FCM token for ${user.data.username}`);
          continue;
        }

        console.log(`📤 Sending ${notificationType} notification to creator`);

        let result;
        switch (notificationType) {
          case 'accepted':
            result = await this.notificationService.sendTaskAcceptedNotification(
              user.data.fcm_token,
              task
            );
            break;

          case 'completed':
            result = await this.notificationService.sendTaskCompletedNotification(
              user.data.fcm_token,
              task
            );
            break;

          case 'delayed':
            result = await this.notificationService.sendTaskDelayedNotification(
              user.data.fcm_token,
              task,
              true
            );
            break;
        }

        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(user.id);
        } else {
          console.log(`✅ Notification sent to ${user.data.username}`);
        }
      }
    } catch (error) {
      console.error(`❌ Error notifying creator:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🎯 PROCESS LEAD CHANGES
  // Handles: new lead allotment (by DocID) + follow-up reminders
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processLeadChanges(userId, userData, currentLeads, fcmToken) {
    try {
      const { username } = userData;

      if (!Array.isArray(currentLeads) || currentLeads.length === 0) {
        console.log(`📊 User ${username}: No leads found`);
        return;
      }

      const currentLeadIds = currentLeads.map(lead => lead.DocID);
      const prevKnownIds = userData.known_lead_ids || [];

      // ── NEW LEAD DETECTION ─────────────────────────────────────
      // Explicit number→number comparison to avoid int64/string coercion bugs
      const prevLeadIdSet = new Set(
        prevKnownIds.map(id =>
          typeof id === 'object' ? id.toNumber?.() ?? Number(id.low) : Number(id)
        )
      );

      const newLeads = currentLeads.filter(
        lead => !prevLeadIdSet.has(Number(lead.DocID))
      );

      if (newLeads.length > 0) {
        console.log(`🆕 ${newLeads.length} new lead(s) for ${username}: ${newLeads.map(l => l.DocID)}`);

        const result = await this.notificationService.sendLeadNotification(
          fcmToken,
          newLeads,
          newLeads.length
        );

        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
      }

      // ── FOLLOW-UP REMINDERS ────────────────────────────────────
      const todayIST = this.getISTDateString();
      const followUpRemindersSent = userData.follow_up_reminders_sent || {};
      const updatedReminderLog = { ...followUpRemindersSent };
      let reminderFired = false;

      for (const lead of currentLeads) {
        if (!lead.LeadFollowUpDt) continue;

        const followUpDateStr = this.getISTDateString(lead.LeadFollowUpDt);
        if (followUpDateStr !== todayIST) continue;
        if (updatedReminderLog[lead.DocID] === todayIST) continue;

        console.log(`🔔 Follow-up due today: ${lead.LeadName} (DocID: ${lead.DocID})`);

        const result = await this.notificationService.sendLeadFollowUpNotification(
          fcmToken,
          lead
        );

        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }

        updatedReminderLog[lead.DocID] = todayIST;
        reminderFired = true;
      }

      // Single atomic write for all lead state
      const updatePayload = {
        known_lead_ids: currentLeadIds,
      };
      if (reminderFired) {
        updatePayload.follow_up_reminders_sent = updatedReminderLog;
      }

      await this.db.collection('users').doc(userId).update(updatePayload);

    } catch (error) {
      console.error(`❌ Error processing leads for ${userId}:`, error);
    }
  }

  async handleInvalidToken(userId) {
    try {
      console.log(`🗑️ Removing invalid FCM token for user ${userId}`);

      await this.db.collection('users').doc(userId).update({
        fcm_token: null,
        token_invalidated_at: new Date().toISOString(),
      });

      console.log(`✅ Invalid token removed for user ${userId}`);
    } catch (error) {
      console.error(`❌ Error handling invalid token for ${userId}:`, error);
    }
  }
}

module.exports = PollingService;