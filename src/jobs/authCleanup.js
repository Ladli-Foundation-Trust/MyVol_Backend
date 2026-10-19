const prisma = require('../lib/prisma');

const DAY_MS = 24 * 60 * 60 * 1000;
const REVOKED_SESSION_RETENTION_DAYS = 30;
const USED_REFRESH_TOKEN_RETENTION_DAYS = 7;
const AUTH_EVENT_RETENTION_DAYS = 180;

// Deletes dead auth rows and purges accounts whose deletion grace period is over.
// Runs in one transaction behind a Postgres advisory lock, so if several API
// instances fire it at once only one does the work.
const runAuthCleanup = () =>
    prisma.$transaction(
        async (tx) => {
            const [{ locked }] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtext('auth-cleanup')) AS locked`;
            if (!locked) return null;

            const now = new Date();
            const daysAgo = (days) => new Date(now.getTime() - days * DAY_MS);

            // Cascades to everything the user owns (sessions, codes, events, and later posts...).
            const users = await tx.user.deleteMany({
                where: { status: 'PENDING_DELETION', deletionScheduledAt: { lte: now } },
            });
            const sessions = await tx.session.deleteMany({
                where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: daysAgo(REVOKED_SESSION_RETENTION_DAYS) } }] },
            });
            // Used tokens are kept for a week so a replayed one is still recognised as theft.
            const refreshTokens = await tx.refreshToken.deleteMany({
                where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { lt: daysAgo(USED_REFRESH_TOKEN_RETENTION_DAYS) } }] },
            });
            // Kept a day so the hourly "codes requested" cap can still count them.
            const codes = await tx.verificationCode.deleteMany({ where: { createdAt: { lt: daysAgo(1) } } });
            const events = await tx.authEvent.deleteMany({
                where: { createdAt: { lt: daysAgo(AUTH_EVENT_RETENTION_DAYS) } },
            });

            return {
                purgedUsers: users.count,
                sessions: sessions.count,
                refreshTokens: refreshTokens.count,
                codes: codes.count,
                events: events.count,
            };
        },
        { timeout: 120_000 },
    );

module.exports = { runAuthCleanup };
