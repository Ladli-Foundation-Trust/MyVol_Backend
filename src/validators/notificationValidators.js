const { z } = require('zod');

const notificationParams = z.strictObject({ notificationId: z.uuid('is not a valid notification id') });

// `before`: the createdAt of the newest notification the app has shown (optional).
// The body may be missing altogether (Express 5 leaves req.body undefined then).
const markAllRead = z
    .strictObject({ before: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional() })
    .default({});

// The device's FCM registration token (from getDevicePushTokenAsync), one per session.
// FCM tokens are ~150–250 chars of [A-Za-z0-9_:-]; the cap leaves room for changes.
const pushToken = z.strictObject({
    token: z
        .string()
        .trim()
        .min(20, 'is too short')
        .max(4096, 'is too long')
        .regex(/^[\w:.-]+$/, 'has unexpected characters'),
    platform: z.enum(['android', 'ios']),
});

module.exports = { notificationParams, markAllRead, pushToken };
