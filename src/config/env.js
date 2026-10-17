require('dotenv/config');
const { z } = require('zod');

const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().url(),
    CORS_ORIGINS: z.string().default(''),

    // Auth
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    // Keys the HMAC of password-reset codes, so a DB leak can't brute-force 6-digit codes offline.
    OTP_SECRET: z.string().min(32, 'must be at least 32 characters'),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(10),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    console.error('Invalid environment variables:');
    console.error(z.prettifyError(parsed.error));
    process.exit(1);
}

const env = parsed.data;

module.exports = {
    ...env,
    isProd: env.NODE_ENV === 'production',
    corsOrigins: env.CORS_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
};
