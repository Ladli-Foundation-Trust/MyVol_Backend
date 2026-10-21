const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const { CARD_SELECT, relationsFor, toCard } = require('./socialGraph');
const { findVisiblePost } = require('./postService');

// Comments have one level of replies, like Instagram: replying to a reply attaches
// to the same top-level comment. Threads read oldest first, like a conversation.
// You can comment on any post you can see (postService.findVisiblePost).

const commentNotFound = () => new AppError('Comment not found', 404, undefined, 'COMMENT_NOT_FOUND');

const findComment = async (commentId) => {
    const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        include: { post: { select: { authorId: true } } },
    });
    if (!comment) throw commentNotFound();
    return comment;
};

const toComments = async (viewerId, comments, postAuthorId) => {
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
        createdAt: c.createdAt,
        // The comment's author and the post's author may delete it.
        canDelete: c.authorId === viewerId || postAuthorId === viewerId,
    }));
};

const pageOfComments = async (viewerId, where, postAuthorId, { cursor, limit }) => {
    const rows = await prisma.comment.findMany({
        where: { ...where, author: { status: 'ACTIVE' }, ...afterCursor(cursor, 'id', 'asc') },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: { author: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'id');
    return { comments: await toComments(viewerId, items, postAuthorId), nextCursor };
};

// Top-level comments; each carries repliesCount so the app can show "View 3 replies".
const listComments = async (viewerId, postId, query) => {
    const post = await findVisiblePost(viewerId, postId);
    return pageOfComments(viewerId, { postId, parentId: null }, post.authorId, query);
};

const listReplies = async (viewerId, commentId, query) => {
    const parent = await findComment(commentId);
    await findVisiblePost(viewerId, parent.postId);
    return pageOfComments(viewerId, { parentId: parent.id }, parent.post.authorId, query);
};

const addComment = async (viewerId, postId, { text, parentId }) => {
    const post = await findVisiblePost(viewerId, postId);

    let topId = null;
    if (parentId) {
        const parent = await prisma.comment.findFirst({ where: { id: parentId, postId }, select: { id: true, parentId: true } });
        if (!parent) throw commentNotFound();
        topId = parent.parentId ?? parent.id;
    }

    const comment = await prisma.$transaction(async (tx) => {
        const created = await tx.comment.create({
            data: { postId, authorId: viewerId, parentId: topId, text },
            include: { author: { select: CARD_SELECT } },
        });
        await tx.post.update({ where: { id: postId }, data: { commentsCount: { increment: 1 } }, select: { id: true } });
        if (topId) {
            await tx.comment.update({ where: { id: topId }, data: { repliesCount: { increment: 1 } }, select: { id: true } });
        }
        return created;
    });
    return (await toComments(viewerId, [comment], post.authorId))[0];
};

// Deleting a top-level comment deletes its replies too (ON DELETE CASCADE). The
// post's count is recounted rather than decremented, which also covers the replies.
const deleteComment = async (viewerId, commentId) => {
    const comment = await findComment(commentId);
    if (comment.authorId !== viewerId && comment.post.authorId !== viewerId) {
        throw new AppError("You can't delete this comment", 403, undefined, 'NOT_ALLOWED');
    }

    await prisma.$transaction(async (tx) => {
        await tx.comment.delete({ where: { id: commentId } });
        const commentsCount = await tx.comment.count({ where: { postId: comment.postId } });
        await tx.post.update({ where: { id: comment.postId }, data: { commentsCount }, select: { id: true } });
        if (comment.parentId) {
            await tx.comment.updateMany({
                where: { id: comment.parentId, repliesCount: { gt: 0 } },
                data: { repliesCount: { decrement: 1 } },
            });
        }
    });
};

const setCommentLike = async (viewerId, commentId, like) => {
    const comment = await findComment(commentId);
    await findVisiblePost(viewerId, comment.postId);

    const likesCount = await prisma.$transaction(async (tx) => {
        const { count } = like
            ? await tx.commentLike.createMany({ data: [{ userId: viewerId, commentId }], skipDuplicates: true })
            : await tx.commentLike.deleteMany({ where: { userId: viewerId, commentId } });
        const row = count
            ? await tx.comment.update({
                  where: { id: commentId },
                  data: { likesCount: { [like ? 'increment' : 'decrement']: 1 } },
                  select: { likesCount: true },
              })
            : await tx.comment.findUnique({ where: { id: commentId }, select: { likesCount: true } });
        return row.likesCount;
    });
    return { liked: like, likesCount };
};

module.exports = {
    listComments,
    listReplies,
    addComment,
    deleteComment,
    likeComment: (viewerId, commentId) => setCommentLike(viewerId, commentId, true),
    unlikeComment: (viewerId, commentId) => setCommentLike(viewerId, commentId, false),
};
