const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const realtime = require('../lib/realtime');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const sessions = require('./sessionService');
const notifications = require('./notificationService');
const impact = require('./impactService');
const { POST_INCLUDE, toPosts } = require('./postService');
const { findComment, removeComment: deleteCommentAndReplies } = require('./commentService');
const { removeStory: deleteStory } = require('./storyService');
const { CARD_SELECT, relationsFor, toCard } = require('./socialGraph');

// Staff tools (role REVIEWER or ADMIN; suspensions and roles are ADMIN only, see
// adminRoutes). Moderators bypass the normal visibility rules: they see every post,
// private or not. Every action is written to moderation_actions with who did it and
// why, and the reports about the same target are closed with the outcome.

const notFound = (what) => new AppError(`${what} not found`, 404, undefined, `${what.toUpperCase()}_NOT_FOUND`);

const log = (tx, moderatorId, action, targetType, targetId, reason, metadata) =>
    tx.moderationAction.create({ data: { moderatorId, action, targetType, targetId, reason, metadata } });

// Closes the OPEN reports matching `where` with the given outcome.
const closeReports = (tx, moderatorId, where, status, resolution) =>
    tx.report.updateMany({
        where: { ...where, status: 'OPEN' },
        data: { status, resolution, resolvedById: moderatorId, resolvedAt: new Date() },
    });

// ---------- posts ----------

// The review queue: oldest first, so nothing waits forever. Each post carries its open
// reports (count and reasons) so reviewers see why it is there.
const listPosts = async (moderatorId, { status, cursor, limit }) => {
    const rows = await prisma.post.findMany({
        where: { status, author: { status: { not: 'PENDING_DELETION' } }, ...afterCursor(cursor, 'id', 'asc') },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: POST_INCLUDE,
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    const reports = await prisma.report.groupBy({
        by: ['postId', 'reason'],
        where: { postId: { in: items.map((p) => p.id) }, status: 'OPEN' },
        _count: { _all: true },
    });
    const shaped = await toPosts(moderatorId, items);
    return {
        posts: shaped.map((p, i) => {
            const mine = reports.filter((r) => r.postId === p.id);
            return {
                ...p,
                status: items[i].status,
                rejectionReason: items[i].rejectionReason,
                openReports: {
                    count: mine.reduce((n, r) => n + r._count._all, 0),
                    reasons: Object.fromEntries(mine.map((r) => [r.reason?.toLowerCase() ?? 'other', r._count._all])),
                },
            };
        }),
        nextCursor,
    };
};

// Approve or reject. Only a real change notifies the author ("Your … was approved"); an
// approval that completes a medal tier also sends the medal.
const reviewPost = async (moderatorId, postId, status, reason) => {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true, status: true, rejectionReason: true } });
    if (!post) throw notFound('Post');
    const rejectionReason = status === 'REJECTED' ? reason : null;
    const changed = post.status !== status || post.rejectionReason !== rejectionReason;
    const newlyApproved = status === 'APPROVED' && post.status !== 'APPROVED';

    const notificationIds = await prisma.$transaction(async (tx) => {
        // A rejected post also stops being a staff pick.
        await tx.post.update({
            where: { id: postId },
            data: { status, rejectionReason, ...(status === 'REJECTED' && { featuredAt: null }) },
            select: { id: true },
        });
        await log(tx, moderatorId, status === 'APPROVED' ? 'APPROVE_POST' : 'REJECT_POST', 'post', postId, reason);
        // Approving clears the reports (no violation); rejecting resolves them.
        await closeReports(
            tx,
            moderatorId,
            { postId },
            status === 'APPROVED' ? 'DISMISSED' : 'RESOLVED',
            status === 'APPROVED' ? 'post approved' : `post rejected: ${reason}`,
        );
        return [
            changed ? await notifications.postReviewed(tx, { ...post, status }) : null,
            newlyApproved ? await impact.checkMedal(tx, post.authorId) : null,
        ];
    });
    notifications.deliver(notificationIds);
    return { post: { id: postId, status, rejectionReason } };
};

const approvePost = (moderatorId, postId, { note } = {}) => reviewPost(moderatorId, postId, 'APPROVED', note);
const rejectPost = (moderatorId, postId, { reason }) => reviewPost(moderatorId, postId, 'REJECTED', reason);

// Staff picks for Explore's "Featured" view. Only approved posts; featuring again keeps
// the original date. Rejecting a post unfeatures it (reviewPost).
const setFeatured = async (moderatorId, postId, featured) => {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, status: true, featuredAt: true } });
    if (!post) throw notFound('Post');
    if (featured && post.status !== 'APPROVED') {
        throw new AppError('Only approved posts can be featured', 409, undefined, 'POST_NOT_APPROVED');
    }
    const featuredAt = featured ? (post.featuredAt ?? new Date()) : null;
    await prisma.$transaction(async (tx) => {
        await tx.post.update({ where: { id: postId }, data: { featuredAt }, select: { id: true } });
        if (Boolean(post.featuredAt) !== featured) await log(tx, moderatorId, featured ? 'FEATURE_POST' : 'UNFEATURE_POST', 'post', postId, null);
    });
    return { post: { id: postId, featured, featuredAt } };
};

