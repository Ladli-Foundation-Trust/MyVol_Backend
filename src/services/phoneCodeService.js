const prisma = require('../lib/prisma');
const env = require('../config/env');
const AppError = require('../utils/appError');
const { generateOtp, hashOtp, safeEqual, signPhoneToken, verifyPhoneToken } = require('../utils/tokens');

// Same limits as the email codes (verificationCodeService): 5 tries per code,
// one code a minute, 5 an hour per number. SMS costs money, so these also cap spend.
const MAX_ATTEMPTS_PER_CODE = 5;
const MAX_CODES_PER_HOUR = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PHONE_TOKEN_TTL_MINUTES = 15;

const INVALID_CODE = 'Invalid or expired code';
const INVALID_TOKEN = 'Phone verification expired. Please request a new code';

const scope = (phone) => `PHONE:${phone}`;

const invalidToken = () => new AppError(INVALID_TOKEN, 400, undefined, 'PHONE_TOKEN_INVALID');

// Issues a fresh code for the number and expires any earlier unverified one.
const issue = async (phone) => {
    const now = Date.now();
    const recent = await prisma.phoneCode.findMany({
        where: { phone, createdAt: { gt: new Date(now - HOUR_MS) } },
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
        prisma.phoneCode.updateMany({
            where: { phone, verifiedAt: null, expiresAt: { gt: new Date(now) } },
            data: { expiresAt: new Date(now) },
        }),
        prisma.phoneCode.create({
            data: {
                phone,
                codeHash: hashOtp(code, scope(phone)),
                expiresAt: new Date(now + env.PHONE_CODE_TTL_MINUTES * 60 * 1000),
            },
        }),
    ]);
    return code;
};

// Checks the code (counting wrong guesses) and, if right, returns a phoneToken that
// the next call (phone signup/login/reset/change) presents instead of the code.
const verify = async (phone, code) => {
    const record = await prisma.phoneCode.findFirst({
        where: { phone, verifiedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
    });
    if (!record || record.attempts >= MAX_ATTEMPTS_PER_CODE) {
        throw new AppError(INVALID_CODE, 400, undefined, 'INVALID_CODE');
    }
    if (!safeEqual(record.codeHash, hashOtp(code, scope(phone)))) {
        await prisma.phoneCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
        throw new AppError(INVALID_CODE, 400, undefined, 'INVALID_CODE');
    }

    // Conditional update: two concurrent requests with the same code can't both win.
    const { count } = await prisma.phoneCode.updateMany({
        where: { id: record.id, verifiedAt: null },
        data: { verifiedAt: new Date() },
    });
    if (count === 0) throw new AppError(INVALID_CODE, 400, undefined, 'INVALID_CODE');

    return signPhoneToken(phone, record.id, PHONE_TOKEN_TTL_MINUTES);
};

// Reads a phoneToken without using it up, so callers can validate the rest of the
// request first. Returns the verified number and the code row to consume.
const readToken = (phoneToken) => {
    try {
        const { sub, jti } = verifyPhoneToken(phoneToken);
        return { phone: sub, codeId: jti };
    } catch {
        throw invalidToken();
    }
};

// Marks the token used. Call inside the caller's transaction, so if the action fails
// (e.g. username taken) the rollback leaves the token usable for a retry.
const consume = async (codeId, db = prisma) => {
    const { count } = await db.phoneCode.updateMany({
        where: { id: codeId, verifiedAt: { not: null }, consumedAt: null },
        data: { consumedAt: new Date() },
    });
    if (count === 0) throw invalidToken();
};

// The accounts the number belongs to, for the "choose an account" screen.
const accountsFor = (phone) =>
    prisma.user.findMany({
        where: { phone },
        orderBy: { createdAt: 'asc' },
        select: { id: true, username: true, name: true },
    });

// Call at the start of a transaction that adds a number to an account. Held until
// commit, so two sign-ups at once can't both take the number's last free slot.
const lockPhone = (phone, tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}::text))`;

// Enforces MAX_ACCOUNTS_PER_PHONE.
const assertPhoneHasRoom = async (phone, db = prisma) => {
    const count = await db.user.count({ where: { phone } });
    if (count >= env.MAX_ACCOUNTS_PER_PHONE) {
        throw new AppError(
            `This phone number is already linked to ${env.MAX_ACCOUNTS_PER_PHONE} accounts, the maximum allowed`,
            409,
            undefined,
            'PHONE_LIMIT_REACHED',
        );
    }
};

module.exports = { issue, verify, readToken, consume, accountsFor, lockPhone, assertPhoneHasRoom };
