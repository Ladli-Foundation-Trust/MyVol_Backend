const prisma = require('../lib/prisma');
const env = require('../config/env');
const AppError = require('../utils/appError');
const { findActiveUser } = require('./socialGraph');
const { findVisiblePost } = require('./postService');
const { findComment } = require('./commentService');
const { findVisibleStory } = require('./storyService');

// Reports from users. Anonymous: the reported person is never told who reported them
// (the moderators see it). You can report only what you can see, never yourself, and
// a second report of the same thing while the first is still open just returns it.
//
// Posts reported by REPORT_AUTO_HIDE_THRESHOLD different people are hidden (back to
// UNDER_REVIEW) until a reviewer approves or rejects them (moderationService).

const cannotReportSelf = () => new AppError("You can't report yourself", 400, undefined, 'CANNOT_REPORT_SELF');

// The target as columns of `reports`, plus the author/user it is about.
const resolveTarget = async (viewerId, type, targetId) => {
    if (type === 'POST') {
        const post = await findVisiblePost(viewerId, targetId);
        if (post.authorId === viewerId) throw cannotReportSelf();
        return { postId: post.id, userId: post.authorId };
    }
    if (type === 'COMMENT') {
        const comment = await findComment(targetId);
        await findVisiblePost(viewerId, comment.postId);
        if (comment.authorId === viewerId) throw cannotReportSelf();
        return { commentId: comment.id, userId: comment.authorId };
    }
    if (type === 'STORY') {
        const story = await findVisibleStory(viewerId, targetId);
        if (story.authorId === viewerId) throw cannotReportSelf();
        return { storyId: story.id, userId: story.authorId };
    }
    const user = await findActiveUser(targetId, { viewerId });
    if (user.id === viewerId) throw cannotReportSelf();
    return { userId: user.id };
};

const toReport = (r) => ({ id: r.id, type: r.type.toLowerCase(), status: r.status, createdAt: r.createdAt });

// An approved post with enough distinct reporters goes back to review (hidden).
const maybeAutoHide = async (tx, postId) => {
    if (!env.REPORT_AUTO_HIDE_THRESHOLD) return;
    const reporters = await tx.report.findMany({
        where: { postId, status: 'OPEN' },
        distinct: ['reporterId'],
        select: { reporterId: true },
    });
    if (reporters.length < env.REPORT_AUTO_HIDE_THRESHOLD) return;
    const { count } = await tx.post.updateMany({ where: { id: postId, status: 'APPROVED' }, data: { status: 'UNDER_REVIEW' } });
    if (count) {
        await tx.moderationAction.create({
            data: {
                action: 'AUTO_HIDE_POST',
                targetType: 'post',
                targetId: postId,
                reason: `Reported by ${reporters.length} people`,
            },
        });
    }
};

// POST /reports { type: 'post' | 'comment' | 'user' | 'story', targetId, reason, details? }
const createReport = async (viewerId, { type, targetId, reason, details }) => {
    const target = await resolveTarget(viewerId, type, targetId);
    const sameTarget = {
        reporterId: viewerId,
        type,
        status: 'OPEN',
        ...(type === 'POST' && { postId: target.postId }),
        ...(type === 'COMMENT' && { commentId: target.commentId }),
        ...(type === 'STORY' && { storyId: target.storyId }),
        ...(type === 'USER' && { userId: target.userId }),
    };

    return prisma.$transaction(async (tx) => {
        const existing = await tx.report.findFirst({ where: sameTarget });
        if (existing) return { report: toReport(existing), alreadyReported: true };

        const report = await tx.report.create({ data: { reporterId: viewerId, type, reason, details, ...target } });
        if (type === 'POST') await maybeAutoHide(tx, target.postId);
        return { report: toReport(report), alreadyReported: false };
    });
};

// POST /reports/problem: the app's "Report a problem" screen.
const createProblemReport = async (viewerId, { category, details, deviceInfo }) => {
    const report = await prisma.report.create({
        data: { reporterId: viewerId, type: 'PROBLEM', category, details, deviceInfo },
    });
    return { report: toReport(report) };
};

module.exports = { createReport, createProblemReport };
