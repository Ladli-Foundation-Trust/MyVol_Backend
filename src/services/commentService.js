const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const { CARD_SELECT, notBlockedWith, relationsFor, toCard } = require('./socialGraph');
const { findVisiblePost, commentAllowed } = require('./postService');
const { getSettings } = require('./settingsService');
const notifications = require('./notificationService');
const { isOffensive } = require('../config/offensiveWords');

// Comments have one level of replies, like Instagram: replying to a reply attaches
// to the same top-level comment. Threads read oldest first, like a conversation.
// You can read the comments of any post you can see (postService.findVisiblePost) and
// write one if the post author's whoCanComment lets you (postService.commentAllowed).
//
// hideOffensiveComments (the post author's setting, on by default): comments that match
// config/offensiveWords.js are hidden from everyone except the person who wrote them,
// and the post's author finds them under "Hidden comments" (?hidden=true). Nobody is
// notified about a hidden comment. Counts include hidden comments.

const commentNotFound = () => new AppError('Comment not found', 404, undefined, 'COMMENT_NOT_FOUND');

const findComment = async (commentId) => {
    const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        include: { post: { select: { authorId: true } } },
    });
    if (!comment) throw commentNotFound();
    return comment;
};

// filterOn: the post author's hideOffensiveComments.
const toComments = async (viewerId, comments, postAuthorId, filterOn) => {
    if (comments.length === 0) return [];
    const [likes, rel] = await Promise.all([
        prisma.commentLike.findMany({
            where: { userId: viewerId, commentId: { in: comments.map((c) => c.id) } },
            select: { commentId: true },
        }),
        relationsFor(viewerId, [...new Set(comments.map((c) => c.authorId))]),
    ]);
    const liked = new Set(likes.map((l) => l.commentId));

    return comments.map((c) => ({
        id: c.id,
        postId: c.postId,
        parentId: c.parentId,
        text: c.text,
        author: toCard(c.author, viewerId, rel),
        likesCount: c.likesCount,
        likedByMe: liked.has(c.id),
        repliesCount: c.repliesCount,
        // Only the writer (and the post's author, in Hidden comments) ever see these.
        hidden: filterOn && c.isOffensive,
        createdAt: c.createdAt,
        // The comment's author and the post's author may delete it.
        canDelete: c.authorId === viewerId || postAuthorId === viewerId,
    }));
};

// While the filter is on, offensive comments show only to the person who wrote them.
const unlessHidden = (viewerId, filterOn) => (filterOn ? { OR: [{ isOffensive: false }, { authorId: viewerId }] } : {});

