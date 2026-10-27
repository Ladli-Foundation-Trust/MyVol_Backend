const prisma = require('../lib/prisma');

// App settings with the same flat keys as the app's settingsSlice (MyVolApp
// src/data/appSettingsContent.js SETTINGS_DEFAULTS), so the app can sync its settings
// store as-is. Reads merge stored values over DEFAULTS, so a new setting needs a default
// here (and options in OPTIONS if it is a choice), no migration: the validator is built
// from these two objects.
//
// Where a value lives:
// - COLUMN_KEYS are columns on `users`, because list queries filter on them (feeds,
//   explore, search): privateAccount = users.is_private, whoCanViewActivities =
//   users.activity_visibility, showLocationOnPosts = users.show_location.
// - Everything else is one JSONB object in user_settings.data.
//
// What the server acts on (the rest is stored for the app, or for features that don't
// exist yet; README "Settings" has the full table):
//   notifications  pauseAll, notifLikes, notifComments, notifNewFollowers,
//                  notifFollowRequests, notifActivityApproved, notifSound, notifVibrate,
//                  quietHours (notificationService)
//   privacy        privateAccount, whoCanFollow (followService), whoCanViewActivities,
//                  showLocationOnPosts (postService), showImpactStats (profiles/impact),
//                  suggestToOthers, showSuggestedVolunteers (suggestionService)
//   interactions   whoCanComment, hideOffensiveComments (commentService), allowSharing,
//                  hideLikeCounts (postService)
//   feed           feedSort (postService.homeFeed)
//   security       loginAlerts (authService.completeLogin)

const AUDIENCES = ['off', 'following', 'everyone'];

// Choice settings and their allowed values (the app's radio pages).
const OPTIONS = {
    notifLikes: AUDIENCES,
    notifComments: AUDIENCES,
    notifMentions: AUDIENCES,
    whoCanFollow: ['everyone', 'approve', 'none'],
    whoCanViewActivities: ['everyone', 'followers', 'onlyMe'],
    whoCanComment: ['everyone', 'followers', 'following', 'off'],
    whoCanMention: ['everyone', 'following', 'none'],
    whoCanTag: ['everyone', 'following', 'none'],
    feedSort: ['recommended', 'latest', 'following'],
    nearbyRadius: ['10', '25', '50', 'any'],
    sensitiveContent: ['standard', 'less'],
    autoplayVideos: ['always', 'wifi', 'never'],
    uploadQuality: ['high', 'standard'],
    language: ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'gu', 'kn', 'pa'],
    distanceUnit: ['km', 'mi'],
};

// Every key not in OPTIONS is a boolean.
const DEFAULTS = {
    // Notifications
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

    // Privacy
    privateAccount: false,
    showActivityStatus: true,
    showImpactStats: true,
    showLocationOnPosts: true,
    suggestToOthers: true,
    whoCanFollow: 'everyone',
    whoCanViewActivities: 'everyone',

    // Interactions
    whoCanComment: 'everyone',
    whoCanMention: 'everyone',
    whoCanTag: 'following',
    allowSharing: true,
    allowReposts: true,
    hideOffensiveComments: true,
    hideLikeCounts: false,

    // Feed & content
    feedSort: 'recommended',
    showSuggestedVolunteers: true,
    nearbyRadius: '25',
    sensitiveContent: 'standard',

    // Media & data
    autoplayVideos: 'wifi',
    startVideosMuted: true,
    dataSaver: false,
    uploadQuality: 'high',
    saveOriginalPhotos: false,

    // Language & region
    language: 'en',
    distanceUnit: 'km',

    // Accessibility
    reduceMotion: false,
    altTextReminders: true,
    captionsByDefault: false,

    // Security
    loginAlerts: true,
};

// Setting key -> users column.
const COLUMN_KEYS = {
    privateAccount: 'isPrivate',
    whoCanViewActivities: 'activityVisibility',
    showLocationOnPosts: 'showLocation',
};

const USER_SELECT = { id: true, isPrivate: true, activityVisibility: true, showLocation: true, settings: { select: { data: true } } };

// Stored keys that are unknown (or column keys) are ignored, never returned.
const merge = (user) => {
    const stored = user?.settings?.data && typeof user.settings.data === 'object' ? user.settings.data : {};
    const values = Object.fromEntries(
        Object.entries(DEFAULTS).map(([key, value]) => [key, key in COLUMN_KEYS || !(key in stored) ? value : stored[key]]),
    );
    if (user) for (const [key, column] of Object.entries(COLUMN_KEYS)) values[key] = user[column];
    return values;
};

const getSettings = async (userId) => merge(await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT }));

// Several users at once (feeds, live delivery): one query, then settingsOf(userId).
const settingsFor = async (userIds) => {
    const ids = [...new Set(userIds.filter(Boolean))];
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT }) : [];
    const byUser = new Map(users.map((u) => [u.id, merge(u)]));
    return (userId) => byUser.get(userId) ?? merge(null);
};

// Splits a PATCH into users-column data and JSON keys.
const splitChanges = (changes) => {
    const columns = {};
    const json = {};
    for (const [key, value] of Object.entries(changes)) {
        if (key in COLUMN_KEYS) columns[COLUMN_KEYS[key]] = value;
        else json[key] = value;
    }
    return { columns, json };
};

// Merges `changes` into the stored object in one statement (jsonb ||), so two devices
// changing different settings at once can't overwrite each other. Run it inside the
// caller's transaction (accountSettingsService.updateSettings).
const writeJson = (db, userId, changes) =>
    Object.keys(changes).length
        ? db.$executeRaw`
              INSERT INTO user_settings (user_id, data, updated_at)
              VALUES (${userId}::uuid, ${JSON.stringify(changes)}::jsonb, now())
              ON CONFLICT (user_id) DO UPDATE SET data = user_settings.data || EXCLUDED.data, updated_at = now()`
        : null;

module.exports = { AUDIENCES, OPTIONS, DEFAULTS, COLUMN_KEYS, getSettings, settingsFor, splitChanges, writeJson };
