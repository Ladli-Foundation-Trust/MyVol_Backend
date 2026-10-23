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

    // Phone sign-up/login. Codes are printed to the console until an SMS provider is wired in.
    PHONE_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    MAX_ACCOUNTS_PER_PHONE: z.coerce.number().int().positive().default(4),

    // Profiles. Uploads are stored on local disk under UPLOAD_DIR and served at
    // PUBLIC_BASE_URL/uploads (set it to the LAN IP, e.g. http://192.168.1.5:3000, for a phone).
    PUBLIC_BASE_URL: z.url().optional(),
    UPLOAD_DIR: z.string().default('uploads'),
    MAX_AVATAR_MB: z.coerce.number().positive().max(20).default(5),
    USERNAME_CHANGE_COOLDOWN_DAYS: z.coerce.number().int().min(0).default(14),

    // Posts. Until reviewers can approve posts (moderation phase), new posts are
    // approved on creation; set false once that ships so they start UNDER_REVIEW.
    POST_AUTO_APPROVE: z.stringbool().default(true),
    MAX_POST_IMAGE_MB: z.coerce.number().positive().max(30).default(10),
    // Videos are processed on this server for now (lib/videos.js), so keep them short.
    MAX_POST_VIDEO_MB: z.coerce.number().positive().max(1024).default(100),
    MAX_VIDEO_SECONDS: z.coerce.number().int().positive().max(900).default(180),

    // Notifications reach the app over our own WebSocket (lib/realtime.js), no push service.
    // Quiet hours (22:00–07:00) are judged in this zone until users have their own.
    DEFAULT_TIMEZONE: z
        .string()
        .default('Asia/Kolkata')
        .refine((tz) => {
            try {
                new Intl.DateTimeFormat('en', { timeZone: tz });
                return true;
            } catch {
                return false;
            }
        }, 'must be an IANA time zone such as Asia/Kolkata'),
    NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

    // Moderation: an approved post reported by this many different people is hidden
    // (back to UNDER_REVIEW) until a reviewer looks at it. 0 turns it off.
    REPORT_AUTO_HIDE_THRESHOLD: z.coerce.number().int().min(0).default(5),

    // Google sign-in: every OAuth client ID whose ID tokens we accept (Android, iOS, web).
    GOOGLE_CLIENT_IDS: z.string().default(''),

    // Email. Without SMTP_URL, mail is printed to the console outside production.
    SMTP_URL: z.url().optional(),
    MAIL_FROM: z.string().default('MyVolApp <no-reply@myvolapp.local>'),

    // Local testing only (Postman): echo 6-digit codes back as `devOtp` in API responses.
    EXPOSE_OTP_IN_RESPONSE: z.stringbool().default(false),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.prettifyError(parsed.error));
    process.exit(1);
}

const env = parsed.data;

// Codes in responses would let anyone verify any email or reset any password.
if (env.NODE_ENV === 'production' && env.EXPOSE_OTP_IN_RESPONSE) {
    console.error('EXPOSE_OTP_IN_RESPONSE must not be enabled in production.');
    process.exit(1);
}

if (env.NODE_ENV === 'production' && !env.SMTP_URL) {
    console.warn('[env] SMTP_URL is not set: verification and reset codes cannot be delivered.');
}

module.exports = {
    ...env,
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: list(env.CORS_ORIGINS),
    googleClientIds: list(env.GOOGLE_CLIENT_IDS),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, ''),
};
