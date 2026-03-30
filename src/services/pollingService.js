const thirdPartyService = require('./thirdPartyService');
const NotificationService = require('./notificationService');

// TaskStatusID reference:
// 0 = Pending For Acceptance
// 1 = In-Progress (Accepted)
// 2 = Completed (Submitted)

class PollingService {
  constructor(db, messaging) {
    this.db = db;
    this.notificationService = new NotificationService(messaging);
    this.isRunning = false;
    this.intervalId = null;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🚀 START / STOP
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  start() {
    if (this.isRunning) {
      console.log('⚠️ Polling service already running');
      return;
    }
    const interval = parseInt(process.env.POLLING_INTERVAL || 60000);
    console.log(`🚀 Starting polling service — interval: ${interval / 1000}s`);
    this.pollAllUsers();
    this.intervalId = setInterval(() => this.pollAllUsers(), interval);
    this.isRunning = true;
    console.log('✅ Polling service started');
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔄 POLL ALL USERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
      usersSnapshot.forEach(doc => promises.push(this.pollUser(doc.id)));
      await Promise.allSettled(promises);

      console.log('✅ Polling cycle complete');
    } catch (error) {
      console.error('❌ Error polling users:', error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 👤 POLL SINGLE USER
  // Always reads fresh Firestore data — snapshot may be stale
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async pollUser(userId) {
    try {
      const freshDoc = await this.db.collection('users').doc(userId).get();
      const freshData = freshDoc.data();

      const { fcm_token, api_credentials } = freshData;

      if (!api_credentials) {
        console.log(`⚠️ User ${userId} has no API credentials`);
        return;
      }

      if (!fcm_token) {
        console.log(`⚠️ User ${userId} has no FCM token — skipping`);
        return;
      }

      // Fetch ASSIGNEDTASK, CREATEDTASK, ASSIGNEDLEAD in parallel
      const [assignedTasks, createdTasks, leads] = await Promise.all([
        thirdPartyService.fetchAssignedTasks(api_credentials).catch(err => {
          console.error(`❌ fetchAssignedTasks for ${userId}:`, err.message);
          return null;
        }),
        thirdPartyService.fetchCreatedTasks(api_credentials).catch(err => {
          console.error(`❌ fetchCreatedTasks for ${userId}:`, err.message);
          return null;
        }),
        thirdPartyService.fetchAssignedLeads(api_credentials).catch(err => {
          console.error(`❌ fetchAssignedLeads for ${userId}:`, err.message);
          return null;
        }),
      ]);

      // Process each independently — one failing doesn't block others
      if (assignedTasks !== null) {
        await this.processAssignedTaskChanges(userId, freshData, assignedTasks, fcm_token);
      }
      if (createdTasks !== null) {
        await this.processCreatedTaskChanges(userId, freshData, createdTasks, fcm_token);
      }
      if (leads !== null) {
        await this.processLeadChanges(userId, freshData, leads, fcm_token);
      }

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
  // 📋 PROCESS ASSIGNED TASKS (notifications TO the assignee)
  //   • New task assigned
  //   • Deadline warning 1 hour before
  //   • Task delayed (past deadline) — fires once
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processAssignedTaskChanges(userId, userData, currentTasks, fcmToken) {
    try {
      const { username } = userData;
      const prevTaskData = userData.task_data || {};
      const delayedTaskIds = new Set(
        (userData.delayed_task_ids || []).map(id => id.toString())
      );

      // Build current snapshot using statusId
      const currentTaskData = {};
      currentTasks.forEach(task => {
        currentTaskData[task.DocID] = {
          status: task.TaskStatus,
          statusId: task.TaskStatusID,
          deadline: task.TaskDeadline,
        };
      });

      // First run — seed silently, no notifications
      if (Object.keys(prevTaskData).length === 0 && currentTasks.length > 0) {
        console.log(`🌱 Seeding assigned tasks for ${username} (${currentTasks.length}) — no notifications`);
        await this.db.collection('users').doc(userId).update({
          task_data: currentTaskData,
          last_task_count: currentTasks.length,
          delayed_task_ids: [],
        });
        return;
      }

      // ── NEW TASKS ───────────────────────────────────────────────
      const newTasks = currentTasks.filter(task => !prevTaskData[task.DocID]);
      if (newTasks.length > 0) {
        console.log(`🆕 ${newTasks.length} new assigned task(s) for ${username}`);
        const result = await this.notificationService.sendTaskNotification(
          fcmToken, newTasks, newTasks.length
        );
        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
      }

      // ── DEADLINE CHECKS ─────────────────────────────────────────
      for (const task of currentTasks) {
        if (!prevTaskData[task.DocID]) continue; // new task, skip deadline check

        const currentStatusId = task.TaskStatusID;

        // Completed — clean up delayed set
        if (currentStatusId === 2) {
          delayedTaskIds.delete(task.DocID.toString());
          continue;
        }

        const now = this.getISTDate();
        const deadline = this.getISTDate(task.TaskDeadline);

        // Deadline warning — 1 hour before, fires once per task
        const oneHourBefore = new Date(deadline.getTime() - 60 * 60 * 1000);
        if (now >= oneHourBefore && now < deadline) {
          await this.checkDeadlineWarning(userId, task, fcmToken);
        }

        // Delayed — past deadline, not completed, fires once
        if (now > deadline && !delayedTaskIds.has(task.DocID.toString())) {
          console.log(`🚨 Assigned task delayed: ${task.TaskSubject}`);
          const result = await this.notificationService.sendTaskDelayedNotification(
            fcmToken, task, false
          );
          if (result && result.error === 'invalid_token') {
            await this.handleInvalidToken(userId);
            return;
          }
          delayedTaskIds.add(task.DocID.toString());
        }
      }

      await this.db.collection('users').doc(userId).update({
        task_data: currentTaskData,
        last_task_count: currentTasks.length,
        delayed_task_ids: [...delayedTaskIds],
      });

    } catch (error) {
      console.error(`❌ Error processing assigned tasks for ${userId}:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 PROCESS CREATED TASKS (notifications TO the creator)
  //   • Task accepted  — StatusID 0 → 1
  //   • Task completed — any → StatusID 2 (broad: handles delayed edge case)
  //   • Task delayed   — past deadline, StatusID !== 2, fires once
  //
  // Runs on the CREATOR's poll using CREATEDTASK endpoint.
  // Assignee does NOT need to be a registered user.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processCreatedTaskChanges(userId, userData, currentTasks, fcmToken) {
    try {
      const { username } = userData;
      const prevCreatedTaskData = userData.created_task_data || {};
      const createdDelayedTaskIds = new Set(
        (userData.created_delayed_task_ids || []).map(id => id.toString())
      );

      // Build current snapshot using statusId
      const currentCreatedTaskData = {};
      currentTasks.forEach(task => {
        currentCreatedTaskData[task.DocID] = {
          status: task.TaskStatus,
          statusId: task.TaskStatusID,
          deadline: task.TaskDeadline,
        };
      });

      // First run — seed silently, no notifications
      if (Object.keys(prevCreatedTaskData).length === 0 && currentTasks.length > 0) {
        console.log(`🌱 Seeding created tasks for ${username} (${currentTasks.length}) — no notifications`);
        await this.db.collection('users').doc(userId).update({
          created_task_data: currentCreatedTaskData,
          created_delayed_task_ids: [],
        });
        return;
      }

      for (const task of currentTasks) {
        const prevTask = prevCreatedTaskData[task.DocID];

        // Task not seen before — seed it silently, no notification
        if (!prevTask) {
          console.log(`🌱 New created task seeded: ${task.TaskSubject}`);
          continue;
        }

        const prevStatusId = prevTask.statusId;
        const currentStatusId = task.TaskStatusID;

        if (prevStatusId !== currentStatusId) {
          console.log(`🔄 Created task status change: ${prevStatusId} → ${currentStatusId} | ${task.TaskSubject}`);
        }

        // ✅ ACCEPTED — StatusID 0 → 1
        if (prevStatusId === 0 && currentStatusId === 1) {
          console.log(`✅ Task accepted by ${task.AssignToUserNm}: ${task.TaskSubject}`);
          const result = await this.notificationService.sendTaskAcceptedNotification(
            fcmToken, task
          );
          if (result && result.error === 'invalid_token') {
            await this.handleInvalidToken(userId);
            return;
          }
        }

        // ✅ COMPLETED — any → StatusID 2
        // Broad check covers edge case where prevStatusId was stored
        // with a custom value (e.g. from a delayed state mismatch)
        if (currentStatusId === 2 && prevStatusId !== 2) {
          console.log(`✅ Task completed by ${task.AssignToUserNm}: ${task.TaskSubject}`);
          const result = await this.notificationService.sendTaskCompletedNotification(
            fcmToken, task
          );
          if (result && result.error === 'invalid_token') {
            await this.handleInvalidToken(userId);
            return;
          }
          // Clean up delayed tracking since task is now done
          createdDelayedTaskIds.delete(task.DocID.toString());
          continue; // no need to check delayed below
        }

        // ✅ DELAYED — past deadline, not completed, fires once
        if (currentStatusId !== 2) {
          const now = this.getISTDate();
          const deadline = this.getISTDate(task.TaskDeadline);
          if (now > deadline && !createdDelayedTaskIds.has(task.DocID.toString())) {
            console.log(`🚨 Created task delayed: ${task.TaskSubject}`);
            const result = await this.notificationService.sendTaskDelayedNotification(
              fcmToken, task, true // isCreator = true
            );
            if (result && result.error === 'invalid_token') {
              await this.handleInvalidToken(userId);
              return;
            }
            createdDelayedTaskIds.add(task.DocID.toString());
          }
        }
      }

      await this.db.collection('users').doc(userId).update({
        created_task_data: currentCreatedTaskData,
        created_delayed_task_ids: [...createdDelayedTaskIds],
      });

    } catch (error) {
      console.error(`❌ Error processing created tasks for ${userId}:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ⏰ DEADLINE WARNING — fires once per task per assignee
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async checkDeadlineWarning(userId, task, fcmToken) {
    try {
      const userDoc = await this.db.collection('users').doc(userId).get();
      const userData = userDoc.data();
      const warningsSent = userData.deadline_warnings_sent || {};

      if (!warningsSent[task.DocID]) {
        console.log(`⏰ Deadline warning: ${task.TaskSubject}`);
        const result = await this.notificationService.sendDeadlineWarningNotification(
          fcmToken, task
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🎯 PROCESS LEAD CHANGES
  //   • New lead allotment (DocID-based)
  //   • Follow-up reminders (LeadFollowUpDt == today IST, once per day)
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

      // Normalise stored IDs to numbers (Firestore int64 safety)
      const prevLeadIdSet = new Set(
        prevKnownIds.map(id =>
          typeof id === 'object' ? id.toNumber?.() ?? Number(id.low) : Number(id)
        )
      );

      // First run — seed silently, no notification
      if (prevKnownIds.length === 0 && currentLeads.length > 0) {
        console.log(`🌱 Seeding leads for ${username} (${currentLeads.length}) — no notifications`);
        await this.db.collection('users').doc(userId).update({
          known_lead_ids: currentLeadIds,
        });
        return;
      }

      // ── NEW LEADS ──────────────────────────────────────────────
      const newLeads = currentLeads.filter(
        lead => !prevLeadIdSet.has(Number(lead.DocID))
      );

      if (newLeads.length > 0) {
        console.log(`🆕 ${newLeads.length} new lead(s) for ${username}: ${newLeads.map(l => l.DocID)}`);
        const result = await this.notificationService.sendLeadNotification(
          fcmToken, newLeads, newLeads.length
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
        if (this.getISTDateString(lead.LeadFollowUpDt) !== todayIST) continue;
        if (updatedReminderLog[lead.DocID] === todayIST) continue;

        console.log(`🔔 Follow-up due today: ${lead.LeadName} (DocID: ${lead.DocID})`);
        const result = await this.notificationService.sendLeadFollowUpNotification(
          fcmToken, lead
        );
        if (result && result.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
        updatedReminderLog[lead.DocID] = todayIST;
        reminderFired = true;
      }

      // Single atomic write
      const updatePayload = { known_lead_ids: currentLeadIds };
      if (reminderFired) updatePayload.follow_up_reminders_sent = updatedReminderLog;
      await this.db.collection('users').doc(userId).update(updatePayload);

    } catch (error) {
      console.error(`❌ Error processing leads for ${userId}:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🗑️ HANDLE INVALID FCM TOKEN
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async handleInvalidToken(userId) {
    try {
      console.log(`🗑️ Removing invalid FCM token for ${userId}`);
      await this.db.collection('users').doc(userId).update({
        fcm_token: null,
        token_invalidated_at: new Date().toISOString(),
      });
      console.log(`✅ Invalid token removed for ${userId}`);
    } catch (error) {
      console.error(`❌ Error handling invalid token for ${userId}:`, error);
    }
  }
}

module.exports = PollingService;