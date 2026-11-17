const { Prisma } = require('../generated/prisma');
const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const notifications = require('./notificationService');
const { getSettings, settingsFor } = require('./settingsService');
const { CARD_SELECT, findActiveUser, relationsFor, canViewActivities, toCard } = require('./socialGraph');
const { RIPPLE_BADGES, REQUIREMENTS, publicStats, meets, PLEDGE_DAYS, MAX_DEPTH, MAX_TREE_NODES } = require('../config/ripple');

// Ripple (config/ripple.js has the idea and the badges).
//
// The graph is posts.inspired_by_post_id. A user's ripple is every COUNTED post below
// any of their approved posts, found with one recursive query walking down the links.
// It is computed on read, like impact, so it can never drift from the posts. Badges are
// the exception: once earned they are stored (user_badges) and kept.
//
// Rules:
//   - A link is set only when a post is created, to a post its author can see that
//     isn't their own (checkInspiration). Links therefore always point at older posts
//     and can't form loops; MAX_DEPTH bounds the queries anyway.
//   - A post counts when it is APPROVED, its author ACTIVE and its link VERIFIED
//     (posts.ripple_status: a companion vouched, or a reviewer confirmed it). A post
//     that doesn't count also cuts off everything below it.
//   - People, not posts: ten activities by one volunteer are one person. The owner's own
//     posts never count in their own ripple.
//   - Depth: the shortest number of links from one of the owner's posts.

// postService requires this file, so it is loaded lazily (a require cycle otherwise).
const postService = () => require('./postService');

const DAY_MS = 24 * 60 * 60 * 1000;
const pledgeCutoff = () => new Date(Date.now() - PLEDGE_DAYS * DAY_MS);

// ---------- the recursive walk ----------

// A linked post `c` (author `cu`) that counts in the ripples above it.
const COUNTED = Prisma.sql`c.status = 'APPROVED' AND c.ripple_status = 'VERIFIED' AND cu.status = 'ACTIVE'`;

// `WITH RECURSIVE tree(id, author_id, parent_id, location, created_at, depth, root_id)`:
// every counted post below the root posts chosen by `rootWhere` (a condition on `s`),
// with the root post it hangs from. A post can be reached by several paths (when the
// owner's own post sits inside the chain), so callers take min(depth) per post.
const descendants = (rootWhere, maxDepth) => Prisma.sql`
    WITH RECURSIVE tree AS (
        SELECT c.id, c.author_id, c.inspired_by_post_id AS parent_id, c.location, c.created_at, 1 AS depth, s.id AS root_id
        FROM posts s
        JOIN posts c ON c.inspired_by_post_id = s.id
        JOIN users cu ON cu.id = c.author_id
        WHERE ${rootWhere} AND s.status = 'APPROVED' AND ${COUNTED}
        UNION ALL
        SELECT c.id, c.author_id, c.inspired_by_post_id, c.location, c.created_at, t.depth + 1, t.root_id
        FROM tree t
        JOIN posts c ON c.inspired_by_post_id = t.id
        JOIN users cu ON cu.id = c.author_id
        WHERE t.depth < ${maxDepth} AND ${COUNTED}
    )`;

const ofUser = (userId) => Prisma.sql`s.author_id = ${userId}::uuid`;
const ofPost = (postId) => Prisma.sql`s.id = ${postId}::uuid`;

