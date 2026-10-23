const { z } = require('zod');
const { listQuery } = require('./userValidators');

// ?q=...&cursor&limit. A leading "@" (people) or "#" (hashtags) is ignored, so the app
// can pass what the user typed.
const searchQuery = (strip) =>
    listQuery.extend({
        q: z
            .string()
            .trim()
            .transform((v) => v.replace(strip, '').trim())
            .pipe(z.string().min(1, 'type something to search for').max(100, 'must be at most 100 characters')),
    });

const userSearch = searchQuery(/^@+/);
const postSearch = searchQuery(/^#+/);
const hashtagSearch = searchQuery(/^#+/);

// Same characters as postService.extractHashtags.
const hashtagParams = z.strictObject({
    tag: z
        .string()
        .transform((v) => v.replace(/^#/, '').toLowerCase())
        .pipe(z.string().regex(/^[\p{L}\p{M}\p{N}_]{1,50}$/u, 'is not a valid hashtag')),
});

module.exports = { userSearch, postSearch, hashtagSearch, hashtagParams };
