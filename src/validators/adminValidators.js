const { z } = require('zod');
const { PREFERRED_AREAS } = require('./userValidators');

// Query/body schemas for the admin panel's read models (adminService). Names come in
// lower case (as the panel shows them) and are stored as the enum.

const upper = (values) => z.enum(values, { error: `must be one of: ${values.join(', ')}` }).transform((v) => v.toUpperCase());
const bool = z.stringbool({ error: 'must be true or false' });
const q = z.string().trim().max(100).optional().transform((v) => v || undefined);

const pageQuery = z.strictObject({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const analyticsQuery = z.strictObject({
    days: z.coerce.number().int().refine((d) => [7, 14, 30, 90, 180, 365].includes(d), 'must be 7, 14, 30, 90, 180 or 365').default(30),
});

const usersQuery = pageQuery.extend({
    q,
    status: upper(['active', 'deactivated', 'pending_deletion', 'suspended']).optional(),
    role: upper(['user', 'reviewer', 'admin']).optional(),
    verified: bool.optional(),
    sort: z.enum(['newest', 'oldest', 'followers', 'lastLogin', 'name']).default('newest'),
});

const postsQuery = pageQuery.extend({
    q,
    status: upper(['under_review', 'approved', 'rejected']).optional(),
    category: z.string().trim().max(60).optional(),
    media: z.enum(['reel', 'video', 'photo', 'text']).optional(),
    featured: bool.optional(),
    authorId: z.uuid().optional(),
    sort: z.enum(['newest', 'oldest', 'likes', 'comments', 'views']).default('newest'),
});

const commentsQuery = pageQuery.extend({
    q,
    offensive: bool.optional(),
    postId: z.uuid().optional(),
    authorId: z.uuid().optional(),
});

const searchQuery = pageQuery.extend({ q });

const authEventsQuery = pageQuery.extend({
    q,
    type: z.string().trim().max(40).optional(),
});

const reason = z.string().trim().min(3, 'must be at least 3 characters').max(300, 'must be at most 300 characters');

const withReason = z.strictObject({ reason });

const clearProfile = z.strictObject({
    avatar: z.boolean().default(false),
    bio: z.boolean().default(false),
    reason,
});

// ---------- announcements (D84) ----------

const days = z.coerce.number().int().min(1).max(3650);

// Who gets it. Every field is optional; they combine with AND. {} = every active member.
const audience = z
    .strictObject({
        roles: z.array(upper(['user', 'reviewer', 'admin'])).max(3).optional(),
        city: z.string().trim().min(2).max(60).optional(),
        causes: z.array(z.enum(PREFERRED_AREAS, { error: `must be one of: ${PREFERRED_AREAS.join(', ')}` })).max(PREFERRED_AREAS.length).optional(),
        joinedWithinDays: days.optional(),
        activeWithinDays: days.optional(),
        inactiveForDays: days.optional(),
        userIds: z.array(z.uuid()).min(1).max(500).optional(),
    })
    .refine((a) => !(a.activeWithinDays && a.inactiveForDays), { message: "can't be both active and inactive", path: ['inactiveForDays'] })
    .default({});

const MAX_SCHEDULE_DAYS = 60;

const createAnnouncement = z.strictObject({
    title: z.string().trim().min(3, 'must be at least 3 characters').max(80, 'must be at most 80 characters'),
    body: z.string().trim().min(3, 'must be at least 3 characters').max(500, 'must be at most 500 characters'),
    // Where "Open" goes: a web page or a screen in the app.
    linkUrl: z
        .string()
        .trim()
        .max(500)
        .regex(/^(https:\/\/|myvolapp:\/\/)\S+$/, 'must start with https:// or myvolapp://')
        .optional()
        .or(z.literal('').transform(() => undefined)),
    // From POST /admin/announcements/image.
    imageKey: z
        .string()
        .regex(/^announcements\/[0-9a-f-]{36}_\d{1,5}x\d{1,5}\.jpg$/, 'is not an uploaded announcement picture')
        .optional()
        .nullable(),
    audience,
    // Later = scheduled; missing or in the past = now.
    sendAt: z.coerce
        .date({ error: 'must be a date and time' })
        .refine((d) => d.getTime() < Date.now() + MAX_SCHEDULE_DAYS * 86_400_000, `must be within ${MAX_SCHEDULE_DAYS} days`)
        .optional(),
    test: z.boolean().default(false),
});

const audienceBody = z.strictObject({ audience });

const announcementsQuery = pageQuery.extend({
    status: upper(['scheduled', 'sending', 'sent', 'cancelled', 'withdrawn']).optional(),
});

const announcementParams = z.strictObject({ announcementId: z.uuid('is not a valid announcementId') });

module.exports = {
    createAnnouncement,
    audienceBody,
    announcementsQuery,
    announcementParams,
    PREFERRED_AREAS,
    analyticsQuery, usersQuery, postsQuery, commentsQuery, searchQuery, authEventsQuery, withReason, clearProfile };
