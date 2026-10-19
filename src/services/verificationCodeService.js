const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { generateOtp, hashOtp, safeEqual } = require('../utils/tokens');

const MAX_ATTEMPTS_PER_CODE = 5;
const MAX_CODES_PER_HOUR = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const INVALID_CODE = 'Invalid or expired code';

const scope = (userId, purpose) => `${purpose}:${userId}`;

// Issues a fresh code and expires any earlier one for the same purpose. Old rows are
// kept (not deleted) so the hourly cap counts them: 5 codes x 5 tries = at most 25
// guesses per hour against a 1-in-a-million code.
const issue = async (userId, purpose, { ttlMinutes, target = null }) => {
    const now = Date.now();
    const recent = await prisma.verificationCode.findMany({
        where: { userId, purpose, createdAt: { gt: new Date(now - HOUR_MS) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
    });
    if (recent[0] && now - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
        throw new AppError('Please wait a minute before requesting another code', 429, undefined, 'CODE_COOLDOWN');
    }
    if (recent.length >= MAX_CODES_PER_HOUR) {
        throw new AppError('Too many codes requested. Please try again later', 429, undefined, 'CODE_LIMIT');
    }

    const code = generateOtp();
    await prisma.$transaction([
        prisma.verificationCode.updateMany({
            where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date(now) } },
            data: { expiresAt: new Date(now) },
        }),
        prisma.verificationCode.create({
            data: {
                userId,
                purpose,
                target,
                codeHash: hashOtp(code, scope(userId, purpose)),
                expiresAt: new Date(now + ttlMinutes * 60 * 1000),
            },
        }),
    ]);
    return code;
};

// Checks a code and counts wrong guesses. Deliberately outside any transaction:
// the attempt counter must persist even when the caller's work later rolls back.
const check = async (userId, purpose, code) => {
    const record = await prisma.verificationCode.findFirst({
        where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
    });
    if (!record || record.attempts >= MAX_ATTEMPTS_PER_CODE) {
        throw new AppError(INVALID_CODE, 400, undefined, 'INVALID_CODE');
    }

    if (!safeEqual(record.codeHash, hashOtp(code, scope(userId, purpose)))) {
        await prisma.verificationCode.update({
            where: { id: record.id },
            data: { attempts: { increment: 1 } },
        });
        throw new AppError(INVALID_CODE, 400, undefined, 'INVALID_CODE');
    }
    return record;
};

// Call inside the caller's transaction. The conditional update means two concurrent
// requests with the same code can't both succeed.
const markUsed = async (id, db = prisma) => {
    const { count } = await db.verificationCode.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: new Date() },
    });
    if (count === 0) throw new AppError(INVALID_CODE, 400, undefined, 'INVALID_CODE');
};

module.exports = { issue, check, markUsed };
