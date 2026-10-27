const prisma = require('../lib/prisma');
const env = require('../config/env');
const google = require('../lib/google');
const AppError = require('../utils/appError');
const emails = require('../emails/authEmails');
const audit = require('./auditService');
const sessions = require('./sessionService');
const codes = require('./verificationCodeService');
const { getSettings } = require('./settingsService');
const { queueMail } = require('../lib/mailer');
const { assertReauthenticated } = require('./reauthService');
const { usernameCandidates, isReserved } = require('../utils/username');
const { toE164, isPhoneLike } = require('../utils/phone');
const { WITH_PASSWORD, toPublicUser } = require('../utils/publicUser');
const { hashPassword, verifyPassword, verifyDummy } = require('../utils/password');

const { EVENTS } = audit;
const MINUTE_MS = 60 * 1000;

// Account lockout: every 5th consecutive failure locks the account, 15 min doubling
// each time (15, 30, 60...) up to a day. A correct login or a password reset clears it.
const LOCK_EVERY = 5;
const LOCK_BASE_MINUTES = 15;
const LOCK_MAX_MINUTES = 24 * 60;

const INVALID_CREDENTIALS = 'Incorrect username, email, phone number or password';

// ---------- helpers ----------

const assertAvailable = async ({ email, username }) => {
    const or = [email && { email }, username && { username }].filter(Boolean);
    const taken = await prisma.user.findFirst({ where: { OR: or }, select: { email: true } });
    if (!taken) return;
    if (email && taken.email === email) {
        throw new AppError('An account with this email already exists', 409, undefined, 'EMAIL_TAKEN');
    }
    throw new AppError('This username is taken', 409, undefined, 'USERNAME_TAKEN');
};

const pickUsername = async (emailLocalPart) => {
    for (const candidate of usernameCandidates(emailLocalPart)) {
        const exists = await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } });
        if (!exists) return candidate;
    }
    throw new AppError('Could not generate a username. Please choose one', 409, undefined, 'USERNAME_TAKEN');
};

// Local testing only (see EXPOSE_OTP_IN_RESPONSE): lets Postman read the code from the
// response instead of the console. Spread into results; empty when the flag is off.
const devOtp = (otp) => (env.EXPOSE_OTP_IN_RESPONSE ? { devOtp: otp } : {});

const sendVerificationCode = async (user) => {
    const otp = await codes.issue(user.id, 'EMAIL_VERIFICATION', { ttlMinutes: env.EMAIL_CODE_TTL_MINUTES });
    queueMail({ to: user.email, ...emails.verifyEmail(otp, env.EMAIL_CODE_TTL_MINUTES) });
    return devOtp(otp);
};

const recordFailedLogin = async (userId, ctx) => {
    const { failedLoginCount } = await prisma.user.update({
        where: { id: userId },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
    });
    audit.record(EVENTS.LOGIN_FAILED, { userId, ctx, metadata: { failedLoginCount } });

    if (failedLoginCount % LOCK_EVERY !== 0) return;
    const minutes = Math.min(LOCK_BASE_MINUTES * 2 ** (failedLoginCount / LOCK_EVERY - 1), LOCK_MAX_MINUTES);
    await prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + minutes * MINUTE_MS) },
        select: { id: true },
    });
    audit.record(EVENTS.ACCOUNT_LOCKED, { userId, ctx, metadata: { minutes } });
};

// Shared tail of every successful sign-in (password, phone or Google). Logging in also
// cancels a deactivation or a pending deletion, which is what the app promises users.
// A sign-in from a device the account hasn't used before is audited and, with the
// loginAlerts setting on (the default), emailed to the account.
const completeLogin = async (user, ctx, method, extra = {}) => {
    if (user.status === 'SUSPENDED') {
        audit.record(EVENTS.LOGIN_BLOCKED, { userId: user.id, ctx, metadata: { method } });
        throw new AppError('This account has been suspended', 403, undefined, 'ACCOUNT_SUSPENDED');
    }
    const reactivated = user.status !== 'ACTIVE';

    const { updated, tokens, newDevice } = await prisma.$transaction(async (tx) => {
        // A device = the app's deviceName + user agent. "New" only if the account has
        // signed in before, so the first login after signing up on a phone is quiet.
        const device = { deviceName: ctx.deviceName ?? null, userAgent: ctx.userAgent?.slice(0, 512) ?? null };
        // One at a time: a transaction is one connection.
        const seen = await tx.session.count({ where: { userId: user.id, ...device } });
        const earlier = await tx.session.count({ where: { userId: user.id } });
        const updated = await tx.user.update({
            where: { id: user.id },
            data: {
                status: 'ACTIVE',
                deactivatedAt: null,
                deletionScheduledAt: null,
                failedLoginCount: 0,
                lockedUntil: null,
                lastLoginAt: new Date(),
            },
            ...WITH_PASSWORD,
        });
        return { updated, tokens: await sessions.createSession(updated, ctx, tx), newDevice: earlier > 0 && seen === 0 };
    });

    audit.record(EVENTS.LOGIN, { userId: user.id, ctx, metadata: { method, newDevice } });
    if (reactivated) audit.record(EVENTS.ACCOUNT_REACTIVATED, { userId: user.id, ctx, metadata: { from: user.status } });
    if (newDevice) {
        audit.record(EVENTS.NEW_DEVICE_LOGIN, { userId: user.id, ctx, metadata: { method } });
        if ((await getSettings(user.id)).loginAlerts) {
            queueMail({ to: updated.email, ...emails.newLogin({ deviceName: ctx.deviceName, ip: ctx.ip, at: new Date() }) });
        }
    }

    return { user: toPublicUser(updated), ...tokens, reactivated, ...extra };
};

