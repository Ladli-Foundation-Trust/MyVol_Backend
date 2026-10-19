// Placeholder seed. Phase 1 replaces this with data built from the app's
// src/data/seed*.js files.
const prisma = require('../src/lib/prisma');

async function main() {
    await prisma.user.upsert({
        where: { email: 'admin@myvolapp.local' },
        update: {},
        create: {
            email: 'admin@myvolapp.local',
            username: 'admin',
            name: 'Admin',
            role: 'ADMIN',
            emailVerifiedAt: new Date(),
        },
    });
    console.log('Seed complete');
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
