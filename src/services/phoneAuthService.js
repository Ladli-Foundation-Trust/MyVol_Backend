const prisma = require('../lib/prisma');
const env = require('../config/env');
const AppError = require('../utils/appError');
const emails = require('../emails/authEmails');
const sms = require('../emails/authSms');
const audit = require('./auditService');
const sessions = require('./sessionService');
const phoneCodes = require('./phoneCodeService');
const { queueMail } = require('../lib/mailer');
const { queueSms } = require('../lib/sms');
const { hashPassword } = require('../utils/password');
const { assertReauthenticated } = require('./reauthService');
const { WITH_PASSWORD, toPublicUser } = require('../utils/publicUser');
const { assertAvailable, completeLogin, devOtp } = require('./authService');

const { EVENTS } = audit;

// Every phone flow is two steps, like Instagram:
//   1. POST /phone/send-code   → SMS with a 6-digit code
//   2. POST /phone/verify-code → { phoneToken, accounts }  (the code proved the number)
// then ONE of: /phone/signup, /phone/login, /phone/reset-password, /phone/change,
// each of which uses up the phoneToken.

const findAccountOnPhone = async (userId, phone) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, ...WITH_PASSWORD });
    if (!user || user.phone !== phone) {
        throw new AppError('This account is not linked to this phone number', 400, undefined, 'ACCOUNT_NOT_ON_PHONE');
    }
    return user;
};

// purpose 'signup' / 'change': the number must have a free account slot, checked
// before an SMS is paid for. purpose 'login' (also used to reset a password): answers
// the same whether or not the number has accounts, and only texts numbers that do.
const sendCode = async ({ phone, purpose }, ctx) => {
    let otp;
    if (purpose === 'login') {
        const accounts = await prisma.user.count({ where: { phone } });
        if (accounts === 0) return {};
        try {
            otp = await phoneCodes.issue(phone);
        } catch (err) {
            if (err.statusCode === 429) return {}; // stay silent, same response
            throw err;
        }
    } else {
        await phoneCodes.assertPhoneHasRoom(phone);
        otp = await phoneCodes.issue(phone);
    }

    queueSms({ to: phone, text: sms.code(otp, env.PHONE_CODE_TTL_MINUTES) });
    audit.record(EVENTS.PHONE_CODE_SENT, { ctx, metadata: { purpose } });
    return devOtp(otp);
};

// `accounts` lets the app show "Log in as @priya / @priya.art, or create a new account".
const verifyCode = async ({ phone, otp }) => {
    const token = await phoneCodes.verify(phone, otp);
    return { ...token, accounts: await phoneCodes.accountsFor(phone) };
};

const signup = async ({ phoneToken, name, username, password, dateOfBirth }, ctx) => {
    const { phone, codeId } = phoneCodes.readToken(phoneToken);
    await assertAvailable({ username });

    const passwordHash = await hashPassword(password);
    const { user, tokens } = await prisma.$transaction(async (tx) => {
        await phoneCodes.lockPhone(phone, tx);
        await phoneCodes.assertPhoneHasRoom(phone, tx);
        await phoneCodes.consume(codeId, tx);
        const user = await tx.user.create({
            data: { name, username, phone, dateOfBirth, passwordHash, termsAcceptedAt: new Date(), lastLoginAt: new Date() },
            ...WITH_PASSWORD,
        });
        return { user, tokens: await sessions.createSession(user, ctx, tx) };
    });

    audit.record(EVENTS.SIGNUP, { userId: user.id, ctx, metadata: { method: 'phone' } });
    return { user: toPublicUser(user), ...tokens };
};

// Login with the SMS code, no password. The code proves the number, so it also
// unlocks an account that is locked out from failed password attempts.
const login = async ({ phoneToken, userId }, ctx) => {
    const { phone, codeId } = phoneCodes.readToken(phoneToken);
    const user = await findAccountOnPhone(userId, phone);
    await phoneCodes.consume(codeId);
    return completeLogin(user, ctx, 'phone_code');
};

const resetPassword = async ({ phoneToken, userId, newPassword }, ctx) => {
    const { phone, codeId } = phoneCodes.readToken(phoneToken);
    const user = await findAccountOnPhone(userId, phone);
    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction(async (tx) => {
        await phoneCodes.consume(codeId, tx);
        await tx.user.update({
            where: { id: user.id },
            data: { passwordHash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
            select: { id: true },
        });
        // Whoever knew the old password may still be signed in somewhere.
        await sessions.revokeAllSessions(user.id, 'password_reset', {}, tx);
    });

    audit.record(EVENTS.PASSWORD_RESET, { userId: user.id, ctx, metadata: { method: 'phone' } });
    queueMail({ to: user.email, ...emails.passwordChanged() });
};

// Adds a phone to an account (e.g. one made with email/Google) or replaces it.
// Like an email change: re-auth first, other devices are signed out, the old
// number and the email are told.
const changePhone = async (auth, { phoneToken, password }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, ...WITH_PASSWORD });
    await assertReauthenticated(user, password, auth);

    const { phone, codeId } = phoneCodes.readToken(phoneToken);
    if (phone === user.phone) {
        throw new AppError('This is already your phone number', 400, undefined, 'PHONE_UNCHANGED');
    }

    const updated = await prisma.$transaction(async (tx) => {
        await phoneCodes.lockPhone(phone, tx);
        await phoneCodes.assertPhoneHasRoom(phone, tx);
        await phoneCodes.consume(codeId, tx);
        const updated = await tx.user.update({ where: { id: user.id }, data: { phone }, ...WITH_PASSWORD });
        await sessions.revokeAllSessions(user.id, 'phone_changed', { exceptSessionId: auth.sessionId }, tx);
        return updated;
    });

    audit.record(EVENTS.PHONE_CHANGED, { userId: user.id, ctx, metadata: { added: !user.phone } });
    queueMail({ to: user.email, ...emails.phoneChanged() });
    if (user.phone) queueSms({ to: user.phone, text: sms.phoneChanged() });
    return toPublicUser(updated);
};

module.exports = { sendCode, verifyCode, signup, login, resetPassword, changePhone };
