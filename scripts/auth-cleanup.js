// For an external scheduler (cron, Render/Railway cron job): `npm run auth:cleanup`.
const prisma = require('../src/lib/prisma');
const { runAuthCleanup } = require('../src/jobs/authCleanup');

runAuthCleanup()
    .then((result) => console.log('[auth-cleanup]', result ?? 'skipped: another instance holds the lock'))
    .catch((err) => {
        console.error('[auth-cleanup] failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