// ---------- stories ----------

// Removes a reported story (its file too) and closes the reports about it.
const removeStory = async (moderatorId, storyId, { reason }) => {
    const story = await prisma.story.findUnique({ where: { id: storyId } });
    if (!story) throw notFound('Story');
    await prisma.$transaction(async (tx) => {
        await log(tx, moderatorId, 'DELETE_STORY', 'story', storyId, reason, { authorId: story.authorId, caption: story.caption });
        await closeReports(tx, moderatorId, { storyId }, 'RESOLVED', `story removed: ${reason}`);
    });
    await deleteStory(story);
};

// ---------- comments ----------

const removeComment = async (moderatorId, commentId, { reason }) => {
    const comment = await findComment(commentId).catch(() => {
        throw notFound('Comment');
    });
    // Before the delete: the reports keep their row (comment_id becomes NULL).
    await prisma.$transaction(async (tx) => {
        await log(tx, moderatorId, 'DELETE_COMMENT', 'comment', commentId, reason, { text: comment.text, authorId: comment.authorId, postId: comment.postId });
        await closeReports(tx, moderatorId, { commentId }, 'RESOLVED', `comment removed: ${reason}`);
    });
    await deleteCommentAndReplies(comment);
};

// ---------- users (ADMIN) ----------

const findUser = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
    if (!user) throw notFound('User');
    return user;
};

// Suspended: can't log in (403 ACCOUNT_SUSPENDED), every session and live connection
// ends now, and their profile, posts and comments disappear for everyone else.
const suspendUser = async (adminId, userId, { reason }) => {
    if (userId === adminId) throw new AppError("You can't suspend yourself", 400, undefined, 'CANNOT_TARGET_SELF');
    const user = await findUser(userId);
    if (user.role === 'ADMIN') throw new AppError('Remove the admin role first', 403, undefined, 'TARGET_IS_ADMIN');
    if (user.status === 'PENDING_DELETION') throw new AppError('This account is being deleted', 409, undefined, 'ACCOUNT_DELETING');

    await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' }, select: { id: true } });
        await sessions.revokeAllSessions(userId, 'suspended', {}, tx);
        await log(tx, adminId, 'SUSPEND_USER', 'user', userId, reason);
        await closeReports(tx, adminId, { type: 'USER', userId }, 'RESOLVED', `user suspended: ${reason}`);
    });
    realtime.disconnectUser(userId);
    return { user: { id: userId, status: 'SUSPENDED' } };
};

const unsuspendUser = async (adminId, userId, { note } = {}) => {
    const user = await findUser(userId);
    if (user.status !== 'SUSPENDED') throw new AppError('This account is not suspended', 409, undefined, 'NOT_SUSPENDED');
    await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' }, select: { id: true } });
        await log(tx, adminId, 'UNSUSPEND_USER', 'user', userId, note);
    });
    return { user: { id: userId, status: 'ACTIVE' } };
};

// USER / REVIEWER / ADMIN. Not your own (so the last admin can't lock everyone out).
const setRole = async (adminId, userId, { role }) => {
    if (userId === adminId) throw new AppError("You can't change your own role", 400, undefined, 'CANNOT_TARGET_SELF');
    const user = await findUser(userId);
    await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { role }, select: { id: true } });
        await log(tx, adminId, 'SET_ROLE', 'user', userId, null, { from: user.role, to: role });
    });
    return { user: { id: userId, role } };
};

// ---------- reports ----------

const REPORT_INCLUDE = {
    reporter: { select: CARD_SELECT },
    user: { select: { ...CARD_SELECT, status: true } },
    post: {
        select: {
            id: true,
            title: true,
            status: true,
            media: { orderBy: { position: 'asc' }, take: 1, select: { type: true, key: true, thumbnailKey: true } },
        },
    },
    comment: { select: { id: true, text: true, postId: true } },
    story: { select: { id: true, type: true, key: true, thumbnailKey: true, caption: true, expiresAt: true } },
    resolvedBy: { select: CARD_SELECT },
};

// The OPEN reports about the same thing as `report` (all reporters).
const sameTarget = (report) => {
    if (report.type === 'POST' && report.postId) return { type: 'POST', postId: report.postId };
    if (report.type === 'COMMENT' && report.commentId) return { type: 'COMMENT', commentId: report.commentId };
    if (report.type === 'STORY' && report.storyId) return { type: 'STORY', storyId: report.storyId };
    if (report.type === 'USER' && report.userId) return { type: 'USER', userId: report.userId };
    return { id: report.id }; // problem reports, or content that's gone
};

const thumb = (post) => {
    const m = post.media[0];
    return m ? storage.urlFor(m.type === 'VIDEO' ? m.thumbnailKey : m.key) : null;
};