// ---------- sign up / sign in ----------

const signup = async ({ name, email, username, password, dateOfBirth }, ctx) => {
    await assertAvailable({ email, username });

    const passwordHash = await hashPassword(password);
    const { user, tokens } = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
            data: { name, email, username, dateOfBirth, passwordHash, termsAcceptedAt: new Date(), lastLoginAt: new Date() },
            ...WITH_PASSWORD,
        });
        return { user, tokens: await sessions.createSession(user, ctx, tx) };
    });

    audit.record(EVENTS.SIGNUP, { userId: user.id, ctx, metadata: { method: 'password' } });
    const dev = await sendVerificationCode(user);

    return { user: toPublicUser(user), ...tokens, ...dev };
};

const isLocked = (user) => user.lockedUntil && user.lockedUntil > new Date();

// An email or username matches at most one account; a phone number can match up to
// MAX_ACCOUNTS_PER_PHONE.
const findLoginCandidates = (identifier) => {
    const phone = isPhoneLike(identifier) && toE164(identifier);
    if (phone) return prisma.user.findMany({ where: { phone }, orderBy: { createdAt: 'asc' }, ...WITH_PASSWORD });
    const where = identifier.includes('@') ? { email: identifier } : { username: identifier };
    return prisma.user.findMany({ where, ...WITH_PASSWORD });
};

// For a phone with several accounts, the password picks the account (like Instagram).
// If two of them share a password the oldest wins; the user can log in with the
// username, or with an SMS code and the account picker, to reach the other.
const login = async ({ identifier, password }, ctx) => {
    const users = await findLoginCandidates(identifier);
    const unlocked = users.filter((u) => !isLocked(u));

    if (users.length > 0 && unlocked.length === 0) {
        const until = Math.min(...users.map((u) => u.lockedUntil.getTime()));
        const minutes = Math.ceil((until - Date.now()) / MINUTE_MS);
        throw new AppError(
            `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'} or reset your password`,
            429,
            undefined,
            'ACCOUNT_LOCKED',
        );
    }

    for (const user of unlocked) {
        if (user.passwordHash && (await verifyPassword(user.passwordHash, password))) {
            return completeLogin(user, ctx, 'password');
        }
    }

    // Unknown users still pay for an argon2 verify, so response time doesn't reveal
    // which emails/usernames/phones exist.
    if (!unlocked.some((u) => u.passwordHash)) await verifyDummy(password);

    if (users.length === 0) audit.record(EVENTS.LOGIN_FAILED, { ctx, metadata: { reason: 'unknown_user' } });
    for (const user of unlocked) await recordFailedLogin(user.id, ctx);
    throw new AppError(INVALID_CREDENTIALS, 401, undefined, 'INVALID_CREDENTIALS');
};