// { people, depth, cities, hometown, bestPost } below the roots, leaving out `ownerId`'s
// own posts (config/ripple.js says what each means). Cities are counted like Explore's
// stats: the first part of the location, only for authors who show their location;
// hometown compares that city with the owner's profile city. Responses show only the
// first three (publicStats).
const statsBelow = async (rootWhere, ownerId, db = prisma) => {
    const [row] = await db.$queryRaw`${descendants(rootWhere, MAX_DEPTH)},
        nodes AS (
            SELECT id, author_id, lower(trim(split_part(location, ',', 1))) AS city, min(depth) AS depth
            FROM tree GROUP BY id, author_id, location
        ),
        home AS (SELECT lower(trim(city)) AS city FROM profiles WHERE user_id = ${ownerId}::uuid AND trim(coalesce(city, '')) <> ''),
        per_root AS (SELECT count(DISTINCT author_id) AS n FROM tree WHERE author_id <> ${ownerId}::uuid GROUP BY root_id)
        SELECT count(DISTINCT n.author_id)::int AS people,
               COALESCE(max(n.depth), 0)::int AS depth,
               count(DISTINCT n.city) FILTER (WHERE u.show_location AND n.city <> '')::int AS cities,
               count(DISTINCT n.author_id) FILTER (WHERE u.show_location AND n.depth >= 2 AND n.city = (SELECT city FROM home))::int AS hometown,
               COALESCE((SELECT max(n) FROM per_root), 0)::int AS "bestPost"
        FROM nodes n JOIN users u ON u.id = n.author_id
        WHERE n.author_id <> ${ownerId}::uuid`;
    return row;
};

const statsFor = (userId, db = prisma) => statsBelow(ofUser(userId), userId, db);

// ---------- badges ----------

// Every badge with whether it is earned, and the next one to aim for (the first visible
// one not yet earned, with what is still missing). A hidden badge not yet earned shows
// only its hint.
const badgesFor = (stats, earnedRows) => {
    const earnedAt = new Map(earnedRows.map((b) => [b.badgeId, b.earnedAt]));
    const badges = RIPPLE_BADGES.map((b) => {
        const earned = earnedAt.has(b.id);
        const hidden = Boolean(b.hidden);
        if (hidden && !earned) {
            return { id: b.id, hidden, hint: b.hint, label: null, description: null, requires: null, earned, earnedAt: null };
        }
        return {
            id: b.id,
            hidden,
            label: b.label,
            description: b.description,
            requires: Object.fromEntries(REQUIREMENTS.filter((k) => b[k]).map((k) => [k, b[k]])),
            earned,
            earnedAt: earnedAt.get(b.id) ?? null,
        };
    });
    const next = badges.find((b) => !b.earned && !b.hidden);
    return {
        badges,
        next: next
            ? {
                  id: next.id,
                  label: next.label,
                  remaining: Object.fromEntries(Object.entries(next.requires).map(([k, need]) => [k, Math.max(0, need - stats[k])])),
              }
            : null,
    };
};

// Stores every badge `userId` now qualifies for and hasn't got yet, each with one
// notification. Returns the new notification ids.
const awardBadges = async (tx, userId) => {
    const stats = await statsFor(userId, tx);
    const ids = [];
    for (const badge of RIPPLE_BADGES.filter((b) => meets(b, stats))) {
        const { count } = await tx.userBadge.createMany({ data: [{ userId, badgeId: badge.id }], skipDuplicates: true });
        if (count) ids.push(await notifications.badgeEarned(tx, userId, badge.id));
    }
    return ids;
};

// Call inside the transaction where `post` ({ id, authorId, inspiredById }) starts to
// count (countIfReady). Tells the author of the
// inspiring post ("Aarav did it", once per post) and gives badges to everyone up the
// chain whose ripple just grew. Returns notification ids for deliver().
const onCounted = async (tx, post) => {
    if (!post.inspiredById) return [];
    const source = await tx.post.findUnique({ where: { id: post.inspiredById }, select: { authorId: true } });
    if (!source) return [];
    const ids = [await notifications.rippled(tx, post, source.authorId)];

    const ancestors = await tx.$queryRaw`
        WITH RECURSIVE up AS (
            SELECT id, author_id, inspired_by_post_id, 1 AS steps FROM posts WHERE id = ${post.inspiredById}::uuid
            UNION ALL
            SELECT p.id, p.author_id, p.inspired_by_post_id, up.steps + 1
            FROM up JOIN posts p ON p.id = up.inspired_by_post_id
            WHERE up.steps < ${MAX_DEPTH}
        )
        SELECT DISTINCT author_id AS "userId" FROM up WHERE author_id <> ${post.authorId}::uuid`;
    for (const { userId } of ancestors) ids.push(...(await awardBadges(tx, userId)));
    return ids;
};

