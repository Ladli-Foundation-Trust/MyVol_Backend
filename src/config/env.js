require('dotenv/config');
const { z } = require('zod');

const list = (value) =>
    value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.url(),
    CORS_ORIGINS: z.string().default(''),
    APP_NAME: z.string().default('MyVolApp'),

    // Auth
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    MAX_SESSIONS_PER_USER: z.coerce.number().int().positive().default(10),
    // Keys the HMAC of 6-digit codes, so a DB leak can't brute-force them offline.
    OTP_SECRET: z.string().min(32, 'must be at least 32 characters'),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    EMAIL_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    MIN_SIGNUP_AGE: z.coerce.number().int().min(13).default(13),
    ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().positive().default(30),
    REAUTH_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),

    // Google sign-in: every OAuth client ID whose ID tokens we accept (Android, iOS, web).
    GOOGLE_CLIENT_IDS: z.string().default(''),

    // Email. Without SMTP_URL, mail is printed to the console outside production.
    SMTP_URL: z.url().optional(),
    MAIL_FROM: z.string().default('MyVolApp <no-reply@myvolapp.local>'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.prettifyError(parsed.error));
    process.exit(1);
}

const env = parsed.data;

if (env.NODE_ENV === 'production' && !env.SMTP_URL) {
    console.warn('[env] SMTP_URL is not set: verification and reset codes cannot be delivered.');
}

module.exports = {
    ...env,
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: list(env.CORS_ORIGINS),
    googleClientIds: list(env.GOOGLE_CLIENT_IDS),
};
