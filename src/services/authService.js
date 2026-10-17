const crypto = require('crypto');
const prisma = require('../lib/prisma');
const env = require('../config/env');
const AppError = require('../utils/appError');
const { hashPassword, verifyPassword, verifyDummy } = require('../utils/password');
const {
    signAccessToken,
    generateRefreshToken,
    sha256,
    generateOtp,
    hashOtp,
    safeEqual,
} = require('../utils/tokens');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const INVALID_CREDENTIALS = 'Incorrect email or password';
const INVALID_SESSION = 'Session expired. Please log in again';
const INVALID_OTP = 'Invalid or expired code';

const toPublicUser = (u) => ({
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
});

const createSession = async (user, ctx, familyId = crypto.randomUUID(), db = prisma) => {
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS);

    await db.refreshToken.create({
        data: {
            userId: user.id,
            tokenHash: sha256(refreshToken),
            familyId,
            expiresAt: refreshTokenExpiresAt,
            userAgent: ctx.userAgent?.slice(0, 512),
            ip: ctx.ip,
        },
    });

    return { accessToken: signAccessToken(user), refreshToken, refreshTokenExpiresAt };
};

const revokeAllSessions = (userId, db = prisma) =>
    db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });

const signup = async ({ name, email, username, password }, ctx) => {
    const taken = await prisma.user.findFirst({
        where: { OR: [{ email }, { username }] },
        select: { email: true },
    });
    if (taken) {
        throw new AppError(
            taken.email === email ? 'An account with this email already exists' : 'This username is taken',
            409,
        );
    }

    const user = await prisma.user.create({
        data: { name, email, username, passwordHash: await hashPassword(password), lastLoginAt: new Date() },
    });

    const tokens = await createSession(user, ctx);
    return { user: toPublicUser(user), ...tokens };
};

const login = async ({ email, password }, ctx) => {
    const user = await prisma.user.findUnique({ where: { email }, omit: { passwordHash: false } });

    const ok = user?.passwordHash ? await verifyPassword(user.passwordHash, password) : await verifyDummy(password);
    if (!ok) throw new AppError(INVALID_CREDENTIALS, 401);

    const tokens = await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
        // Housekeeping: drop this user's dead tokens so the table doesn't grow forever.
        await tx.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });
        return createSession(user, ctx, undefined, tx);
    });

    return { user: toPublicUser(user), ...tokens };
};


const refresh = async (rawToken, ctx) => {
    if (!rawToken) throw new AppError('Refresh token missing', 401);

    const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(rawToken) },
        include: { user: true },
    });
    if (!stored) throw new AppError(INVALID_SESSION, 401);

    if (stored.revokedAt) {
        await prisma.refreshToken.updateMany({
            where: { familyId: stored.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        throw new AppError(INVALID_SESSION, 401);
    }
    if (stored.expiresAt <= new Date()) throw new AppError(INVALID_SESSION, 401);

    return prisma.$transaction(async (tx) => {
        // Conditional update makes concurrent refreshes with the same token safe: only one wins.
        const { count } = await tx.refreshToken.updateMany({
            where: { id: stored.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        if (count === 0) throw new AppError(INVALID_SESSION, 401);

        const tokens = await createSession(stored.user, ctx, stored.familyId, tx);
        return { user: toPublicUser(stored.user), ...tokens };
    });
};

const logout = async (rawToken) => {
    if (!rawToken) return;
    const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(rawToken) },
        select: { familyId: true },
    });
    if (!stored) return;
    await prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
};

const logoutAll = (userId) =>
    prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
        prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

const getMe = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);
    return toPublicUser(user);
};


const requestPasswordReset = async ({ email }) => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return;

    const otp = generateOtp();
    await prisma.$transaction([
        // Only the newest code is valid.
        prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
        prisma.passwordResetToken.create({
            data: {
                userId: user.id,
                codeHash: hashOtp(otp),
                expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
            },
        }),
    ]);

    if (!env.isProd) {
        console.log(`[auth] Password reset code for ${email}: ${otp} (valid ${env.PASSWORD_RESET_TTL_MINUTES} min)`);
    }
};

const resetPassword = async ({ email, otp, newPassword }) => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const record = user
        ? await prisma.passwordResetToken.findFirst({
              where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
              orderBy: { createdAt: 'desc' },
          })
        : null;
    if (!record || record.attempts >= MAX_OTP_ATTEMPTS) throw new AppError(INVALID_OTP, 400);

    if (!safeEqual(record.codeHash, hashOtp(otp))) {
        await prisma.passwordResetToken.update({
            where: { id: record.id },
            data: { attempts: { increment: 1 } },
        });
        throw new AppError(INVALID_OTP, 400);
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction(async (tx) => {
        // Conditional update stops the same code being used twice concurrently.
        const { count } = await tx.passwordResetToken.updateMany({
            where: { id: record.id, usedAt: null },
            data: { usedAt: new Date() },
        });
        if (count === 0) throw new AppError(INVALID_OTP, 400);

        await tx.user.update({
            where: { id: user.id },
            data: { passwordHash, passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
        });
        // Someone else may have had the old password: sign out everywhere.
        await revokeAllSessions(user.id, tx);
    });
};

const changePassword = async (userId, { currentPassword, newPassword }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, omit: { passwordHash: false } });
    if (!user) throw new AppError('User not found', 404);

    const ok = user.passwordHash && (await verifyPassword(user.passwordHash, currentPassword));
    if (!ok) throw new AppError('Current password is incorrect', 401);

    const passwordHash = await hashPassword(newPassword);
    return prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
            where: { id: userId },
            data: { passwordHash, passwordChangedAt: new Date(), tokenVersion: { increment: 1 } },
        });
        await revokeAllSessions(userId, tx);
        const tokens = await createSession(updated, ctx, undefined, tx);
        return { user: toPublicUser(updated), ...tokens };
    });
};

module.exports = {
    signup,
    login,
    refresh,
    logout,
    logoutAll,
    getMe,
    requestPasswordReset,
    resetPassword,
    changePassword,
};
