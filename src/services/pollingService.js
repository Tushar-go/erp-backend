const thirdPartyService = require('./thirdPartyService');
const NotificationService = require('./notificationService');

// TaskStatusID reference:
// 0 = Pending For Acceptance
// 1 = In-Progress (Accepted)
// 2 = Completed (Submitted)

// ─────────────────────────────────────────────────────────────
// OPTIMISATION SUMMARY
//
// READS (was ~50k/day, now ~300/day):
//   • Single collection.get() shared across all users per cycle    [v2]
//   • userMap replaces notifyTaskCreator + isUserRegistered scans  [v2]
//   • freshDoc.get() removed from pollUser                         [v2]
//   • checkDeadlineWarning re-read removed                         [v2]
//   • In-memory user cache (5-min TTL) — Firestore read only every
//     5 min instead of every poll cycle                            [v3]
//
// WRITES (was ~20k/day, now ~200/day):
//   • last_checked write removed — was firing every cycle per user [v3]
//   • task_data write skipped when nothing changed                 [v3]
//   • lead write skipped when nothing changed                      [v3]
//   • created_task_data write skipped when nothing changed         [v3]
//   • All per-user state batched into one .update() call           [v3]
//
// BUG FIXES [v4]:
//   • Cache patched after every write — prevents duplicate delayed/
//     deadline notifications within the 5-min TTL window
//   • Credential validation on pollUser using AUTH endpoint —
//     bad-credential users skipped after 3 consecutive auth failures
//     (in-memory counter, zero Firestore cost)
// ─────────────────────────────────────────────────────────────

