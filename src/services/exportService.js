const prisma = require('../lib/prisma');
const env = require('../config/env');
const storage = require('../lib/storage');
const audit = require('./auditService');
const { getSettings } = require('./settingsService');
const { WITH_PASSWORD } = require('../utils/publicUser');
const { assertReauthenticated } = require('./reauthService');

// "Download your information" (Settings > Security, and Your activity): everything the
// account holds, as one JSON file. Needs the password (or a fresh sign-in for Google-only
// accounts), like the other sensitive actions: the file contains the phone, email,
// login history and every comment. Secrets (password hash, token hashes, codes) and
// other people's private data (who reported what) are never included.

const url = (key) => storage.urlFor(key);
const people = (rows, pick) => rows.map(pick).map((u) => ({ username: u.username, name: u.name }));

const exportData = async (auth, { password }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, ...WITH_PASSWORD });
    await assertReauthenticated(user, password, auth);
    const userId = user.id;

    const [
        profile,
        settings,
        posts,
        comments,
        likes,
        saves,
        followers,
        following,
        requestsSent,
        requestsReceived,
        blocks,
        mutes,
        stories,
        notifications,
        reports,
        sessions,
        loginHistory,
    ] = await Promise.all([
        prisma.profile.findUnique({ where: { userId } }),
        getSettings(userId),
        prisma.post.findMany({
            where: { authorId: userId },
            orderBy: { createdAt: 'asc' },
            include: { media: { orderBy: { position: 'asc' } }, hashtags: { select: { hashtag: { select: { name: true } } } } },
        }),
        prisma.comment.findMany({ where: { authorId: userId }, orderBy: { createdAt: 'asc' }, select: { id: true, postId: true, parentId: true, text: true, createdAt: true } }),
        prisma.postLike.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { postId: true, createdAt: true } }),
        prisma.postSave.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, select: { postId: true, createdAt: true } }),
        prisma.follow.findMany({ where: { followingId: userId }, select: { createdAt: true, follower: { select: { username: true, name: true } } } }),
        prisma.follow.findMany({ where: { followerId: userId }, select: { createdAt: true, following: { select: { username: true, name: true } } } }),
        prisma.followRequest.findMany({ where: { requesterId: userId }, select: { createdAt: true, target: { select: { username: true, name: true } } } }),
        prisma.followRequest.findMany({ where: { targetId: userId }, select: { createdAt: true, requester: { select: { username: true, name: true } } } }),
        prisma.block.findMany({ where: { blockerId: userId }, select: { createdAt: true, blocked: { select: { username: true, name: true } } } }),
        prisma.mute.findMany({ where: { muterId: userId }, select: { createdAt: true, muted: { select: { username: true, name: true } } } }),
        prisma.story.findMany({ where: { authorId: userId }, orderBy: { createdAt: 'asc' } }),
        prisma.notification.findMany({ where: { recipientId: userId }, orderBy: { createdAt: 'desc' }, select: { type: true, postId: true, createdAt: true, readAt: true } }),
        prisma.report.findMany({ where: { reporterId: userId }, orderBy: { createdAt: 'asc' }, select: { type: true, reason: true, category: true, details: true, status: true, createdAt: true } }),
        prisma.session.findMany({ where: { userId, revokedAt: null }, select: { deviceName: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true } }),
        prisma.authEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 500, select: { type: true, ip: true, userAgent: true, createdAt: true } }),
    ]);

    audit.record(audit.EVENTS.DATA_EXPORTED, { userId, ctx });

    return {
        exportedAt: new Date().toISOString(),
        app: env.APP_NAME,
        account: {
            id: user.id,
            username: user.username,
            name: user.name,
            email: user.email,
            phone: user.phone,
            bio: user.bio,
            avatarUrl: url(user.avatarKey),
            dateOfBirth: user.dateOfBirth?.toISOString().slice(0, 10) ?? null,
            isPrivate: user.isPrivate,
            role: user.role,
            emailVerifiedAt: user.emailVerifiedAt,
            termsAcceptedAt: user.termsAcceptedAt,
            createdAt: user.createdAt,
            lastLoginAt: user.lastLoginAt,
        },
        profile: profile && { ...profile, userId: undefined, updatedAt: undefined },
        settings,
        posts: posts.map((p) => ({
            id: p.id,
            title: p.title,
            description: p.description,
            location: p.location,
            category: p.category,
            beneficiaries: p.beneficiaries,
            hours: p.hours,
            status: p.status,
            rejectionReason: p.rejectionReason,
            hashtags: p.hashtags.map((h) => h.hashtag.name),
            media: p.media.map((m) => ({ type: m.type.toLowerCase(), url: url(m.key), thumbnailUrl: url(m.thumbnailKey) })),
            likesCount: p.likesCount,
            commentsCount: p.commentsCount,
            createdAt: p.createdAt,
            editedAt: p.editedAt,
        })),
        comments,
        likes,
        saves,
        followers: people(followers, (f) => f.follower),
        following: people(following, (f) => f.following),
        followRequestsSent: people(requestsSent, (r) => r.target),
        followRequestsReceived: people(requestsReceived, (r) => r.requester),
        blocked: people(blocks, (b) => b.blocked),
        muted: people(mutes, (m) => m.muted),
        stories: stories.map((s) => ({ type: s.type.toLowerCase(), url: url(s.key), caption: s.caption, createdAt: s.createdAt, expiresAt: s.expiresAt })),
        notifications: notifications.map((n) => ({ ...n, type: n.type.toLowerCase() })),
        reportsMade: reports,
        activeSessions: sessions,
        loginHistory,
    };
};

module.exports = { exportData };
