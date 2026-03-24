class NotificationService {
  constructor(messaging) {
    this.messaging = messaging;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📋 SEND TASK NOTIFICATION (New Task Assignment)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendTaskNotification(fcmToken, tasks, newTaskCount) {
    try {
      const latestTask = tasks[0];
      const priorityEmoji = this.getPriorityEmoji(latestTask.Priority);

      const notification = {
        title: `${priorityEmoji} New Task From: ${latestTask.CreateUserNm}`,
        body: `${latestTask.TaskSubject}`,
      };

      const data = {
        type: 'task',
        action: 'new_task',
        count: newTaskCount.toString(),
        task_id: latestTask.DocID.toString(),
        task_subject: latestTask.TaskSubject,
        task_status: latestTask.TaskStatus,
        priority: latestTask.Priority,
        deadline: latestTask.TaskDeadline,
        created_by: latestTask.CreateUserNm,
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'tasks',
            color: this.getPriorityColor(latestTask.Priority),
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: newTaskCount,
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log(`✅ New task notification sent: ${latestTask.TaskSubject}`);
      return response;

    } catch (error) {
      console.error('❌ Error sending task notification:', error.message);
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ SEND TASK ACCEPTED NOTIFICATION (To Creator)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendTaskAcceptedNotification(fcmToken, task) {
    try {
      const notification = {
        title: `✅ Task Accepted: ${task.TaskSubject}`,
        body: `${task.AssignToUserNm} has accepted the task`,
      };

      const data = {
        type: 'task',
        action: 'task_accepted',
        task_id: task.DocID.toString(),
        task_subject: task.TaskSubject,
        task_status: 'In-Progress',
        accepted_by: task.AssignToUserNm,
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'tasks',
            color: '#4CAF50',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log(`✅ Task accepted notification sent`);
      return response;

    } catch (error) {
      console.error('❌ Error sending task accepted notification:', error.message);
      // ✅ FIXED: was throwing on invalid token, now returns gracefully
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ✅ SEND TASK COMPLETED NOTIFICATION (To Creator)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendTaskCompletedNotification(fcmToken, task) {
    try {
      const notification = {
        title: `✅ Task Completed: ${task.TaskSubject}`,
        body: `${task.AssignToUserNm} has submitted the task`,
      };

      const data = {
        type: 'task',
        action: 'task_completed',
        task_id: task.DocID.toString(),
        task_subject: task.TaskSubject,
        task_status: 'Completed',
        completed_by: task.AssignToUserNm,
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'tasks',
            color: '#4CAF50',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log(`✅ Task completed notification sent`);
      return response;

    } catch (error) {
      console.error('❌ Error sending task completed notification:', error.message);
      // ✅ FIXED: was throwing on invalid token, now returns gracefully
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ⏰ SEND DEADLINE WARNING NOTIFICATION (1 hour before)
  // To Assigned User
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendDeadlineWarningNotification(fcmToken, task) {
    try {
      const priorityEmoji = this.getPriorityEmoji(task.Priority);

      const notification = {
        title: `⏰ Deadline Alert: ${task.TaskSubject}`,
        body: `${priorityEmoji} Task deadline in 1 hour! Complete it soon.`,
      };

      const data = {
        type: 'task',
        action: 'deadline_warning',
        task_id: task.DocID.toString(),
        task_subject: task.TaskSubject,
        task_status: task.TaskStatus,
        priority: task.Priority,
        deadline: task.TaskDeadline,
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'tasks',
            color: '#FF9800',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log(`✅ Deadline warning notification sent: ${task.TaskSubject}`);
      return response;

    } catch (error) {
      console.error('❌ Error sending deadline warning:', error.message);
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🚨 SEND TASK DELAYED NOTIFICATION
  // Sends to BOTH Assigned User AND Creator
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendTaskDelayedNotification(fcmToken, task, isCreator = false) {
    try {
      const notification = isCreator
        ? {
            title: `🚨 Task Delayed: ${task.TaskSubject}`,
            body: `${task.AssignToUserNm} has exceeded the deadline`,
          }
        : {
            title: `🚨 Task Delayed: ${task.TaskSubject}`,
            body: `You have exceeded the deadline! Please complete ASAP.`,
          };

      const data = {
        type: 'task',
        action: 'task_delayed',
        task_id: task.DocID.toString(),
        task_subject: task.TaskSubject,
        task_status: 'Delayed',
        priority: task.Priority,
        deadline: task.TaskDeadline,
        assigned_to: task.AssignToUserNm,
        created_by: task.CreateUserNm,
        is_creator: isCreator.toString(),
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'tasks',
            color: '#D32F2F',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log(`✅ Task delayed notification sent (${isCreator ? 'Creator' : 'Assignee'})`);
      return response;

    } catch (error) {
      console.error('❌ Error sending delayed notification:', error.message);
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🎯 SEND LEAD ALLOTMENT NOTIFICATION (New Lead Assigned)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendLeadNotification(fcmToken, leads, newLeadCount) {
    try {
      const latestLead = leads[0];

      const notification = {
        title: `🎯 New Lead Allotted: ${latestLead.LeadName || 'New Lead'}`,
        body: `From: ${latestLead.CreateBy || 'System'}${latestLead.LeadRequirement ? ` • ${latestLead.LeadRequirement}` : ''}`,
      };

      const data = {
        type: 'lead',
        action: 'new_lead',
        count: newLeadCount.toString(),
        lead_id: latestLead.DocID?.toString() || '',
        lead_name: latestLead.LeadName || '',
        lead_mob: latestLead.LeadMobNo || '',
        created_by: latestLead.CreateBy || '',
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'leads',
            color: '#4CAF50',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
              badge: newLeadCount,
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log('✅ Lead allotment notification sent successfully');
      return response;

    } catch (error) {
      console.error('❌ Error sending lead notification:', error.message);
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🔔 SEND LEAD FOLLOW-UP REMINDER NOTIFICATION
  // Triggered when LeadFollowUpDt matches today (IST)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendLeadFollowUpNotification(fcmToken, lead) {
    try {
      const notification = {
        title: `🔔 Follow-Up Reminder: ${lead.LeadName}`,
        body: lead.LeadRequirement
          ? `Requirement: ${lead.LeadRequirement}`
          : `Schedule your follow-up call today.`,
      };

      const data = {
        type: 'lead',
        action: 'lead_followup',
        lead_id: lead.DocID?.toString() || '',
        lead_name: lead.LeadName || '',
        lead_mob: lead.LeadMobNo || '',
        lead_requirement: lead.LeadRequirement || '',
        follow_up_date: lead.LeadFollowUpDt || '',
        sales_person: lead.LeadSalesPerson || '',
        timestamp: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      const message = {
        notification,
        data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'leads',
            color: '#1976D2',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log(`✅ Follow-up reminder sent: ${lead.LeadName}`);
      return response;

    } catch (error) {
      console.error('❌ Error sending follow-up reminder:', error.message);
      if (error.code === 'messaging/invalid-registration-token' ||
          error.code === 'messaging/registration-token-not-registered') {
        return { error: 'invalid_token' };
      }
      throw error;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 🛠️ HELPER FUNCTIONS
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  getPriorityEmoji(priority) {
    const emojis = {
      'High': '🔴',
      'Medium': '🟡',
      'Normal': '🔵',
      'Low': '🟢',
    };
    return emojis[priority] || '📋';
  }

  getPriorityColor(priority) {
    const colors = {
      'High': '#D32F2F',
      'Medium': '#FBC02D',
      'Normal': '#1976D2',
      'Low': '#388E3C',
    };
    return colors[priority] || '#2196F3';
  }

  formatDeadline(deadline) {
    const deadlineDate = new Date(deadline);
    const now = new Date();
    const diffTime = deadlineDate - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return `${Math.abs(diffDays)} days ago`;
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays <= 7) return `in ${diffDays} days`;

    return deadlineDate.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }

  formatDeadlineIST(deadline) {
    const deadlineDate = new Date(deadline);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(deadlineDate.getTime() + istOffset);
    const now = new Date();
    const nowIST = new Date(now.getTime() + istOffset);
    const diffTime = istDate - nowIST;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return `${Math.abs(diffDays)} days ago`;
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays <= 7) return `in ${diffDays} days`;

    return istDate.toLocaleDateString('en-IN', {
      month: 'short',
      day: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 📤 SEND CUSTOM NOTIFICATION
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  async sendCustomNotification(fcmToken, title, body, data = {}) {
    try {
      const message = {
        notification: { title, body },
        data,
        android: { priority: 'high' },
        token: fcmToken,
      };

      const response = await this.messaging.send(message);
      console.log('✅ Custom notification sent successfully');
      return response;

    } catch (error) {
      console.error('❌ Error sending custom notification:', error.message);
      throw error;
    }
  }
}

module.exports = NotificationService;