// Inside a transaction that may have made `postId` count: approved by a reviewer, or
// its link verified (a vouch or a reviewer). Whichever of the two comes second grows
// the ripples above it. Calling it twice is harmless (notifications and badges dedupe).
const countIfReady = async (tx, postId) => {
    const post = await tx.post.findUnique({
        where: { id: postId },
        select: { id: true, authorId: true, inspiredById: true, status: true, rippleStatus: true, author: { select: { status: true } } },
    });
    if (!post?.inspiredById || post.status !== 'APPROVED' || post.rippleStatus !== 'VERIFIED' || post.author.status !== 'ACTIVE') return [];
    return onCounted(tx, post);
};

// The authors of `postId` and every post above it: everyone whose ripple a post linked
// below `postId` would grow.
const chainAuthors = async (postId) => {
    const rows = await prisma.$queryRaw`
        WITH RECURSIVE up AS (
            SELECT id, author_id, inspired_by_post_id, 1 AS steps FROM posts WHERE id = ${postId}::uuid
            UNION ALL
            SELECT p.id, p.author_id, p.inspired_by_post_id, up.steps + 1
            FROM up JOIN posts p ON p.id = up.inspired_by_post_id
            WHERE up.steps < ${MAX_DEPTH}
        )
        SELECT DISTINCT author_id AS "userId" FROM up`;
    return new Set(rows.map((r) => r.userId));
};

// ---------- linking a new post ----------

const badInspiration = (message, code) =>
    new AppError(message, 400, [{ field: 'inspiredByPostId', message }], code);

// Before creating a post with inspiredByPostId: the author must be able to see that post
// (approved, not blocked, visible to them) and it can't be their own.
const checkInspiration = async (authorId, sourceId) => {
    let source;
    try {
        source = await postService().findVisiblePost(authorId, sourceId);
    } catch (err) {
        if (err instanceof AppError) throw badInspiration('The activity that inspired you is not available', 'INSPIRATION_NOT_FOUND');
        throw err;
    }
    if (source.authorId === authorId) throw badInspiration("An activity can't be inspired by your own post", 'OWN_INSPIRATION');
};

// Inside createPost's transaction: an open (or even expired) pledge on the source post
// is now done.
const fulfillPledge = (tx, userId, sourceId, postId) =>
    tx.pledge.updateMany({ where: { userId, postId: sourceId, fulfilledPostId: null }, data: { fulfilledPostId: postId } });

// ---------- companions: "who was with you" ----------

const badCompanion = (message, code) => new AppError(message, 400, [{ field: 'companions', message }], code);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Before creating an inspired post that names companions (ids or usernames). Returns
// their user ids. Each companion must:
//   - exist and be active, and not be blocked either way (else "not found", so a block
//     isn't revealed);
//   - not be anyone up the inspiration chain: they would be vouching for their own
//     ripple, so the vouch has to come from someone who gains nothing from it;
//   - allow the author to tag them (their whoCanTag setting);
//   - be able to see the author's activities, or they couldn't open the post to vouch.
const checkCompanions = async (author, sourceId, refs) => {
    const wanted = [...new Set(refs.map((r) => r.replace(/^@/, '').toLowerCase()))];
    const users = await prisma.user.findMany({
        where: { status: 'ACTIVE', OR: [{ id: { in: wanted.filter((r) => UUID.test(r)) } }, { username: { in: wanted.filter((r) => !UUID.test(r)) } }] },
        select: { id: true, username: true },
    });
    const [rel, prefsOf, chain] = await Promise.all([
        relationsFor(author.id, users.map((u) => u.id)),
        settingsFor(users.map((u) => u.id)),
        chainAuthors(sourceId),
    ]);

    const ids = new Set();
    for (const ref of wanted) {
        const user = users.find((u) => u.id === ref || u.username === ref);
        const relation = user && rel(user.id);
        if (!user || relation.blockedByMe || relation.blocksMe) throw badCompanion(`We couldn't find "${ref}"`, 'COMPANION_NOT_FOUND');
        if (user.id === author.id) throw badCompanion("You can't vouch for yourself", 'COMPANION_SELF');
        if (chain.has(user.id)) {
            throw badCompanion(`@${user.username} is part of the ripple this activity grows, so they can't vouch for it`, 'COMPANION_IN_CHAIN');
        }
        const tagging = prefsOf(user.id).whoCanTag;
        if (tagging === 'none' || (tagging === 'following' && !relation.followsYou)) {
            throw badCompanion(`@${user.username} doesn't allow you to tag them`, 'COMPANION_TAGS_OFF');
        }
        // The companion's view of the author: they follow the author when followsYou.
        const theirView = { followStatus: relation.followsYou ? 'following' : 'none', blockedByMe: false, blocksMe: false };
        if (!canViewActivities(user.id, author, theirView)) {
            throw badCompanion(`@${user.username} can't see your activities, so they couldn't vouch`, 'COMPANION_CANT_SEE');
        }
        ids.add(user.id);
    }
    return [...ids];
};

