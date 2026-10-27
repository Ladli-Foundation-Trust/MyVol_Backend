const { z } = require('zod');

const notificationParams = z.strictObject({ notificationId: z.uuid('is not a valid notification id') });

// `before`: the createdAt of the newest notification the app has shown (optional).
// The body may be missing altogether (Express 5 leaves req.body undefined then).
const markAllRead = z
    .strictObject({ before: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional() })
    .default({});

module.exports = { notificationParams, markAllRead };
