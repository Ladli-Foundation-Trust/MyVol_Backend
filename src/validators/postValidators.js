const { z } = require('zod');
const env = require('../config/env');
const { listQuery } = require('./userValidators');
const { MAX_COMPANIONS } = require('../config/ripple');

// Matches the app (MyVolApp src/data/filterOptions.js CATEGORY_FILTERS, ActivityForm limits).
const CATEGORIES = [
    'Health',
    'Animal Welfare',
    'Hunger & Poverty',
    'Drug Prevention',
    'Education',
    'Gender Equality',
    'Youth & Sports',
    'Child Rights',
    'Environment',
];

// The profile's preferredAreas (userValidators.PREFERRED_AREAS) as post categories, for
// the "recommended" home feed (postService.homeFeed).
const AREA_CATEGORIES = {
    'Environmental Conservation': ['Environment'],
    Education: ['Education', 'Child Rights'],
    Healthcare: ['Health', 'Drug Prevention'],
    'Animal Welfare': ['Animal Welfare'],
    'Community Development': ['Hunger & Poverty', 'Gender Equality', 'Youth & Sports'],
    'Disaster Relief': ['Hunger & Poverty', 'Health'],
};

const FEED_SORTS = ['recommended', 'latest', 'following'];
const EXPLORE_VIEWS = ['all', 'near', 'featured', 'videos'];

const clearableText = (max) =>
    z
        .string()
        .trim()
        .max(max, `must be at most ${max} characters`)
        .nullable()
        .transform((v) => v || null);

// z.coerce: multipart form fields arrive as strings ("12"), JSON bodies as numbers.
const count = (max) => z.coerce.number().int('must be a whole number').min(0).max(max);

const postFields = {
    title: z.string().trim().min(1, 'is required').max(60, 'must be at most 60 characters'),
    description: clearableText(500),
    location: clearableText(100),
    category: z.enum(CATEGORIES, { error: `must be one of: ${CATEGORIES.join(', ')}` }),
    beneficiaries: count(1_000_000),
    hours: count(24),
};

// Sent as multipart/form-data (with photos in "media") or as JSON (text-only post).
// Only title and category are required, as in the app's form.
// "Who was with you" on an inspired post: user ids or usernames. Multipart sends one
// field, so a comma-separated string (or a JSON array string) is accepted too.
const companionList = z.preprocess(
    (v) => {
        if (typeof v !== 'string') return v;
        const text = v.trim();
        if (text.startsWith('[')) {
            try {
                return JSON.parse(text);
            } catch {
                return v;
            }
        }
        return text ? text.split(',') : [];
    },
    z
        .array(z.string().trim().min(1, 'is empty').max(64, 'is too long'), { error: 'must be a list of usernames or user ids' })
        .max(MAX_COMPANIONS, `can name at most ${MAX_COMPANIONS} people`),
);

const createPost = z.strictObject({
    ...postFields,
    description: postFields.description.optional(),
    location: postFields.location.optional(),
    beneficiaries: postFields.beneficiaries.default(0),
    hours: postFields.hours.default(0),
    // Ripple: the post that inspired this activity (set at creation only, never edited).
    inspiredByPostId: z.uuid('is not a valid post id').optional(),
    // People who were there and can vouch that it happened (inspired posts only).
    companions: companionList.optional(),
}).refine((p) => !p.companions?.length || p.inspiredByPostId, {
    path: ['companions'],
    message: 'can only be named on an activity inspired by another post',
});

// POST /posts/:id/vouch: a companion's answer to "were you there?".
const vouch = z.strictObject({
    answer: z.enum(['confirm', 'decline'], { error: 'must be confirm or decline' }),
});

// GET …/ripple/tree, GET /posts/:id/ripple: how many levels to return.
const rippleTreeQuery = z.object({
    depth: z.coerce.number().int().min(1).max(5).default(3),
});

const updatePost = z
    .strictObject(postFields)
    .partial()
    .refine((d) => Object.keys(d).length > 0, 'send at least one field to update');

const postParams = z.strictObject({ postId: z.uuid('is not a valid post id') });

// watchMs: how long this play lasted; capped at the longest allowed video.
const recordView = z
    .strictObject({ watchMs: z.coerce.number().int().min(0).max(env.MAX_VIDEO_SECONDS * 1000).default(0) })
    .default({ watchMs: 0 });

const commentParams = z.strictObject({ commentId: z.uuid('is not a valid comment id') });

const addComment = z.strictObject({
    text: z.string().trim().min(1, 'is required').max(1000, 'must be at most 1000 characters'),
    parentId: z.uuid('is not a valid comment id').optional(),
});

// ?category=Health,Education&city=Mumbai&view=all|near|featured|videos (the app's quick
// filters: All / Near You / Featured / Videos).
const exploreQuery = listQuery.extend({
    category: z
        .string()
        .optional()
        .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
        .pipe(z.array(z.enum(CATEGORIES, { error: `must be one of: ${CATEGORIES.join(', ')}` })).optional()),
    city: z.string().trim().min(1).max(60).optional(),
    view: z.enum(EXPLORE_VIEWS, { error: `must be one of: ${EXPLORE_VIEWS.join(', ')}` }).default('all'),
});

// ?sort= overrides the feedSort setting for one request.
const feedQuery = listQuery.extend({
    sort: z.enum(FEED_SORTS, { error: `must be one of: ${FEED_SORTS.join(', ')}` }).optional(),
});

// Trending: the most engaged public activities of the last `days` days.
const trendingQuery = listQuery.extend({
    days: z.coerce.number().int().min(1).max(30).default(7),
    limit: z.coerce.number().int().min(1).max(50).default(10),
});

// ?hidden=true: the post author's "Hidden comments" list (hideOffensiveComments).
const commentListQuery = listQuery.extend({
    hidden: z.stringbool({ error: 'must be true or false' }).default(false),
});

module.exports = {
    CATEGORIES,
    AREA_CATEGORIES,
    createPost,
    updatePost,
    postParams,
    commentParams,
    addComment,
    exploreQuery,
    feedQuery,
    trendingQuery,
    commentListQuery,
    recordView,
    rippleTreeQuery,
    vouch,
};