const loginWithGoogle = async ({ idToken, username, dateOfBirth, acceptTerms }, ctx) => {
    const profile = await google.verifyIdToken(idToken);
    if (!profile.email || !profile.emailVerified) {
        throw new AppError('Your Google account email is not verified', 400, undefined, 'GOOGLE_EMAIL_UNVERIFIED');
    }
    const { email } = profile;

    // 1. Returning Google user.
    const linked = await prisma.oAuthAccount.findUnique({
        where: { provider_providerUserId: { provider: 'GOOGLE', providerUserId: profile.sub } },
        include: { user: WITH_PASSWORD },
    });
    if (linked) return completeLogin(linked.user, ctx, 'google', { isNewUser: false });

    // 2. Existing email/password account: link Google to it. If that account never
    // verified its email, whoever created it may not own the address (a "pre-hijack"),
    // so their password and sessions are wiped: Google just proved who the owner is.
    const existing = await prisma.user.findUnique({ where: { email }, ...WITH_PASSWORD });
    if (existing) {
        const claimed = !existing.emailVerifiedAt;
        const user = await prisma.$transaction(async (tx) => {
            if (claimed) await sessions.revokeAllSessions(existing.id, 'account_claimed', {}, tx);
            await tx.oAuthAccount.create({
                data: { userId: existing.id, provider: 'GOOGLE', providerUserId: profile.sub, email },
            });
            return tx.user.update({
                where: { id: existing.id },
                data: {
                    emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
                    ...(claimed && { passwordHash: null, failedLoginCount: 0, lockedUntil: null }),
                },
                ...WITH_PASSWORD,
            });
        });
        audit.record(EVENTS.GOOGLE_LINKED, { userId: user.id, ctx, metadata: { claimed } });
        queueMail({ to: email, ...emails.googleLinked() });
        return completeLogin(user, ctx, 'google', { isNewUser: false });
    }

    // 3. New user. Google doesn't give us a birth date, and the age gate and terms
    // apply to everyone, so the app collects them and calls again with the same token.
    const missing = [!dateOfBirth && 'dateOfBirth', !acceptTerms && 'acceptTerms'].filter(Boolean);
    if (missing.length) {
        throw new AppError(
            'A few more details are needed to create your account',
            400,
            missing.map((field) => ({ field, message: 'is required' })),
            'PROFILE_REQUIRED',
        );
    }
    if (username) await assertAvailable({ username });

    const localPart = email.split('@')[0];
    const user = await prisma.user.create({
        data: {
            email,
            name: profile.name?.trim().slice(0, 80) || localPart,
            username: username ?? (await pickUsername(localPart)),
            dateOfBirth,
            emailVerifiedAt: new Date(),
            termsAcceptedAt: new Date(),
            oauthAccounts: { create: { provider: 'GOOGLE', providerUserId: profile.sub, email } },
        },
        ...WITH_PASSWORD,
    });
    audit.record(EVENTS.SIGNUP, { userId: user.id, ctx, metadata: { method: 'google' } });

    return completeLogin(user, ctx, 'google', { isNewUser: true });
};

const refresh = async (rawToken, ctx) => {
    const { user, ...tokens } = await sessions.rotate(rawToken, ctx);
    return { user: toPublicUser(user), ...tokens };
};

const logout = async (rawToken, ctx) => {
    if (!rawToken) return;
    const stored = await sessions.findSessionByRefreshToken(rawToken);
    if (!stored) return;
    await sessions.revokeSession(stored.session.id, 'logout');
    audit.record(EVENTS.LOGOUT, { userId: stored.session.userId, ctx });
};

const logoutAll = async (userId, ctx) => {
    await sessions.revokeAllSessions(userId, 'logout_all');
    audit.record(EVENTS.LOGOUT_ALL, { userId, ctx });
};

const getMe = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, ...WITH_PASSWORD });
    if (!user) throw new AppError('User not found', 404);
    return toPublicUser(user);
};

const checkUsername = async (username) => {
    if (isReserved(username)) return { available: false };
    const exists = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    return { available: !exists };
};

// ---------- email verification ----------

const verifyEmail = async (userId, { otp }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, ...WITH_PASSWORD });
    if (user.emailVerifiedAt) return toPublicUser(user);

    const record = await codes.check(userId, 'EMAIL_VERIFICATION', otp);
    const updated = await prisma.$transaction(async (tx) => {
        await codes.markUsed(record.id, tx);
        return tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() }, ...WITH_PASSWORD });
    });
    audit.record(EVENTS.EMAIL_VERIFIED, { userId, ctx });
    return toPublicUser(updated);
};

const resendEmailVerification = async (userId) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, emailVerifiedAt: true } });
    if (!user.email) {
        throw new AppError('Add an email to your account first', 400, undefined, 'NO_EMAIL');
    }
    if (user.emailVerifiedAt) {
        throw new AppError('Your email is already verified', 400, undefined, 'EMAIL_ALREADY_VERIFIED');
    }
    return sendVerificationCode(user);
};

// ---------- passwords ----------

