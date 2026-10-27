const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { decodeOffset, offsetPage: page } = require('../utils/cursor');
const { CARD_SELECT, relationsFor, toCard } = require('./socialGraph');
const posts = require('./postService');

// Search for the app's Search screen: people, posts ("Activities") and hashtags.
// Matching uses Postgres pg_trgm (trigram GIN indexes on users.username/name,
// posts.title/description and hashtags.name): ILIKE '%word%' for substrings, plus the
// `%` similarity operator so small typos ("priyaa") still find people and tags.
//
// People and hashtags are ranked by relevance (exact, then prefix, then similarity,
// then popularity), so they page by offset; the cursor hides that. Posts are newest
// first with the feeds' keyset cursor, through the same visibility rule as the feeds.

// The user's text inside LIKE patterns: %, _ and \ match literally.
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// People: active accounts with no block between them and the viewer (private accounts
// are found too, as on Instagram; their content stays private). Matches username,
// name or city.
const searchUsers = async (viewerId, q, { cursor, limit }) => {
    const offset = decodeOffset(cursor);
    const term = q.toLowerCase();
    const like = `%${escapeLike(term)}%`;
    const prefix = `${escapeLike(term)}%`;

    const rows = await prisma.$queryRaw`
        SELECT u.id
        FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id
        WHERE u.status = 'ACTIVE'
          AND NOT EXISTS (
              SELECT 1 FROM blocks b
              WHERE (b.blocker_id = u.id AND b.blocked_id = ${viewerId}::uuid)
                 OR (b.blocker_id = ${viewerId}::uuid AND b.blocked_id = u.id))
          AND (u.username ILIKE ${like} OR u.name ILIKE ${like} OR p.city ILIKE ${like}
               OR u.username % ${term} OR u.name % ${term})
        ORDER BY (u.username = ${term}) DESC,
                 (u.username ILIKE ${prefix}) DESC,
                 (u.name ILIKE ${prefix}) DESC,
                 GREATEST(similarity(u.username, ${term}), similarity(u.name, ${term})) DESC,
                 u.followers_count DESC,
                 u.id
        LIMIT ${limit + 1} OFFSET ${offset}`;
    const { items, nextCursor } = page(rows, offset, limit);

    const ids = items.map((r) => r.id);
    const [users, rel] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: ids } }, select: { ...CARD_SELECT, profile: { select: { city: true } } } }),
        relationsFor(viewerId, ids),
    ]);
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
        users: ids
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map((u) => ({ ...toCard(u, viewerId, rel), city: u.profile?.city ?? null })),
        nextCursor,
    };
};

// Activities: see postService.searchPosts (newest first, keyset cursor).
const searchPosts = (viewerId, q, query) => posts.searchPosts(viewerId, q, query);

// Hashtags with at least one post: the exact tag, then tags starting with the text
// (most used first, as on Instagram), then near matches. postsCount counts every post
// with the tag; the tag's feed shows only the ones the viewer may see.
const searchHashtags = async (q, { cursor, limit }) => {
    const offset = decodeOffset(cursor);
    const term = q.toLowerCase();
    const prefix = `${escapeLike(term)}%`;
    const rows = await prisma.$queryRaw`
        SELECT name, posts_count AS "postsCount"
        FROM hashtags
        WHERE posts_count > 0 AND (name LIKE ${prefix} OR name % ${term})
        ORDER BY (name = ${term}) DESC, (name LIKE ${prefix}) DESC, posts_count DESC, similarity(name, ${term}) DESC, name
        LIMIT ${limit + 1} OFFSET ${offset}`;
    const { items, nextCursor } = page(rows, offset, limit);
    return { hashtags: items, nextCursor };
};

// A hashtag's page: the tag and its posts the viewer may see, newest first.
const hashtagPosts = async (viewerId, tag, query) => {
    const hashtag = await prisma.hashtag.findUnique({ where: { name: tag }, select: { name: true, postsCount: true } });
    if (!hashtag) throw new AppError('Hashtag not found', 404, undefined, 'HASHTAG_NOT_FOUND');
    return { hashtag, ...(await posts.hashtagFeed(viewerId, tag, query)) };
};

module.exports = { searchUsers, searchPosts, searchHashtags, hashtagPosts };