// Oldest first (a queue). Moderators see who reported; the reported person never does.
const listReports = async (moderatorId, { status, type, cursor, limit }) => {
    const rows = await prisma.report.findMany({
        where: { status, ...(type && { type }), ...afterCursor(cursor, 'id', 'asc') },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: REPORT_INCLUDE,
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    const rel = await relationsFor(moderatorId, items.flatMap((r) => [r.reporterId, r.userId]).filter(Boolean));
    const openCounts = await Promise.all(items.map((r) => prisma.report.count({ where: { ...sameTarget(r), status: 'OPEN' } })));

    return {
        reports: items.map((r, i) => ({
            id: r.id,
            type: r.type.toLowerCase(),
            reason: r.reason?.toLowerCase() ?? null,
            category: r.category,
            details: r.details,
            deviceInfo: r.deviceInfo,
            status: r.status,
            reporter: toCard(r.reporter, moderatorId, rel),
            // Who the report is about: the reported account, or the content's author.
            user: r.user ? { ...toCard(r.user, moderatorId, rel), status: r.user.status } : null,
            post: r.post ? { id: r.post.id, title: r.post.title, status: r.post.status, thumbnailUrl: thumb(r.post) } : null,
            comment: r.comment,
            story: r.story
                ? {
                      id: r.story.id,
                      type: r.story.type.toLowerCase(),
                      url: storage.urlFor(r.story.key),
                      thumbnailUrl: storage.urlFor(r.story.thumbnailKey ?? r.story.key),
                      caption: r.story.caption,
                      expiresAt: r.story.expiresAt,
                  }
                : null,
            openReportsOnTarget: openCounts[i],
            resolution: r.resolution,
            resolvedBy: r.resolvedBy ? toCard(r.resolvedBy, moderatorId, rel) : null,
            resolvedAt: r.resolvedAt,
            createdAt: r.createdAt,
        })),
        nextCursor,
    };
};

// Closes a report (and every other open report about the same thing) with an action:
//   dismiss  no violation                      → DISMISSED
//   resolve  handled, nothing to remove        → RESOLVED (e.g. a problem report)
//   remove   reject the post / delete comment or story → RESOLVED
//   suspend  suspend the user / the author     → RESOLVED (ADMIN only)
const resolveReport = async (moderator, reportId, { action, note }) => {
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw notFound('Report');
    if (report.status !== 'OPEN') throw new AppError('This report is already closed', 409, undefined, 'REPORT_CLOSED');

    const reasonText = note || `Violates the community guidelines (${report.reason?.toLowerCase().replace(/_/g, ' ') ?? 'reported'})`;

    if (action === 'remove') {
        if (report.type === 'POST' && report.postId) await rejectPost(moderator.id, report.postId, { reason: reasonText });
        else if (report.type === 'COMMENT' && report.commentId) await removeComment(moderator.id, report.commentId, { reason: reasonText });
        else if (report.type === 'STORY' && report.storyId) await removeStory(moderator.id, report.storyId, { reason: reasonText });
        else throw new AppError('Nothing to remove for this report', 400, undefined, 'NOTHING_TO_REMOVE');
    }
    if (action === 'suspend') {
        if (moderator.role !== 'ADMIN') throw new AppError('Only admins can suspend accounts', 403, undefined, 'FORBIDDEN');
        if (!report.userId) throw new AppError('No account to suspend for this report', 400, undefined, 'NOTHING_TO_SUSPEND');
        await suspendUser(moderator.id, report.userId, { reason: reasonText });
    }

    // Whatever the action already closed, close the rest (and this one) with it.
    const status = action === 'dismiss' ? 'DISMISSED' : 'RESOLVED';
    await prisma.$transaction(async (tx) => {
        await closeReports(tx, moderator.id, sameTarget(report), status, `${action}${note ? `: ${note}` : ''}`);
        await closeReports(tx, moderator.id, { id: report.id }, status, `${action}${note ? `: ${note}` : ''}`);
        await log(tx, moderator.id, action === 'dismiss' ? 'DISMISS_REPORT' : 'RESOLVE_REPORT', 'report', report.id, note, { action });
    });
    const closed = await prisma.report.findUnique({ where: { id: reportId }, select: { id: true, status: true, resolution: true } });
    return { report: closed };
};

// ---------- audit log (ADMIN) ----------

const listActions = async ({ targetId, cursor, limit }) => {
    const rows = await prisma.moderationAction.findMany({
        where: { ...(targetId && { targetId }), ...afterCursor(cursor, 'id') },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: { moderator: { select: { id: true, username: true, name: true } } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    return {
        actions: items.map((a) => ({
            id: a.id,
            action: a.action,
            targetType: a.targetType,
            targetId: a.targetId,
            reason: a.reason,
            metadata: a.metadata,
            moderator: a.moderator, // null = automatic (report threshold)
            createdAt: a.createdAt,
        })),
        nextCursor,
    };
};

module.exports = {
    listPosts,
    approvePost,
    rejectPost,
    setFeatured,
    removeComment,
    removeStory,
    suspendUser,
    unsuspendUser,
    setRole,
    listReports,
    resolveReport,
    listActions,
};