// Always answers the same way, whether or not the email exists, so this endpoint
// can't be used to find out who has an account.
const requestPasswordReset = async ({ email }, ctx) => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return;

    let otp;
    try {
        otp = await codes.issue(user.id, 'PASSWORD_RESET', { ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES });
    } catch (err) {
        if (err.statusCode === 429) return; // cooldown/limit: stay silent, same response
        throw err;
    }
    queueMail({ to: email, ...emails.passwordReset(otp, env.PASSWORD_RESET_TTL_MINUTES) });
    audit.record(EVENTS.PASSWORD_RESET_REQUESTED, { userId: user.id, ctx });
    return devOtp(otp);
};

const resetPassword = async ({ email, otp, newPassword }, ctx) => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
    if (!user) throw new AppError('Invalid or expired code', 400, undefined, 'INVALID_CODE');

    const record = await codes.check(user.id, 'PASSWORD_RESET', otp);
    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction(async (tx) => {
        await codes.markUsed(record.id, tx);
        await tx.user.update({
            where: { id: user.id },
            data: {
                passwordHash,
                passwordChangedAt: new Date(),
                failedLoginCount: 0,
                lockedUntil: null,
                // Receiving the code proves the user owns the inbox.
                emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            },
            select: { id: true },
        });
        // Whoever knew the old password may still be signed in somewhere.
        await sessions.revokeAllSessions(user.id, 'password_reset', {}, tx);
    });

    audit.record(EVENTS.PASSWORD_RESET, { userId: user.id, ctx });
    queueMail({ to: email, ...emails.passwordChanged() });
};

// Also how Google-only users add a password: they have none to confirm, so they
// must have signed in recently instead.
const changePassword = async (auth, { currentPassword, newPassword }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, ...WITH_PASSWORD });
    await assertReauthenticated(user, currentPassword, auth);

    const passwordHash = await hashPassword(newPassword);
    const updated = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
            where: { id: user.id },
            data: { passwordHash, passwordChangedAt: new Date() },
            ...WITH_PASSWORD,
        });
        // Sign out every other device; this one stays logged in.
        await sessions.revokeAllSessions(user.id, 'password_changed', { exceptSessionId: auth.sessionId }, tx);
        return updated;
    });

    audit.record(EVENTS.PASSWORD_CHANGED, { userId: user.id, ctx });
    queueMail({ to: user.email, ...emails.passwordChanged() });
    return toPublicUser(updated);
};

// ---------- email change ----------

// Step 1: confirm identity, then send a code to the NEW address. Nothing changes
// until that inbox proves it belongs to the user.
const requestEmailChange = async (auth, { newEmail, password }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, ...WITH_PASSWORD });
    await assertReauthenticated(user, password, auth);

    if (newEmail === user.email) {
        throw new AppError('This is already your email', 400, undefined, 'EMAIL_UNCHANGED');
    }
    await assertAvailable({ email: newEmail });

    const otp = await codes.issue(user.id, 'EMAIL_CHANGE', { ttlMinutes: env.EMAIL_CODE_TTL_MINUTES, target: newEmail });
    queueMail({ to: newEmail, ...emails.emailChange(otp, env.EMAIL_CODE_TTL_MINUTES) });
    audit.record(EVENTS.EMAIL_CHANGE_REQUESTED, { userId: user.id, ctx });
    return devOtp(otp);
};

// Step 2: the code from the new inbox swaps the email and signs out other devices.
// The old address is told, so a hijacker can't quietly move the account.
const confirmEmailChange = async (auth, { otp }, ctx) => {
    const record = await codes.check(auth.id, 'EMAIL_CHANGE', otp);
    const user = await prisma.user.findUnique({ where: { id: auth.id }, select: { email: true } });
    await assertAvailable({ email: record.target });

    const updated = await prisma.$transaction(async (tx) => {
        await codes.markUsed(record.id, tx);
        const updated = await tx.user.update({
            where: { id: auth.id },
            data: { email: record.target, emailVerifiedAt: new Date() },
            ...WITH_PASSWORD,
        });
        await sessions.revokeAllSessions(auth.id, 'email_changed', { exceptSessionId: auth.sessionId }, tx);
        return updated;
    });

    audit.record(EVENTS.EMAIL_CHANGED, { userId: auth.id, ctx });
    queueMail({ to: user.email, ...emails.emailChanged(record.target) });
    return toPublicUser(updated);
};

module.exports = {
    // shared with phoneAuthService
    assertAvailable,
    completeLogin,
    devOtp,

    signup,
    login,
    loginWithGoogle,
    refresh,
    logout,
    logoutAll,
    getMe,
    checkUsername,
    verifyEmail,
    resendEmailVerification,
    requestPasswordReset,
    resetPassword,
    changePassword,
    requestEmailChange,
    confirmEmailChange,
};