// filterOn: hide offensive comments from this viewer. hiddenList: the "Hidden comments"
// page, where everything listed is a hidden comment.
const pageOfComments = async (viewerId, where, postAuthorId, { filterOn, hiddenList = false }, { cursor, limit }) => {
    const rows = await prisma.comment.findMany({
        // Comments by people with a block between them and the viewer are hidden.
        where: {
            AND: [where, hiddenList ? {} : unlessHidden(viewerId, filterOn), afterCursor(cursor, 'id', 'asc')],
            author: { status: 'ACTIVE', ...notBlockedWith(viewerId) },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: { author: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    return { comments: await toComments(viewerId, items, postAuthorId, filterOn || hiddenList), nextCursor };
};

// Top-level comments; each carries repliesCount so the app can show "View 3 replies".
// ?hidden=true: the post author's "Hidden comments" (offensive ones, replies included).
const listComments = async (viewerId, postId, { hidden, ...query }) => {
    const post = await findVisiblePost(viewerId, postId);
    const { hideOffensiveComments: filterOn } = await getSettings(post.authorId);
    if (hidden) {
        if (post.authorId !== viewerId) {
            throw new AppError('Only the post author can see hidden comments', 403, undefined, 'NOT_AUTHOR');
        }
        return pageOfComments(viewerId, { postId, isOffensive: true }, post.authorId, { filterOn, hiddenList: true }, query);
    }
    return pageOfComments(viewerId, { postId, parentId: null }, post.authorId, { filterOn }, query);
};

const listReplies = async (viewerId, commentId, query) => {
    const parent = await findComment(commentId);
    await findVisiblePost(viewerId, parent.postId);
    const { hideOffensiveComments: filterOn } = await getSettings(parent.post.authorId);
    return pageOfComments(viewerId, { parentId: parent.id }, parent.post.authorId, { filterOn }, query);
};

// The post author's whoCanComment; replies count as comments.
const assertCanComment = async (viewerId, post, prefs) => {
    if (post.authorId === viewerId) return;
    const relation = (await relationsFor(viewerId, [post.authorId]))(post.authorId);
    if (commentAllowed(prefs.whoCanComment, false, relation)) return;
    if (prefs.whoCanComment === 'off') throw new AppError('Comments are turned off for this post', 403, undefined, 'COMMENTS_OFF');
    throw new AppError(
        prefs.whoCanComment === 'followers'
            ? 'Only followers of this volunteer can comment'
            : 'Only people this volunteer follows can comment',
        403,
        undefined,
        'COMMENTS_RESTRICTED',
    );
};

const addComment = async (viewerId, postId, { text, parentId }) => {
    const post = await findVisiblePost(viewerId, postId);
    const prefs = await getSettings(post.authorId);
    await assertCanComment(viewerId, post, prefs);
    const offensive = isOffensive(text);
    const hidden = offensive && prefs.hideOffensiveComments; // written, but nobody else sees it

    // Replying to a reply attaches to its top-level comment, but the notification goes
    // to the author of the comment actually replied to.
    let topId = null;
    let repliedToAuthorId = null;
    if (parentId) {
        const parent = await prisma.comment.findFirst({ where: { id: parentId, postId }, select: { id: true, parentId: true, authorId: true } });
        if (!parent) throw commentNotFound();
        topId = parent.parentId ?? parent.id;
        repliedToAuthorId = parent.authorId;
    }

    const [comment, notificationIds] = await prisma.$transaction(async (tx) => {
        const created = await tx.comment.create({
            data: { postId, authorId: viewerId, parentId: topId, text, isOffensive: offensive },
            include: { author: { select: CARD_SELECT } },
        });
        await tx.post.update({ where: { id: postId }, data: { commentsCount: { increment: 1 } }, select: { id: true } });
        if (topId) {
            await tx.comment.update({ where: { id: topId }, data: { repliesCount: { increment: 1 } }, select: { id: true } });
        }
        // A hidden comment notifies nobody: its text would show in their Activity tab.
        const ids = hidden ? [] : await notifications.commented(tx, viewerId, created, { postAuthorId: post.authorId, repliedToAuthorId });
        return [created, ids];
    });
    notifications.deliver(notificationIds);
    return (await toComments(viewerId, [comment], post.authorId, prefs.hideOffensiveComments))[0];
};

// Deleting a top-level comment deletes its replies too (ON DELETE CASCADE). The
// post's count is recounted rather than decremented, which also covers the replies.
// Used by the comment's author, the post's author and moderators (removeComment).
const removeComment = async (comment) => {
    const commentId = comment.id;
    const changed = await prisma.$transaction(async (tx) => {
        // Notifications about this comment and its replies go by cascade.
        const recipients = await notifications.recipientsOf(tx, { comment: { OR: [{ id: commentId }, { parentId: commentId }] } });
        await tx.comment.delete({ where: { id: commentId } });
        const commentsCount = await tx.comment.count({ where: { postId: comment.postId } });
        await tx.post.update({ where: { id: comment.postId }, data: { commentsCount }, select: { id: true } });
        if (comment.parentId) {
            await tx.comment.updateMany({
                where: { id: comment.parentId, repliesCount: { gt: 0 } },
                data: { repliesCount: { decrement: 1 } },
            });
        }
        return recipients;
    });
    notifications.syncCount(changed);
};

const deleteComment = async (viewerId, commentId) => {
    const comment = await findComment(commentId);
    if (comment.authorId !== viewerId && comment.post.authorId !== viewerId) {
        throw new AppError("You can't delete this comment", 403, undefined, 'NOT_ALLOWED');
    }
    await removeComment(comment);
};

const setCommentLike = async (viewerId, commentId, like) => {
    const comment = await findComment(commentId);
    await findVisiblePost(viewerId, comment.postId);

    const [likesCount, notificationId, changed] = await prisma.$transaction(async (tx) => {
        const { count } = like
            ? await tx.commentLike.createMany({ data: [{ userId: viewerId, commentId }], skipDuplicates: true })
            : await tx.commentLike.deleteMany({ where: { userId: viewerId, commentId } });
        if (!count) return [(await tx.comment.findUnique({ where: { id: commentId }, select: { likesCount: true } })).likesCount];

        const row = await tx.comment.update({
            where: { id: commentId },
            data: { likesCount: { [like ? 'increment' : 'decrement']: 1 } },
            select: { likesCount: true },
        });
        if (!like) return [row.likesCount, null, await notifications.commentUnliked(tx, viewerId, comment)];
        return [row.likesCount, await notifications.commentLiked(tx, viewerId, comment)];
    });
    notifications.deliver(notificationId);
    notifications.syncCount(changed);
    return { liked: like, likesCount };
};

module.exports = {
    findComment,
    removeComment,
    listComments,
    listReplies,
    addComment,
    deleteComment,
    likeComment: (viewerId, commentId) => setCommentLike(viewerId, commentId, true),
    unlikeComment: (viewerId, commentId) => setCommentLike(viewerId, commentId, false),
};
