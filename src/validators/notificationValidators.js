const { z } = require('zod');
const { AUDIENCES } = require('../services/settingsService');

const notificationParams = z.strictObject({ notificationId: z.uuid('is not a valid notification id') });

// `before`: the createdAt of the newest notification the app has shown (optional).
// The body may be missing altogether (Express 5 leaves req.body undefined then).
const markAllRead = z
    .strictObject({ before: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional() })
    .default({});

// Same keys and values as the app's settingsSlice (appSettingsContent.js).
const audience = z.enum(AUDIENCES, { error: `must be one of: ${AUDIENCES.join(', ')}` });

const updateSettings = z
    .strictObject({
        pauseAll: z.boolean(),
        notifLikes: audience,
        notifComments: audience,
        notifMentions: audience,
        notifNewFollowers: z.boolean(),
        notifFollowRequests: z.boolean(),
        notifActivityApproved: z.boolean(),
        notifActivityReminders: z.boolean(),
        notifNearbyOpportunities: z.boolean(),
        notifAnnouncements: z.boolean(),
        emailWeeklyDigest: z.boolean(),
        emailOpportunities: z.boolean(),
        emailProductUpdates: z.boolean(),
        notifSound: z.boolean(),
        notifVibrate: z.boolean(),
        quietHours: z.boolean(),
    })
    .partial()
    .refine((d) => Object.keys(d).length > 0, 'send at least one setting to update');

module.exports = { notificationParams, markAllRead, updateSettings };
