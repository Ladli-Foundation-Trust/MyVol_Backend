// Deletes the test users the Postman collection creates on every run.
//   npm run db:clean-postman          → lists them (dry run)
//   npm run db:clean-postman -- --yes → deletes them
//
// Postman users have random handles starting pm_ / ph_ / em_ (random, because email
// and username must be unique on every run) and an @example.com email or none
// (phone sign-ups). Both must match, so real accounts are never picked up.
const env = require('../src/config/env');
const prisma = require('../src/lib/prisma');
const { runAuthCleanup } = require('../src/jobs/authCleanup');

const POSTMAN_USERS = {
    OR: [{ username: { startsWith: 'pm_' } }, { username: { startsWith: 'ph_' } }, { username: { startsWith: 'em_' } }],
    AND: [{ OR: [{ email: null }, { email: { endsWith: '@example.com' } }] }],
};

const main = async () => {
    if (env.isProd) throw new Error('Refusing to run in production');

    const users = await prisma.user.findMany({
        where: POSTMAN_USERS,
        orderBy: { createdAt: 'asc' },
        select: { id: true, username: true, email: true, phone: true, name: true },
    });
    for (const u of users) console.log(`  ${u.username.padEnd(24)} ${(u.email ?? u.phone ?? '').padEnd(34)} ${u.name}`);

    if (!process.argv.includes('--yes')) {
        console.log(`\n${users.length} Postman test users found. Run with -- --yes to delete them.`);
        return;
    }

    // Through the normal purge, so other users' follower counts are corrected and
    // avatar files are removed along with the rows.
    await prisma.user.updateMany({
        where: { id: { in: users.map((u) => u.id) } },
        data: { status: 'PENDING_DELETION', deletionScheduledAt: new Date() },
    });
    const result = await runAuthCleanup();
    console.log(`\nDeleted ${result?.purgedUsers ?? 0} users.`, result);
};

main()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
