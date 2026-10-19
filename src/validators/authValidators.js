const { z } = require('zod');
const env = require('../config/env');
const { isReserved } = require('../utils/username');
const COMMON_PASSWORDS = require('./commonPasswords');

const email = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('must be a valid email address').max(254));

const username = z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'must be at least 3 characters')
    .max(30, 'must be at most 30 characters')
    .regex(/^[a-z0-9._]+$/, 'may contain only letters, numbers, dots and underscores')
    .refine((v) => !/^[.]|[.]$|\.\./.test(v), 'cannot start or end with a dot, or contain ".."')
    .refine((v) => !/^\d+$/.test(v), 'must contain a letter')
    .refine((v) => !isReserved(v), 'is not available');

// NIST 800-63B: favour length and a blocklist over complex composition rules.
const password = z
    .string()
    .min(8, 'must be at least 8 characters')
    .max(128, 'must be at most 128 characters')
    .regex(/[A-Za-z]/, 'must contain a letter')
    .regex(/[0-9]/, 'must contain a number')
    .refine((v) => !COMMON_PASSWORDS.has(v.toLowerCase()), 'is too common. Please choose another');

const name = z
    .string()
    .trim()
    .min(1, 'is required')
    .max(80, 'must be at most 80 characters');

const ageOn = (dob, now) => {
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const m = now.getUTCMonth() - dob.getUTCMonth();
    if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
    return age;
};

// "YYYY-MM-DD" → Date at UTC midnight (stored in a DATE column).
const dateOfBirth = z.iso
    .date('must be a date in YYYY-MM-DD format')
    .transform((v) => new Date(`${v}T00:00:00Z`))
    .refine((d) => ageOn(d, new Date()) >= env.MIN_SIGNUP_AGE, `you must be at least ${env.MIN_SIGNUP_AGE} to join`)
    .refine((d) => ageOn(d, new Date()) <= 120, 'must be a real date of birth');

const acceptTerms = z.literal(true, { error: 'you must accept the Terms and Privacy Policy' });

const deviceName = z.string().trim().max(100).optional();

const otp = z.string().trim().regex(/^\d{6}$/, 'must be a 6-digit code');

const loginPassword = z.string().min(1, 'is required').max(128);

const signup = z
    .strictObject({ name, email, username, password, dateOfBirth, acceptTerms, deviceName })
    .superRefine((d, ctx) => {
        const pw = d.password.toLowerCase();
        const personal = [d.username, d.email.split('@')[0]].filter((s) => s.length >= 4);
        if (personal.some((s) => pw.includes(s))) {
            ctx.addIssue({ code: 'custom', path: ['password'], message: 'must not contain your username or email' });
        }
    });

// `identifier` is an email or a username.
const login = z.strictObject({
    identifier: z.string().trim().toLowerCase().min(1, 'is required').max(254),
    password: loginPassword,
    deviceName,
});

const google = z.strictObject({
    idToken: z.string().min(1, 'is required').max(4096),
    username: username.optional(),
    dateOfBirth: dateOfBirth.optional(),
    acceptTerms: acceptTerms.optional(),
    deviceName,
});

const refresh = z.object({ refreshToken: z.string().min(1).max(512).optional() }).default({});

const usernameQuery = z.strictObject({ username });

const forgotPassword = z.strictObject({ email });

const resetPassword = z.strictObject({ email, otp, newPassword: password });

// currentPassword is optional only for Google-only accounts setting their first
// password; the service decides whether it is required.
const changePassword = z
    .strictObject({ currentPassword: loginPassword.optional(), newPassword: password })
    .refine((d) => d.currentPassword !== d.newPassword, {
        path: ['newPassword'],
        message: 'must be different from the current password',
    });

const verifyCode = z.strictObject({ otp });

const emailChange = z.strictObject({ newEmail: email, password: loginPassword.optional() });

const confirmPassword = z.strictObject({ password: loginPassword.optional() }).default({});

const sessionParams = z.strictObject({ sessionId: z.uuid('is not a valid session id') });

module.exports = {
    signup,
    login,
    google,
    refresh,
    usernameQuery,
    forgotPassword,
    resetPassword,
    changePassword,
    verifyCode,
    emailChange,
    confirmPassword,
    sessionParams,
};
