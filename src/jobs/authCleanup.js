const env = require('../config/env');
const prisma = require('../lib/prisma');
const storage = require('../lib/storage');

const DAY_MS = 24 * 60 * 60 * 1000;
const REVOKED_SESSION_RETENTION_DAYS = 30;
const USED_REFRESH_TOKEN_RETENTION_DAYS = 7;
const AUTH_EVENT_RETENTION_DAYS = 180;

// Deletes dead auth rows and purges accounts whose deletion grace period is over.
// Runs in one transaction behind a Postgres advisory lock, so if several API
// instances fire it at once only one does the work.
const purgeDatabase = () =>
    prisma.$transaction(
        async (tx) => {
            const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('auth-cleanup')) AS locked`;
            if (!locked) return null;

            const now = new Date();
            const daysAgo = (days) => new Date(now.getTime() - days * DAY_MS);

            const purging = { status: 'PENDING_DELETION', deletionScheduledAt: { lte: now } };
            const avatars = await tx.user.findMany({ where: { ...purging, avatarKey: { not: null } }, select: { avatarKey: true } });
            const postMedia = await tx.postMedia.findMany({ where: { post: { author: purging } }, select: { key: true, thumbnailKey: true } });

            // Other people's posts/comments the purged users liked, saved or commented
            // on: their counters are recounted after the cascade below.
            const [liked, saved, viewed, commented, likedComments] = await Promise.all([
                tx.postLike.findMany({ where: { user: purging }, select: { postId: true } }),
                tx.postSave.findMany({ where: { user: purging }, select: { postId: true } }),
                tx.postView.findMany({ where: { user: purging }, select: { postId: true } }),
                tx.comment.findMany({ where: { author: purging }, select: { postId: true, parentId: true } }),
                tx.commentLike.findMany({ where: { user: purging }, select: { commentId: true } }),
            ]);
            const postIds = [...new Set([...liked, ...saved, ...viewed, ...commented].map((r) => r.postId))];
            const commentIds = [...new Set([...likedComments.map((r) => r.commentId), ...commented.map((r) => r.parentId).filter(Boolean)])];

            // Purged users' follows disappear by cascade; first take them off the other
            // side's counters so followers/following counts stay right.
            await tx.$executeRaw`
                UPDATE users u SET followers_count = u.followers_count - c.n
                FROM (SELECT f.following_id AS id, count(*)::int AS n FROM follows f
                      JOIN users g ON g.id = f.follower_id
                      WHERE g.status = 'PENDING_DELETION' AND g.deletion_scheduled_at <= ${now}
                      GROUP BY f.following_id) c
                WHERE u.id = c.id`;
            await tx.$executeRaw`
                UPDATE users u SET following_count = u.following_count - c.n
                FROM (SELECT f.follower_id AS id, count(*)::int AS n FROM follows f
                      JOIN users g ON g.id = f.following_id
                      WHERE g.status = 'PENDING_DELETION' AND g.deletion_scheduled_at <= ${now}
                      GROUP BY f.follower_id) c
                WHERE u.id = c.id`;

            // Cascades to everything the user owns (sessions, codes, events, follows, and later posts...).
            const users = await tx.user.deleteMany({ where: purging });

            if (postIds.length) {
                await tx.$executeRaw`
                    UPDATE posts p SET
                        likes_count = (SELECT count(*) FROM post_likes l WHERE l.post_id = p.id),
                        saves_count = (SELECT count(*) FROM post_saves s WHERE s.post_id = p.id),
                        views_count = (SELECT count(*) FROM post_views v WHERE v.post_id = p.id),
                        comments_count = (SELECT count(*) FROM comments c WHERE c.post_id = p.id)
                    WHERE p.id = ANY(${postIds}::uuid[])`;
            }
            if (commentIds.length) {
                await tx.$executeRaw`
                    UPDATE comments c SET
                        likes_count = (SELECT count(*) FROM comment_likes l WHERE l.comment_id = c.id),
                        replies_count = (SELECT count(*) FROM comments r WHERE r.parent_id = c.id)
                    WHERE c.id = ANY(${commentIds}::uuid[])`;
            }
            const sessions = await tx.session.deleteMany({
                where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: daysAgo(REVOKED_SESSION_RETENTION_DAYS) } }] },
            });
            // Used tokens are kept for a week so a replayed one is still recognised as theft.
            const refreshTokens = await tx.refreshToken.deleteMany({
                where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: daysAgo(USED_REFRESH_TOKEN_RETENTION_DAYS) } }] },
            });
            // Kept a day so the hourly "codes requested" cap can still count them.
            const codes = await tx.verificationCode.deleteMany({ where: { createdAt: { lt: daysAgo(1) } } });
            const phoneCodes = await tx.phoneCode.deleteMany({ where: { createdAt: { lt: daysAgo(1) } } });
            const events = await tx.authEvent.deleteMany({
                where: { createdAt: { lt: daysAgo(AUTH_EVENT_RETENTION_DAYS) } },
            });
            const notifications = await tx.notification.deleteMany({
                where: { createdAt: { lt: daysAgo(env.NOTIFICATION_RETENTION_DAYS) } },
            });
            // Purged users' posts took their hashtag links with them: fix the counts and
            // drop tags no post uses any more.
            await tx.$executeRaw`
                UPDATE hashtags h SET posts_count = c.n
                FROM (SELECT h2.id, count(ph.post_id)::int AS n
                      FROM hashtags h2 LEFT JOIN post_hashtags ph ON ph.hashtag_id = h2.id
                      GROUP BY h2.id) c
                WHERE h.id = c.id AND h.posts_count <> c.n`;
            const hashtags = await tx.hashtag.deleteMany({ where: { postsCount: 0, createdAt: { lt: daysAgo(1) } } });

            return {
                purgedUsers: users.count,
                sessions: sessions.count,
                refreshTokens: refreshTokens.count,
                codes: codes.count,
                phoneCodes: phoneCodes.count,
                events: events.count,
                notifications: notifications.count,
                hashtags: hashtags.count,
                fileKeys: [...avatars.map((a) => a.avatarKey), ...postMedia.flatMap((m) => [m.key, m.thumbnailKey].filter(Boolean))],
            };
        },
        { timeout: 120_000 },
    );

// Files (avatars, post photos) are deleted only after the purge has committed, so a
// rollback never leaves a surviving user without their images.
const runAuthCleanup = async () => {
    const result = await purgeDatabase();
    if (!result) return null;
    const { fileKeys, ...counts } = result;
    await Promise.all(fileKeys.map((key) => storage.remove(key).catch(() => {})));
    return { ...counts, files: fileKeys.length };
};

module.exports = { runAuthCleanup };
