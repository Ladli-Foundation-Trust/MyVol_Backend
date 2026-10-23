const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { verifyAccessToken } = require('../utils/tokens');

const SESSION_ENDED = 'Your session has ended. Please log in again';

// Verifies the access token, then checks its session and user in one query, so a
// logout, password change, ban or role change takes effect on the very next request
// instead of when the 15-minute token expires. Used by `protect` and by the WebSocket
// login (lib/realtime.js). Throws AppError 401 (or a JWT error → TOKEN_EXPIRED/TOKEN_INVALID).
const authenticate = async (token) => {
    const payload = verifyAccessToken(token);
    if (!payload.sid) throw new AppError(SESSION_ENDED, 401, undefined, 'SESSION_INVALID');

    const session = await prisma.session.findUnique({
        where: { id: payload.sid },
        select: {
            userId: true,
            revokedAt: true,
            createdAt: true,
            user: { select: { id: true, role: true, status: true, emailVerifiedAt: true, phone: true } },
        },
    });
    if (!session || session.revokedAt || session.userId !== payload.sub) {
        throw new AppError(SESSION_ENDED, 401, undefined, 'SESSION_INVALID');
    }
    if (session.user.status !== 'ACTIVE') {
        throw new AppError(SESSION_ENDED, 401, undefined, 'ACCOUNT_INACTIVE');
    }

    return {
        id: session.user.id,
        role: session.user.role, // from the DB, not the token, so demotions apply at once
        // A verified email or any phone (phones are only saved after an SMS code).
        verified: Boolean(session.user.emailVerifiedAt || session.user.phone),
        sessionId: payload.sid,
        sessionCreatedAt: session.createdAt,
    };
};

const protect = async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return next(new AppError('You are not logged in', 401, undefined, 'NOT_AUTHENTICATED'));
    }
    req.user = await authenticate(token);
    next();
};

// For routes that publish content or contact other people (posting, commenting,
// messaging). Keeps throwaway/bot sign-ups from spamming before proving an inbox
// or a phone number.
const requireVerified = (req, res, next) => {
    if (!req.user?.verified) {
        return next(new AppError('Please verify your email to do this', 403, undefined, 'EMAIL_NOT_VERIFIED'));
    }
    next();
};

const restrictTo =
    (...roles) =>
    (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
            return next(new AppError('You do not have permission to perform this action', 403, undefined, 'FORBIDDEN'));
        }
        next();
    };

module.exports = { authenticate, protect, requireVerified, restrictTo };
