const { z } = require('zod');
const { listQuery } = require('./userValidators');

// The API takes lower-case names (as the app shows them) and stores the enum.
const upper = (values) =>
    z.enum(values, { error: `must be one of: ${values.join(', ')}` }).transform((v) => v.toUpperCase());

const REASONS = [
    'spam',
    'nudity',
    'hate_speech',
    'harassment',
    'violence',
    'self_harm',
    'false_information',
    'scam',
    'intellectual_property',
    'fake_account',
    'other',
];

// The app's "Report a problem" categories (appSettingsContent.js REPORT_CATEGORIES).
const PROBLEM_CATEGORIES = ['bug', 'content', 'account', 'idea'];

const details = (min, max) => z.string().trim().min(min, `must be at least ${min} characters`).max(max, `must be at most ${max} characters`);

// ---------- users ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createReport = z
    .strictObject({
        type: upper(['post', 'comment', 'user']),
        // A post id, comment id, or (for users) an id or username.
        targetId: z.string().trim().min(1).max(64),
        reason: upper(REASONS),
        details: details(1, 500).optional(),
    })
    .refine((r) => r.type === 'USER' || UUID.test(r.targetId), { path: ['targetId'], message: 'is not a valid id' });

const problemReport = z.strictObject({
    category: z.enum(PROBLEM_CATEGORIES, { error: `must be one of: ${PROBLEM_CATEGORIES.join(', ')}` }),
    details: details(15, 1000),
    deviceInfo: z.string().trim().max(200).optional(),
});

// ---------- staff ----------

const id = (name) => z.strictObject({ [name]: z.uuid(`is not a valid ${name}`) });

const postQueue = listQuery.extend({
    status: upper(['under_review', 'rejected', 'approved']).default('UNDER_REVIEW'),
});

const reportQueue = listQuery.extend({
    status: upper(['open', 'resolved', 'dismissed']).default('OPEN'),
    type: upper(['post', 'comment', 'user', 'problem']).optional(),
});

const reason = (max = 300) => details(3, max);

const approvePost = z.strictObject({ note: reason().optional() }).default({});
const rejectPost = z.strictObject({ reason: reason() });
const removeComment = z.strictObject({ reason: reason() });
const suspendUser = z.strictObject({ reason: reason() });
const unsuspendUser = z.strictObject({ note: reason().optional() }).default({});
const setRole = z.strictObject({ role: upper(['user', 'reviewer', 'admin']) });

// dismiss: no violation. resolve: handled (e.g. a fixed bug). remove: reject the post /
// delete the comment. suspend: suspend the user (or the content's author); admins only.
const resolveReport = z.strictObject({
    action: z.enum(['dismiss', 'resolve', 'remove', 'suspend'], { error: 'must be one of: dismiss, resolve, remove, suspend' }),
    note: reason(500).optional(),
});

const actionsQuery = listQuery.extend({ targetId: z.uuid().optional() });

module.exports = {
    REASONS,
    createReport,
    problemReport,
    postParams: id('postId'),
    commentParams: id('commentId'),
    userParams: id('userId'),
    reportParams: id('reportId'),
    postQueue,
    reportQueue,
    approvePost,
    rejectPost,
    removeComment,
    suspendUser,
    unsuspendUser,
    setRole,
    resolveReport,
    actionsQuery,
};
