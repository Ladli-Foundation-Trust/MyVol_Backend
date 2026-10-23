// Gives an account a staff role from the command line. This is how the first admin is
// made; after that, admins use POST /api/v1/admin/users/:userId/role.
//
//   npm run user:role -- <username or email> ADMIN      (or REVIEWER, USER)
//
// The change is logged in moderation_actions (moderator: none = command line).
const prisma = require('../src/lib/prisma');

const ROLES = ['USER', 'REVIEWER', 'ADMIN'];

const main = async () => {
    const [who, roleArg] = process.argv.slice(2);
    const role = roleArg?.toUpperCase();
    if (!who || !ROLES.includes(role)) {
        console.log(`Usage: npm run user:role -- <username or email> <${ROLES.join(' | ')}>`);
        process.exitCode = 1;
        return;
    }

    const key = who.toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ username: key }, { email: key }] },
        select: { id: true, username: true, role: true, status: true },
    });
    if (!user) {
        console.error(`No account "${who}".`);
        process.exitCode = 1;
        return;
    }

    await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { role } }),
        prisma.moderationAction.create({
            data: { action: 'SET_ROLE', targetType: 'user', targetId: user.id, reason: 'command line', metadata: { from: user.role, to: role } },
        }),
    ]);
    console.log(`@${user.username}: ${user.role} → ${role}${user.status !== 'ACTIVE' ? ` (account is ${user.status})` : ''}`);
};

main()
    .catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