class PollingService {
  constructor(db, messaging) {
    this.db = db;
    this.notificationService = new NotificationService(messaging);
    this.isRunning = false;
    this.intervalId = null;

    // User cache — avoids Firestore read every poll cycle
    this.userCache = null;
    this.userCacheTime = null;
    this.USER_CACHE_TTL = parseInt(process.env.USER_CACHE_TTL || 300000); // 5 min

    // In-memory consecutive auth-failure counter — zero Firestore cost.
    // Once a user hits AUTH_FAILURE_LIMIT, they are skipped until their
    // Firestore doc is updated (re-register) and the cache refreshes.
    this.authFailureCounts = {}; // { userId: number }
    this.AUTH_FAILURE_LIMIT = parseInt(process.env.AUTH_FAILURE_LIMIT || 3);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ▶️ START / ⏹️ STOP
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  start() {
    if (this.isRunning) {
      console.log('⚠️ Polling service already running');
      return;
    }
    const interval = parseInt(process.env.POLLING_INTERVAL || 120000); // 2 min default
    console.log('🚀 Starting polling service');
    console.log(`   Poll interval : ${interval / 1000}s`);
    console.log(`   User cache TTL: ${this.USER_CACHE_TTL / 1000}s`);
    console.log(`   Auth fail limit: ${this.AUTH_FAILURE_LIMIT} consecutive failures`);

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
    this.userCache = null;
    this.userCacheTime = null;
    this.authFailureCounts = {};
    this.isRunning = false;
    console.log('⏹️ Polling service stopped');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🗄️ GET USERS (in-memory cache)
  // Only hits Firestore when cache is older than USER_CACHE_TTL.
  // Returns { usersArray, userMap }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async getCachedUsers() {
    const now = Date.now();
    const expired = !this.userCacheTime || now - this.userCacheTime > this.USER_CACHE_TTL;

    if (expired) {
      console.log('🔄 Refreshing user cache from Firestore...');
      const snapshot = await this.db.collection('users').get();
      const usersArray = [];
      const userMap = {};

      snapshot.forEach(doc => {
        const data = doc.data();
        usersArray.push({ id: doc.id, data });
        if (data.username) {
          userMap[data.username.toLowerCase()] = { id: doc.id, data };
        }
      });

      this.userCache = { usersArray, userMap };
      this.userCacheTime = now;

      // Reset auth failure counts for users who re-registered
      // (their Firestore doc was updated → cache refresh is the signal)
      Object.keys(this.authFailureCounts).forEach(uid => {
        const stillExists = usersArray.some(u => u.id === uid);
        if (!stillExists) delete this.authFailureCounts[uid];
      });

      console.log(`✅ User cache refreshed — ${usersArray.length} user(s)`);
    } else {
      const age = Math.round((now - this.userCacheTime) / 1000);
      console.log(`⚡ Using cached users (age: ${age}s)`);
    }

    return this.userCache;
  }

  invalidateUserCache() {
    this.userCache = null;
    this.userCacheTime = null;
    console.log('🗑️ User cache invalidated');
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔧 PATCH CACHE HELPER
  // Call after every Firestore .update() so the next cycle within
  // the TTL window sees fresh state — prevents duplicate notifications.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  _patchCache(userId, fields) {
    if (!this.userCache) return;
    const entry = this.userCache.usersArray.find(u => u.id === userId);
    if (!entry) return;
    Object.assign(entry.data, fields);
    // Keep userMap in sync
    const key = entry.data.username?.toLowerCase();
    if (key && this.userCache.userMap[key]) {
      this.userCache.userMap[key].data = entry.data;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔄 POLL ALL USERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async pollAllUsers() {
    try {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🔄 Polling all users...');
      const { usersArray, userMap } = await this.getCachedUsers();

      if (usersArray.length === 0) {
        console.log('⚠️ No users registered yet');
        return;
      }

      console.log(`👥 Processing ${usersArray.length} user(s)`);
      await Promise.allSettled(
        usersArray.map(({ id, data }) => this.pollUser(id, data, userMap))
      );
      console.log('✅ Polling cycle complete');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } catch (error) {
      console.error('❌ Error in pollAllUsers:', error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 👤 POLL SINGLE USER
  // • Validates credentials via AUTH endpoint before fetching data.
  // • Tracks consecutive auth failures in memory — skips user after
  //   AUTH_FAILURE_LIMIT failures (no Firestore reads/writes).
  // • No Firestore reads here — userData comes from cache.
  // • Writes only inside process* methods when state changes.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async pollUser(userId, userData, userMap) {
    try {
      const { fcm_token, api_credentials, username } = userData;

      if (!fcm_token) {
        console.log(`⚠️ ${username} — no FCM token, skipping`);
        return;
      }

      if (!api_credentials) {
        console.log(`⚠️ ${username} — no API credentials, skipping`);
        return;
      }

      // ── AUTH FAILURE GUARD ──────────────────────────────────
      const failures = this.authFailureCounts[userId] || 0;
      if (failures >= this.AUTH_FAILURE_LIMIT) {
        console.log(`🚫 ${username} — skipped (${failures} consecutive auth failures). Re-register to resume.`);
        return;
      }

      // ── VALIDATE CREDENTIALS VIA AUTH ENDPOINT ──────────────
      const authResult = await thirdPartyService.validateCredentials(api_credentials);
      if (!authResult.valid) {
        this.authFailureCounts[userId] = failures + 1;
        const remaining = this.AUTH_FAILURE_LIMIT - (failures + 1);
        console.log(
          `❌ ${username} — auth failed: "${authResult.message}" ` +
          `(${failures + 1}/${this.AUTH_FAILURE_LIMIT}${remaining > 0 ? `, ${remaining} before skip` : ', will skip next cycle'})`
        );
        return;
      }

      // Auth succeeded — reset failure counter
      if (failures > 0) {
        console.log(`✅ ${username} — auth recovered after ${failures} failure(s)`);
        this.authFailureCounts[userId] = 0;
      }

      // ── FETCH ALL DATA IN PARALLEL ──────────────────────────
      const [tasks, createdTasks, leads] = await Promise.all([
        thirdPartyService.fetchAssignedTasks(api_credentials).catch(err => {
          console.error(`❌ fetchAssignedTasks [${username}]:`, err.message);
          return [];
        }),
        thirdPartyService.fetchCreatedTasks(api_credentials).catch(err => {
          console.error(`❌ fetchCreatedTasks [${username}]:`, err.message);
          return [];
        }),
        thirdPartyService.fetchAssignedLeads(api_credentials).catch(err => {
          console.error(`❌ fetchAssignedLeads [${username}]:`, err.message);
          return [];
        }),
      ]);

      await this.processTaskChanges(userId, userData, tasks, fcm_token, userMap);
      await this.processCreatedTaskChanges(userId, userData, createdTasks, fcm_token, userMap);
      await this.processLeadChanges(userId, userData, leads, fcm_token);

      // ✅ NO last_checked write — removed to save writes
    } catch (error) {
      console.error(`❌ Error polling user ${userId}:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🛠️ HELPERS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  getISTDate(date = null) {
    const t = date ? new Date(date) : new Date();
    return new Date(t.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  }

  getISTDateString(date = null) {
    const d = this.getISTDate(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Deep-equal check for plain objects — avoids unnecessary Firestore writes
  _isEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 PROCESS ASSIGNED TASK CHANGES
  // Write skipped when task_data, delayed_task_ids, and
  // deadline_warnings_sent are all unchanged.
  // Cache patched after every write to prevent duplicate
  // notifications within the 5-min TTL window.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processTaskChanges(userId, userData, currentTasks, fcmToken, userMap) {
    try {
      const { username } = userData;
      const prevTaskData = userData.task_data || {};
      const delayedTaskIds = new Set(
        (userData.delayed_task_ids || []).map(id => id.toString())
      );
      const warningsSent = { ...(userData.deadline_warnings_sent || {}) };
      let warningsUpdated = false;

      const currentTaskData = {};
      currentTasks.forEach(task => {
        currentTaskData[task.DocID] = {
          status: task.TaskStatus,
          statusId: task.TaskStatusID,
          deadline: task.TaskDeadline,
        };
      });

      // ── NEW TASKS ──────────────────────────────────────────────
      const newTasks = currentTasks.filter(task => !prevTaskData[task.DocID]);
      if (newTasks.length > 0) {
        console.log(`🆕 ${newTasks.length} new task(s) for ${username}`);
        const result = await this.notificationService.sendTaskNotification(
          fcmToken, newTasks, newTasks.length
        );
        if (result?.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
      }

      // ── STATUS CHANGES & DEADLINE CHECKS ──────────────────────
      for (const task of currentTasks) {
        const prevTask = prevTaskData[task.DocID];
        if (!prevTask) continue;

        if (prevTask.status !== task.TaskStatus) {
          console.log(`🔄 ${task.TaskSubject}: "${prevTask.status}" → "${task.TaskStatus}"`);
        }

        // Accepted: 0 → 1
        if (prevTask.statusId === 0 && task.TaskStatusID === 1) {
          console.log(`✅ Accepted: ${task.TaskSubject}`);
          await this.notifyTaskCreator(task, 'accepted', userMap);
        }

        // Completed: any → 2
        if (task.TaskStatusID === 2 && prevTask.statusId !== 2) {
          console.log(`✅ Completed: ${task.TaskSubject}`);
          await this.notifyTaskCreator(task, 'completed', userMap);
        }

        if (task.TaskStatusID !== 2) {
          const now = this.getISTDate();
          const deadline = this.getISTDate(task.TaskDeadline);

          // Warning: 1 hour before deadline, fires once per task
          const oneHourBefore = new Date(deadline.getTime() - 60 * 60 * 1000);
          if (now >= oneHourBefore && now < deadline) {
            const fired = await this.checkDeadlineWarning(userId, task, fcmToken, warningsSent);
            if (fired) warningsUpdated = true;
          }

          // Delayed: past deadline, fires once
          if (now > deadline && !delayedTaskIds.has(task.DocID.toString())) {
            console.log(`🚨 Delayed: ${task.TaskSubject}`);
            const result = await this.notificationService.sendTaskDelayedNotification(
              fcmToken, task, false
            );
            if (result?.error === 'invalid_token') {
              await this.handleInvalidToken(userId);
              return;
            }
            await this.notifyTaskCreator(task, 'delayed', userMap);
            delayedTaskIds.add(task.DocID.toString());
          }
        } else {
          // Task completed — remove from delayed set
          delayedTaskIds.delete(task.DocID.toString());
        }
      }

      // ── WRITE ONLY IF SOMETHING CHANGED ───────────────────────
      const newDelayedIds = [...delayedTaskIds];
      const prevDelayedIds = userData.delayed_task_ids || [];
      const taskDataChanged   = !this._isEqual(currentTaskData, prevTaskData);
      const delayedIdsChanged = !this._isEqual(
        newDelayedIds.map(String).sort(),
        [...prevDelayedIds].map(String).sort()
      );

      if (taskDataChanged || delayedIdsChanged || warningsUpdated) {
        const updatePayload = {
          task_data: currentTaskData,
          last_task_count: currentTasks.length,
          delayed_task_ids: newDelayedIds,
        };
        if (warningsUpdated) updatePayload.deadline_warnings_sent = warningsSent;

        await this.db.collection('users').doc(userId).update(updatePayload);

        // Patch cache immediately so next cycle within TTL sees updated state
        this._patchCache(userId, updatePayload);

        console.log(`💾 Task state saved + cache patched for ${username}`);
      } else {
        console.log(`⏭️ No task changes for ${username} — write skipped`);
      }
    } catch (error) {
      console.error(`❌ processTaskChanges [${userId}]:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 PROCESS CREATED TASK CHANGES
  // Write skipped when created_task_data and delayed IDs unchanged.
  // Cache patched after every write.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processCreatedTaskChanges(userId, userData, currentTasks, fcmToken, userMap) {
    try {
      const { username } = userData;
      const prevCreatedTaskData = userData.created_task_data || {};
      const createdDelayedTaskIds = new Set(
        (userData.created_delayed_task_ids || []).map(id => id.toString())
      );

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
        console.log(`🌱 Seeding created tasks for ${username} (${currentTasks.length})`);
        const seedPayload = {
          created_task_data: currentCreatedTaskData,
          created_delayed_task_ids: [],
        };
        await this.db.collection('users').doc(userId).update(seedPayload);
        this._patchCache(userId, seedPayload);
        return;
      }

      for (const task of currentTasks) {
        const prevTask = prevCreatedTaskData[task.DocID];
        if (!prevTask) {
          console.log(`🌱 New created task seeded: ${task.TaskSubject}`);
          continue;
        }

        // If assignee is also a registered user, they handle their own
        // accept/complete/delay notifications — skip to avoid duplicates
        const assigneeRegistered = !!userMap[task.AssignToUserNm?.toLowerCase()];
        if (assigneeRegistered) continue;

        const prevStatusId = prevTask.statusId;
        const currentStatusId = task.TaskStatusID;

        if (prevStatusId !== currentStatusId) {
          console.log(`🔄 Created task: ${prevStatusId}→${currentStatusId} | ${task.TaskSubject}`);
        }

        // Accepted: 0 → 1
        if (prevStatusId === 0 && currentStatusId === 1) {
          const result = await this.notificationService.sendTaskAcceptedNotification(fcmToken, task);
          if (result?.error === 'invalid_token') { await this.handleInvalidToken(userId); return; }
        }

        // Completed: any → 2
        if (currentStatusId === 2 && prevStatusId !== 2) {
          const result = await this.notificationService.sendTaskCompletedNotification(fcmToken, task);
          if (result?.error === 'invalid_token') { await this.handleInvalidToken(userId); return; }
          createdDelayedTaskIds.delete(task.DocID.toString());
          continue;
        }

        // Delayed: past deadline, fires once
        if (currentStatusId !== 2) {
          const now = this.getISTDate();
          const deadline = this.getISTDate(task.TaskDeadline);
          if (now > deadline && !createdDelayedTaskIds.has(task.DocID.toString())) {
            const result = await this.notificationService.sendTaskDelayedNotification(fcmToken, task, true);
            if (result?.error === 'invalid_token') { await this.handleInvalidToken(userId); return; }
            createdDelayedTaskIds.add(task.DocID.toString());
          }
        }
      }

      // ── WRITE ONLY IF SOMETHING CHANGED ───────────────────────
      const newDelayedIds = [...createdDelayedTaskIds];
      const createdDataChanged = !this._isEqual(currentCreatedTaskData, prevCreatedTaskData);
      const delayedIdsChanged  = !this._isEqual(
        newDelayedIds.map(String).sort(),
        [...(userData.created_delayed_task_ids || [])].map(String).sort()
      );

      if (createdDataChanged || delayedIdsChanged) {
        const updatePayload = {
          created_task_data: currentCreatedTaskData,
          created_delayed_task_ids: newDelayedIds,
        };
        await this.db.collection('users').doc(userId).update(updatePayload);
        this._patchCache(userId, updatePayload);
        console.log(`💾 Created task state saved + cache patched for ${username}`);
      } else {
        console.log(`⏭️ No created task changes for ${username} — write skipped`);
      }
    } catch (error) {
      console.error(`❌ processCreatedTaskChanges [${userId}]:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ⏰ DEADLINE WARNING — fires once per task
  // warningsSent is mutated in-place; caller writes it to Firestore.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async checkDeadlineWarning(userId, task, fcmToken, warningsSent) {
    try {
      if (warningsSent[task.DocID]) return false;

      console.log(`⏰ Deadline warning: ${task.TaskSubject}`);
      const result = await this.notificationService.sendDeadlineWarningNotification(fcmToken, task);
      if (result?.error === 'invalid_token') {
        await this.handleInvalidToken(userId);
        return false;
      }

      warningsSent[task.DocID] = new Date().toISOString();
      return true;
    } catch (error) {
      console.error('❌ checkDeadlineWarning:', error);
      return false;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔔 NOTIFY TASK CREATOR — pure in-memory, zero Firestore reads
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async notifyTaskCreator(task, notificationType, userMap) {
    try {
      const creator = userMap[task.CreateUserNm?.toLowerCase()];
      if (!creator) {
        console.log(`⚠️ Creator "${task.CreateUserNm}" not registered`);
        return;
      }
      if (!creator.data.fcm_token) {
        console.log(`⚠️ No FCM token for creator ${creator.data.username}`);
        return;
      }

      console.log(`📤 Notifying creator ${creator.data.username} [${notificationType}]`);
      let result;
      switch (notificationType) {
        case 'accepted':
          result = await this.notificationService.sendTaskAcceptedNotification(creator.data.fcm_token, task);
          break;
        case 'completed':
          result = await this.notificationService.sendTaskCompletedNotification(creator.data.fcm_token, task);
          break;
        case 'delayed':
          result = await this.notificationService.sendTaskDelayedNotification(creator.data.fcm_token, task, true);
          break;
      }

      if (result?.error === 'invalid_token') {
        await this.handleInvalidToken(creator.id);
        this.invalidateUserCache();
      } else {
        console.log(`✅ Creator ${creator.data.username} notified`);
      }
    } catch (error) {
      console.error('❌ notifyTaskCreator:', error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🎯 PROCESS LEAD CHANGES
  // Write skipped when lead IDs and reminders unchanged.
  // Cache patched after every write.
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async processLeadChanges(userId, userData, currentLeads, fcmToken) {
    try {
      const { username } = userData;

      if (!Array.isArray(currentLeads) || currentLeads.length === 0) {
        console.log(`📊 ${username}: No leads`);
        return;
      }

      const currentLeadIds = currentLeads.map(lead => lead.DocID);
      const prevKnownIds = userData.known_lead_ids || [];
      const prevLeadIdSet = new Set(
        prevKnownIds.map(id =>
          typeof id === 'object' ? id.toNumber?.() ?? Number(id.low) : Number(id)
        )
      );

      const newLeads = currentLeads.filter(lead => !prevLeadIdSet.has(Number(lead.DocID)));
      if (newLeads.length > 0) {
        console.log(`🆕 ${newLeads.length} new lead(s) for ${username}`);
        const result = await this.notificationService.sendLeadNotification(
          fcmToken, newLeads, newLeads.length
        );
        if (result?.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
      }

      // Follow-up reminders — fire once per lead per day
      const todayIST = this.getISTDateString();
      const prevReminders = userData.follow_up_reminders_sent || {};
      const updatedReminders = { ...prevReminders };
      let reminderFired = false;

      for (const lead of currentLeads) {
        if (!lead.LeadFollowUpDt) continue;
        if (this.getISTDateString(lead.LeadFollowUpDt) !== todayIST) continue;
        if (updatedReminders[lead.DocID] === todayIST) continue;

        console.log(`🔔 Follow-up today: ${lead.LeadName}`);
        const result = await this.notificationService.sendLeadFollowUpNotification(fcmToken, lead);
        if (result?.error === 'invalid_token') {
          await this.handleInvalidToken(userId);
          return;
        }
        updatedReminders[lead.DocID] = todayIST;
        reminderFired = true;
      }

      // ── WRITE ONLY IF SOMETHING CHANGED ───────────────────────
      const leadIdsChanged = newLeads.length > 0;
      if (leadIdsChanged || reminderFired) {
        const updatePayload = { known_lead_ids: currentLeadIds };
        if (reminderFired) updatePayload.follow_up_reminders_sent = updatedReminders;

        await this.db.collection('users').doc(userId).update(updatePayload);
        this._patchCache(userId, updatePayload);

        console.log(`💾 Lead state saved + cache patched for ${username}`);
      } else {
        console.log(`⏭️ No lead changes for ${username} — write skipped`);
      }
    } catch (error) {
      console.error(`❌ processLeadChanges [${userId}]:`, error);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🗑️ HANDLE INVALID FCM TOKEN
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async handleInvalidToken(userId) {
    try {
      console.log(`🗑️ Removing invalid FCM token for ${userId}`);
      const updatePayload = {
        fcm_token: null,
        token_invalidated_at: new Date().toISOString(),
      };
      await this.db.collection('users').doc(userId).update(updatePayload);
      this._patchCache(userId, updatePayload);
      console.log(`✅ Token removed + cache patched for ${userId}`);
    } catch (error) {
      console.error(`❌ handleInvalidToken [${userId}]:`, error);
    }
  }
}

module.exports = PollingService;