const prisma = require('../lib/prisma');
const env = require('../config/env');
const AppError = require('../utils/appError');
const audit = require('./auditService');
const { WITH_PASSWORD } = require('../utils/publicUser');
const { signAccessToken, generateRefreshToken, sha256 } = require('../utils/tokens');

const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_SESSION = 'Session expired. Please log in again';

const refreshExpiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS);

const activeWhere = (extra) => ({ revokedAt: null, expiresAt: { gt: new Date() }, ...extra });

const issueRefreshToken = async (sessionId, expiresAt, db) => {
    const refreshToken = generateRefreshToken();
    await db.refreshToken.create({ data: { sessionId, tokenHash: sha256(refreshToken), expiresAt } });
    return refreshToken;
};

const revokeSession = (id, reason, db = prisma) =>
    db.session.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
    });

const revokeAllSessions = (userId, reason, { exceptSessionId } = {}, db = prisma) =>
    db.session.updateMany({
        where: { userId, revokedAt: null, ...(exceptSessionId && { id: { not: exceptSessionId } }) },
        data: { revokedAt: new Date(), revokedReason: reason },
    });

// Keeps at most MAX_SESSIONS_PER_USER live devices; the least recently used go first.
const enforceSessionCap = async (userId, db) => {
    const overflow = await db.session.findMany({
        where: activeWhere({ userId }),
        orderBy: { lastUsedAt: 'desc' },
        skip: env.MAX_SESSIONS_PER_USER,
        select: { id: true },
    });
    if (overflow.length) {
        await db.session.updateMany({
            where: { id: { in: overflow.map((s) => s.id) } },
            data: { revokedAt: new Date(), revokedReason: 'session_limit' },
        });
    }
};

// Run inside the caller's transaction so a failed login/signup leaves no session behind.
const createSession = async (user, ctx, db = prisma) => {
    const expiresAt = refreshExpiry();
    const session = await db.session.create({
        data: {
            userId: user.id,
            deviceName: ctx.deviceName,
            userAgent: ctx.userAgent?.slice(0, 512),
            ip: ctx.ip,
            expiresAt,
        },
    });
    const refreshToken = await issueRefreshToken(session.id, expiresAt, db);
    await enforceSessionCap(user.id, db);

    return {
        ...signAccessToken(user, session.id),
        refreshToken,
        refreshTokenExpiresAt: expiresAt,
    };
};

// Exchanges a refresh token for a new pair. Each token works once; a second use means
// it was copied, so the whole session is revoked (the thief and the victim both get
// logged out of that device, and the victim logs in again).
const rotate = async (rawToken, ctx) => {
    if (!rawToken) throw new AppError('Refresh token missing', 401, undefined, 'REFRESH_TOKEN_MISSING');

    const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(rawToken) },
        include: { session: { include: { user: WITH_PASSWORD } } },
    });
    if (!stored || stored.session.revokedAt) {
        throw new AppError(INVALID_SESSION, 401, undefined, 'SESSION_INVALID');
    }

    const { session } = stored;
    if (stored.usedAt) {
        await revokeSession(session.id, 'refresh_token_reuse');
        audit.record(audit.EVENTS.REFRESH_TOKEN_REUSE, { userId: session.userId, ctx, metadata: { sessionId: session.id } });
        throw new AppError(INVALID_SESSION, 401, undefined, 'SESSION_INVALID');
    }
    if (stored.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
        throw new AppError(INVALID_SESSION, 401, undefined, 'SESSION_INVALID');
    }

    const tokens = await prisma.$transaction(async (tx) => {
        // Only one of several concurrent refreshes with the same token can win.
        const { count } = await tx.refreshToken.updateMany({
            where: { id: stored.id, usedAt: null },
            data: { usedAt: new Date() },
        });
        if (count === 0) throw new AppError(INVALID_SESSION, 401, undefined, 'SESSION_INVALID');

        const expiresAt = refreshExpiry();
        await tx.session.update({
            where: { id: session.id },
            data: { expiresAt, lastUsedAt: new Date(), ip: ctx.ip, userAgent: ctx.userAgent?.slice(0, 512) },
        });
        const refreshToken = await issueRefreshToken(session.id, expiresAt, tx);
        return { ...signAccessToken(session.user, session.id), refreshToken, refreshTokenExpiresAt: expiresAt };
    });

    return { user: session.user, ...tokens };
};

const findSessionByRefreshToken = (rawToken) =>
    prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(rawToken) },
        select: { session: { select: { id: true, userId: true } } },
    });

const listSessions = async (userId, currentSessionId) => {
    const sessions = await prisma.session.findMany({
        where: activeWhere({ userId }),
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, deviceName: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
    });
    return sessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
};

const revokeUserSession = async (userId, sessionId) => {
    const { count } = await prisma.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'revoked_by_user' },
    });
    if (count === 0) throw new AppError('Session not found', 404);
};

module.exports = {
    createSession,
    rotate,
    revokeSession,
    revokeAllSessions,
    findSessionByRefreshToken,
    listSessions,
    revokeUserSession,
};