// Inside createPost's transaction: one vouch request per companion. Returns the
// notification ids for deliver().
const addCompanions = async (tx, post, userIds) => {
    if (userIds.length === 0) return [];
    await tx.postCompanion.createMany({ data: userIds.map((userId) => ({ postId: post.id, userId })) });
    const ids = [];
    for (const userId of userIds) ids.push(await notifications.vouchRequested(tx, post, userId));
    return ids;
};

// A companion answers "were you there?" (answer: 'confirm' | 'decline'). Answers are
// final. The first confirmation verifies a PENDING link; a reviewer's REJECTED stands.
const vouch = async (userId, postId, answer) => {
    const post = await postService().findVisiblePost(userId, postId);
    const row = await prisma.postCompanion.findUnique({ where: { postId_userId: { postId, userId } }, select: { status: true } });
    if (!row) throw new AppError("You weren't named on this activity", 404, undefined, 'VOUCH_NOT_FOUND');
    const status = answer === 'confirm' ? 'CONFIRMED' : 'DECLINED';

    const { ids, changed } = await prisma.$transaction(async (tx) => {
        // updateMany on PENDING: two taps at once can't both answer.
        const { count } = await tx.postCompanion.updateMany({
            where: { postId, userId, status: 'PENDING' },
            data: { status, respondedAt: new Date() },
        });
        if (!count) throw new AppError('You already answered', 409, undefined, 'VOUCH_ANSWERED');
        const removed = await notifications.vouchAnswered(tx, userId, postId);
        if (status === 'DECLINED') return { ids: [], changed: removed };

        const created = [await notifications.vouched(tx, userId, post)];
        const verified = await tx.post.updateMany({
            where: { id: postId, inspiredById: { not: null }, rippleStatus: 'PENDING' },
            data: { rippleStatus: 'VERIFIED', rippleVerifiedAt: new Date(), rippleVerifiedById: userId },
        });
        if (verified.count) created.push(...(await countIfReady(tx, postId)));
        return { ids: created, changed: removed };
    });
    notifications.syncCount(changed);
    notifications.deliver(ids);
    const { rippleStatus } = await prisma.post.findUnique({ where: { id: postId }, select: { rippleStatus: true } });
    return { vouch: status.toLowerCase(), rippleStatus: rippleStatus?.toLowerCase() ?? null };
};

