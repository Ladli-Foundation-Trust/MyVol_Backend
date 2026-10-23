const notifications = require('../services/notificationService');
const settings = require('../services/settingsService');

const ok = (res, data) => res.json({ status: 'success', data });

// ---------- notifications ----------

exports.list = async (req, res) => ok(res, await notifications.listNotifications(req.user.id, req.validatedQuery));

exports.unreadCount = async (req, res) => ok(res, await notifications.unreadCount(req.user.id));

exports.markRead = async (req, res) => ok(res, await notifications.markRead(req.user.id, req.params.notificationId));

exports.markAllRead = async (req, res) => ok(res, await notifications.markAllRead(req.user.id, req.body));

exports.remove = async (req, res) => ok(res, await notifications.deleteNotification(req.user.id, req.params.notificationId));

// Sends a test event to the caller's connected devices → { devices }.
exports.test = async (req, res) => ok(res, notifications.sendTest(req.user.id));

// ---------- settings ----------

exports.getSettings = async (req, res) => ok(res, { settings: await settings.getSettings(req.user.id) });

exports.updateSettings = async (req, res) => ok(res, { settings: await settings.updateSettings(req.user.id, req.body) });
