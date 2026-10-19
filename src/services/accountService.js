const prisma = require('../lib/prisma');
const env = require('../config/env');
const emails = require('../emails/authEmails');
const audit = require('./auditService');
const sessions = require('./sessionService');
const { queueMail } = require('../lib/mailer');
const { WITH_PASSWORD } = require('../utils/publicUser');
const { assertReauthenticated } = require('./reauthService');

const DAY_MS = 24 * 60 * 60 * 1000;

// Hides the account until the user logs back in (authService.completeLogin reactivates).
// Feeds/profiles in later phases must only show users whose status is ACTIVE.
const deactivate = async (auth, { password }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, ...WITH_PASSWORD });
    await assertReauthenticated(user, password, auth);

    await prisma.$transaction([
        prisma.user.update({
            where: { id: user.id },
            data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
            select: { id: true },
        }),
        sessions.revokeAllSessions(user.id, 'account_deactivated'),
    ]);
    audit.record(audit.EVENTS.ACCOUNT_DEACTIVATED, { userId: user.id, ctx });
};

// Soft delete with a grace period (as the app's FAQ promises): logging in before the
// date cancels it; after it, jobs/authCleanup.js hard-deletes the user and, through
// ON DELETE CASCADE, everything they own.
const scheduleDeletion = async (auth, { password }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: auth.id }, ...WITH_PASSWORD });
    await assertReauthenticated(user, password, auth);

    const deletionScheduledAt = new Date(Date.now() + env.ACCOUNT_DELETION_GRACE_DAYS * DAY_MS);
    await prisma.$transaction([
        prisma.user.update({
            where: { id: user.id },
            data: { status: 'PENDING_DELETION', deletionScheduledAt },
            select: { id: true },
        }),
        sessions.revokeAllSessions(user.id, 'account_deleted'),
    ]);
    audit.record(audit.EVENTS.DELETION_SCHEDULED, { userId: user.id, ctx, metadata: { deletionScheduledAt } });
    queueMail({ to: user.email, ...emails.deletionScheduled(deletionScheduledAt) });

    return { deletionScheduledAt };
};

module.exports = { deactivate, scheduleDeletion };
