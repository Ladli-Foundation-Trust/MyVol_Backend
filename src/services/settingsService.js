const prisma = require('../lib/prisma');

// App settings, stored as one JSONB object per user (user_settings.data) with the
// same flat keys as the app's settingsSlice (MyVolApp src/data/appSettingsContent.js),
// so the app can sync its settings store as-is. Reads merge stored values over
// DEFAULTS, so a new setting needs a default here and a validator entry, no migration.
//
// Only the Notifications page exists so far; the settings phase adds privacy,
// interactions, feed and media. Of these, the server acts on: pauseAll, notifLikes,
// notifComments, notifNewFollowers, notifFollowRequests, notifActivityApproved,
// notifSound, notifVibrate and quietHours (see notificationService). The rest are
// stored for the features that will read them (mentions, reminders, emails...).

const AUDIENCES = ['off', 'following', 'everyone'];

const DEFAULTS = {
    pauseAll: false,
    notifLikes: 'everyone',
    notifComments: 'everyone',
    notifMentions: 'everyone',
    notifNewFollowers: true,
    notifFollowRequests: true,
    notifActivityApproved: true,
    notifActivityReminders: true,
    notifNearbyOpportunities: true,
    notifAnnouncements: true,
    emailWeeklyDigest: true,
    emailOpportunities: true,
    emailProductUpdates: false,
    notifSound: true,
    notifVibrate: true,
    quietHours: false,
};

// Stored keys that are no longer (or not yet) known are ignored, never returned.
const withDefaults = (data) => {
    const stored = data && typeof data === 'object' ? data : {};
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, key in stored ? stored[key] : value]));
};

const getSettings = async (userId) => {
    const row = await prisma.userSettings.findUnique({ where: { userId }, select: { data: true } });
    return withDefaults(row?.data);
};

// Several users at once, for sending pushes in bulk.
const settingsFor = async (userIds) => {
    const rows = await prisma.userSettings.findMany({ where: { userId: { in: userIds } }, select: { userId: true, data: true } });
    const byUser = new Map(rows.map((r) => [r.userId, r.data]));
    return (userId) => withDefaults(byUser.get(userId));
};

// Merges `changes` into the stored object in one statement (jsonb ||), so two
// devices changing different settings at once can't overwrite each other.
const updateSettings = async (userId, changes) => {
    await prisma.$executeRaw`
        INSERT INTO user_settings (user_id, data, updated_at)
        VALUES (${userId}::uuid, ${JSON.stringify(changes)}::jsonb, now())
        ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || EXCLUDED.data, updated_at = now()`;
    return getSettings(userId);
};

module.exports = { AUDIENCES, DEFAULTS, getSettings, settingsFor, updateSettings };
