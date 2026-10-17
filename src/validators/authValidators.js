const { z } = require('zod');

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
    .refine((v) => !/^[.]|[.]$|\.\./.test(v), 'cannot start or end with a dot, or contain ".."');

const password = z
    .string()
    .min(8, 'must be at least 8 characters')
    .max(128, 'must be at most 128 characters')
    .regex(/[A-Za-z]/, 'must contain a letter')
    .regex(/[0-9]/, 'must contain a number');

const name = z
    .string()
    .trim()
    .min(1, 'is required')
    .max(80, 'must be at most 80 characters');

const loginPassword = z.string().min(1, 'is required').max(128);

const signup = z.strictObject({ name, email, username, password });

const login = z.strictObject({ email, password: loginPassword });

const refresh = z.object({ refreshToken: z.string().min(1).max(512).optional() }).default({});

const forgotPassword = z.strictObject({ email });

const resetPassword = z.strictObject({
    email,
    otp: z.string().trim().regex(/^\d{6}$/, 'must be a 6-digit code'),
    newPassword: password,
});

const changePassword = z
    .strictObject({ currentPassword: loginPassword, newPassword: password })
    .refine((d) => d.currentPassword !== d.newPassword, {
        path: ['newPassword'],
        message: 'must be different from the current password',
    });

module.exports = { signup, login, refresh, forgotPassword, resetPassword, changePassword };