// "Vouch requests": posts that name the user and wait for an answer, newest first,
// for posts the user can see.
const myVouchRequests = async (userId, { cursor, limit }) => {
    const { visibleTo, POST_INCLUDE, toPosts } = postService();
    const rows = await prisma.postCompanion.findMany({
        where: { userId, status: 'PENDING', post: visibleTo(userId), ...afterCursor(cursor, 'postId') },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, postId: true, post: { include: POST_INCLUDE } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'postId');
    const posts = await toPosts(userId, items.map((r) => r.post));
    return { requests: items.map((r, i) => ({ post: posts[i], askedAt: r.createdAt })), nextCursor };
};

// The author asks a reviewer to confirm the link (nobody who was there can vouch).
// Asking again keeps the first date, so the queue stays fair.
const requestReview = async (userId, postId) => {
    const post = await prisma.post.findUnique({
        where: { id: postId },
        select: { authorId: true, inspiredById: true, rippleStatus: true, rippleReviewRequestedAt: true },
    });
    if (!post || post.authorId !== userId) throw new AppError('Post not found', 404, undefined, 'POST_NOT_FOUND');
    if (!post.inspiredById) throw new AppError('This activity has no inspiration to confirm', 400, undefined, 'NOT_INSPIRED');
    if (post.rippleStatus !== 'PENDING') {
        throw new AppError('This activity was already confirmed or reviewed', 409, undefined, 'RIPPLE_ALREADY_REVIEWED');
    }
    const requestedAt = post.rippleReviewRequestedAt ?? new Date();
    if (!post.rippleReviewRequestedAt) {
        await prisma.post.update({ where: { id: postId }, data: { rippleReviewRequestedAt: requestedAt }, select: { id: true } });
    }
    return { rippleStatus: 'pending', reviewRequestedAt: requestedAt };
};

// ---------- reviewers (moderationService calls these) ----------

// The queue: pending links whose author asked for a review (all = every pending link),
// oldest first. Each carries the source post and every companion's answer, which
// reviewers see whatever the privacy settings.
const reviewQueue = async (moderatorId, { all, cursor, limit }) => {
    const { POST_INCLUDE, toPosts } = postService();
    const rows = await prisma.post.findMany({
        where: {
            inspiredById: { not: null },
            rippleStatus: 'PENDING',
            ...(!all && { rippleReviewRequestedAt: { not: null } }),
            author: { status: { not: 'PENDING_DELETION' } },
            ...afterCursor(cursor, 'id', 'asc'),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: {
            ...POST_INCLUDE,
            inspiredBy: { select: { id: true, title: true, author: { select: CARD_SELECT } } },
            companions: { orderBy: { createdAt: 'asc' }, select: { status: true, respondedAt: true, user: { select: CARD_SELECT } } },
        },
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    const people = items.flatMap((p) => [p.inspiredBy.author.id, ...p.companions.map((c) => c.user.id)]);
    const [shaped, rel] = await Promise.all([toPosts(moderatorId, items), relationsFor(moderatorId, people)]);
    return {
        posts: shaped.map((p, i) => {
            const row = items[i];
            return {
                ...p,
                status: row.status,
                reviewRequestedAt: row.rippleReviewRequestedAt,
                source: { id: row.inspiredBy.id, title: row.inspiredBy.title, author: toCard(row.inspiredBy.author, moderatorId, rel) },
                companions: row.companions.map((c) => ({ user: toCard(c.user, moderatorId, rel), status: c.status.toLowerCase(), respondedAt: c.respondedAt })),
            };
        }),
        nextCursor,
    };
};

// A reviewer verifies or rejects a link (decision: 'VERIFIED' | 'REJECTED'), inside the
// moderation transaction `tx`. `post` = { id, authorId, rippleStatus, rippleRejectionReason }.
// A reviewer can overturn an earlier answer: rejecting a verified link takes it out of
// the ripples (badges already earned are kept, D69). Returns { changed, ids }.
const review = async (tx, moderatorId, post, decision, reason) => {
    const rejectionReason = decision === 'REJECTED' ? reason : null;
    const changed = post.rippleStatus !== decision || post.rippleRejectionReason !== rejectionReason;
    await tx.post.update({
        where: { id: post.id },
        data: {
            rippleStatus: decision,
            rippleRejectionReason: rejectionReason,
            ...(decision === 'VERIFIED' && post.rippleStatus !== 'VERIFIED' && { rippleVerifiedAt: new Date(), rippleVerifiedById: moderatorId }),
        },
        select: { id: true },
    });
    const ids = changed ? [await notifications.rippleReviewed(tx, post)] : [];
    if (decision === 'VERIFIED') ids.push(...(await countIfReady(tx, post.id)));
    return { changed, ids };
};

// ---------- pledges ("I'll do this too") ----------

const pledge = async (viewerId, postId) => {
    const post = await postService().findVisiblePost(viewerId, postId);
    if (post.authorId === viewerId) throw new AppError("You can't pledge on your own activity", 400, undefined, 'OWN_POST');
    const id = await prisma.$transaction(async (tx) => {
        // An expired, unfulfilled pledge is renewed (its 60 days start again).
        await tx.pledge.deleteMany({ where: { userId: viewerId, postId, fulfilledPostId: null, createdAt: { lt: pledgeCutoff() } } });
        const { count } = await tx.pledge.createMany({ data: [{ userId: viewerId, postId }], skipDuplicates: true });
        return count ? notifications.pledged(tx, viewerId, post) : null;
    });
    notifications.deliver(id);
    return { pledged: true, pledgesCount: await countPledges(postId) };
};

// A fulfilled pledge stays: it is the record of what the pledge led to.
const unpledge = async (viewerId, postId) => {
    const post = await postService().findVisiblePost(viewerId, postId);
    const changed = await prisma.$transaction(async (tx) => {
        const row = await tx.pledge.findUnique({ where: { userId_postId: { userId: viewerId, postId } }, select: { fulfilledPostId: true } });
        if (row?.fulfilledPostId) throw new AppError('You already did this activity', 409, undefined, 'PLEDGE_FULFILLED');
        if (!row) return [];
        await tx.pledge.delete({ where: { userId_postId: { userId: viewerId, postId } } });
        return notifications.unpledged(tx, viewerId, post);
    });
    notifications.syncCount(changed);
    return { pledged: false, pledgesCount: await countPledges(postId) };
};

// Open (not expired) or fulfilled pledges by active accounts.
const livePledges = () => ({ user: { status: 'ACTIVE' }, OR: [{ fulfilledPostId: { not: null } }, { createdAt: { gte: pledgeCutoff() } }] });

const countPledges = (postId) => prisma.pledge.count({ where: { postId, ...livePledges() } });

// "My pledges": open ones, newest first, for posts the user can still see.
const myPledges = async (userId, { cursor, limit }) => {
    const { visibleTo, POST_INCLUDE, toPosts } = postService();
    const rows = await prisma.pledge.findMany({
        where: { userId, fulfilledPostId: null, createdAt: { gte: pledgeCutoff() }, post: visibleTo(userId), ...afterCursor(cursor, 'postId') },
        orderBy: [{ createdAt: 'desc' }, { postId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, postId: true, post: { include: POST_INCLUDE } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'postId');
    const posts = await toPosts(userId, items.map((r) => r.post));
    return {
        pledges: items.map((r, i) => ({
            post: posts[i],
            pledgedAt: r.createdAt,
            expiresAt: new Date(r.createdAt.getTime() + PLEDGE_DAYS * DAY_MS),
        })),
        nextCursor,
    };
};

// ---------- what every post response carries (postService.toPosts) ----------

// Returns facts(post) → { inspiredBy, inspiredCount, pledgesCount, myPledge, rippleStatus,
// companions, myVouch, reviewRequestedAt }:
//   inspiredBy     null (no link), { hidden: true } (the viewer can't see the source),
//                  or { hidden: false, id, title, author }
//   inspiredCount  people this post directly inspired (counted posts, not the author)
//   myPledge       null | 'open' | 'fulfilled' (an expired pledge is null)
//   rippleStatus   null (no link) | 'pending' | 'verified' | 'rejected'
//   companions     [{ user, status }]: the author sees everyone they named with their
//                  answer; others see only those who confirmed ("with Meera")
//   myVouch        the viewer's own answer when they were named: null | 'pending' |
//                  'confirmed' | 'declined'
//   reviewRequestedAt  the author only: when they asked a reviewer to confirm
const postFacts = async (viewerId, posts) => {
    const ids = posts.map((p) => p.id);
    const sourceIds = [...new Set(posts.map((p) => p.inspiredById).filter(Boolean))];
    const linkedIds = posts.filter((p) => p.inspiredById).map((p) => p.id);
    const [inspired, pledgeCounts, mine, sources, companionRows] = await Promise.all([
        prisma.$queryRaw`
            SELECT c.inspired_by_post_id AS id, count(DISTINCT c.author_id)::int AS n
            FROM posts c
            JOIN posts s ON s.id = c.inspired_by_post_id
            JOIN users cu ON cu.id = c.author_id
            WHERE c.inspired_by_post_id = ANY(${ids}::uuid[])
              AND ${COUNTED} AND c.author_id <> s.author_id
            GROUP BY c.inspired_by_post_id`,
        prisma.pledge.groupBy({ by: ['postId'], where: { postId: { in: ids }, ...livePledges() }, _count: { _all: true } }),
        prisma.pledge.findMany({ where: { userId: viewerId, postId: { in: ids } }, select: { postId: true, fulfilledPostId: true, createdAt: true } }),
        sourceIds.length
            ? prisma.post.findMany({
                  where: { AND: [{ id: { in: sourceIds } }, postService().visibleTo(viewerId)] },
                  select: { id: true, title: true, author: { select: CARD_SELECT } },
              })
            : [],
        linkedIds.length
            ? prisma.postCompanion.findMany({
                  where: { postId: { in: linkedIds }, user: { status: 'ACTIVE' } },
                  orderBy: { createdAt: 'asc' },
                  select: { postId: true, status: true, user: { select: CARD_SELECT } },
              })
            : [],
    ]);
    const rel = await relationsFor(viewerId, [...sources.map((s) => s.author.id), ...companionRows.map((c) => c.user.id)]);
    const inspiredCount = new Map(inspired.map((r) => [r.id, r.n]));
    const pledgesCount = new Map(pledgeCounts.map((r) => [r.postId, r._count._all]));
    const myPledge = new Map(mine.map((r) => [r.postId, r]));
    const source = new Map(sources.map((s) => [s.id, s]));
    const cutoff = pledgeCutoff();
    const companionsOf = (postId) => companionRows.filter((c) => c.postId === postId);

    return (p) => {
        const s = p.inspiredById && source.get(p.inspiredById);
        const pledgeRow = myPledge.get(p.id);
        const isMine = p.authorId === viewerId;
        const named = p.inspiredById ? companionsOf(p.id) : [];
        const shown = named.filter((c) => {
            if (isMine) return true;
            const r = rel(c.user.id);
            return c.status === 'CONFIRMED' && !r.blockedByMe && !r.blocksMe;
        });
        const mineAsCompanion = named.find((c) => c.user.id === viewerId);
        return {
            inspiredBy: !p.inspiredById ? null : s ? { hidden: false, id: s.id, title: s.title, author: toCard(s.author, viewerId, rel) } : { hidden: true },
            inspiredCount: inspiredCount.get(p.id) ?? 0,
            pledgesCount: pledgesCount.get(p.id) ?? 0,
            myPledge: !pledgeRow ? null : pledgeRow.fulfilledPostId ? 'fulfilled' : pledgeRow.createdAt >= cutoff ? 'open' : null,
            rippleStatus: p.inspiredById ? (p.rippleStatus?.toLowerCase() ?? null) : null,
            companions: shown.map((c) => ({ user: toCard(c.user, viewerId, rel), status: c.status.toLowerCase() })),
            myVouch: mineAsCompanion ? mineAsCompanion.status.toLowerCase() : null,
            reviewRequestedAt: isMine && p.inspiredById ? (p.rippleReviewRequestedAt ?? null) : null,
        };
    };
};

// ---------- reading a ripple ----------

// Who may see a user's ripple: the same rule as impact stats (public numbers, unless
// the owner turned showImpactStats off; nothing across a block).
const findRippleOwner = async (viewerId, idOrUsername) => {
    const user = await findActiveUser(idOrUsername, { viewerId, select: CARD_SELECT });
    if (user.id === viewerId) return user;
    const relation = (await relationsFor(viewerId, [user.id]))(user.id);
    if (relation.blockedByMe) throw new AppError('Unblock this account to see it', 403, undefined, 'USER_BLOCKED');
    if (!(await getSettings(user.id)).showImpactStats) {
        throw new AppError('This volunteer keeps their impact stats private', 403, undefined, 'IMPACT_HIDDEN');
    }
    return user;
};

const earnedBadges = (userId) =>
    prisma.userBadge.findMany({ where: { userId }, orderBy: { earnedAt: 'asc' }, select: { badgeId: true, earnedAt: true } });

// The short form on every profile: numbers + earned badge ids.
const summaryFor = async (userId) => {
    const [stats, earned] = await Promise.all([statsFor(userId), earnedBadges(userId)]);
    return { ...publicStats(stats), badges: earned.map((b) => b.badgeId) };
};

const getRipple = async (viewerId, idOrUsername) => {
    const user = await findRippleOwner(viewerId, idOrUsername);
    const [stats, earned] = await Promise.all([statsFor(user.id), earnedBadges(user.id)]);
    return { ripple: { ...publicStats(stats), ...badgesFor(stats, earned) } };
};

// The tree's nodes, breadth first (by depth, then oldest first), at most MAX_TREE_NODES.
// Each node is a post: depth 1 hangs from the root (the user, or the post), deeper ones
// from parentPostId. Posts the viewer can't see (private account, blocked, followers
// only) keep their place as { hidden: true } with no title or person: the count stays
// honest without showing who.
const treeOf = async (viewerId, rootWhere, ownerId, depth) => {
    const rows = await prisma.$queryRaw`${descendants(rootWhere, depth)}
        SELECT id, author_id AS "authorId", parent_id AS "parentId", min(depth)::int AS depth, created_at AS "createdAt"
        FROM tree
        WHERE author_id <> ${ownerId}::uuid
        GROUP BY id, author_id, parent_id, created_at
        ORDER BY depth, created_at, id
        LIMIT ${MAX_TREE_NODES + 1}`;
    const truncated = rows.length > MAX_TREE_NODES;
    const nodes = rows.slice(0, MAX_TREE_NODES);

    const visible = await prisma.post.findMany({
        where: { AND: [{ id: { in: nodes.map((n) => n.id) } }, postService().visibleTo(viewerId)] },
        select: {
            id: true,
            title: true,
            category: true,
            createdAt: true,
            author: { select: CARD_SELECT },
            media: { orderBy: { position: 'asc' }, take: 1, select: { type: true, key: true, thumbnailKey: true } },
        },
    });
    const byId = new Map(visible.map((p) => [p.id, p]));
    const rel = await relationsFor(viewerId, visible.map((p) => p.author.id));
    const thumb = (m) => (m ? storage.urlFor(m.type === 'VIDEO' ? m.thumbnailKey : m.key) : null);

    return {
        nodes: nodes.map((n) => {
            const p = byId.get(n.id);
            const base = { postId: n.id, parentPostId: n.depth === 1 ? null : n.parentId, depth: n.depth };
            if (!p) return { ...base, hidden: true, post: null, author: null };
            return {
                ...base,
                hidden: false,
                post: { id: p.id, title: p.title, category: p.category, thumbnailUrl: thumb(p.media[0]), createdAt: p.createdAt },
                author: toCard(p.author, viewerId, rel),
            };
        }),
        truncated,
    };
};

const getRippleTree = async (viewerId, idOrUsername, { depth }) => {
    const user = await findRippleOwner(viewerId, idOrUsername);
    const rel = await relationsFor(viewerId, [user.id]);
    const [stats, tree] = await Promise.all([statsFor(user.id), treeOf(viewerId, ofUser(user.id), user.id, depth)]);
    return { root: { type: 'user', user: toCard(user, viewerId, rel) }, stats: publicStats(stats), ...tree };
};

// One post's ripple: what that activity set in motion.
const getPostRipple = async (viewerId, postId, { depth }) => {
    const post = await postService().findVisiblePost(viewerId, postId);
    const [stats, tree] = await Promise.all([statsBelow(ofPost(post.id), post.authorId), treeOf(viewerId, ofPost(post.id), post.authorId, depth)]);
    return { root: { type: 'post', postId: post.id }, stats: publicStats(stats), ...tree };
};

module.exports = {
    statsFor,
    summaryFor,
    onCounted,
    countIfReady,
    checkInspiration,
    checkCompanions,
    addCompanions,
    vouch,
    myVouchRequests,
    requestReview,
    reviewQueue,
    review,
    fulfillPledge,
    pledge,
    unpledge,
    myPledges,
    postFacts,
    getRipple,
    getRippleTree,
    getPostRipple,
};
