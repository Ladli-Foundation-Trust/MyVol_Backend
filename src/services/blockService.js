const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const notifications = require('./notificationService');
const { removeFollow } = require('./followService');
const { CARD_SELECT, findActiveUser, relationsFor, toCard } = require('./socialGraph');

// Block and mute, as on Instagram. Neither person is told.
//
// Block (both directions once either side blocks): the blocked person can't find the
// blocker (404), see their posts or comments, follow them or get notified about them,
// and vice versa. Blocking removes follows and follow requests both ways (with the
// counters) and the notifications between them. Likes and comments already made stay
// but are hidden from each other. The visibility rules live in socialGraph
// (notBlockedWith / canView) and postService (findVisiblePost / visibleTo).
//
// Mute: the muted person's posts leave the muter's home feed, explore and reels.
// That's all; they can still follow each other and see each other's content.

const findTarget = async (viewerId, idOrUsername, verb) => {
    // Unblocking/unmuting must work even for someone who blocked you meanwhile.
    const target = await findActiveUser(idOrUsername, verb === 'block' || verb === 'mute' ? { viewerId } : {});
    if (target.id === viewerId) throw new AppError(`You can't ${verb} yourself`, 400, undefined, 'CANNOT_TARGET_SELF');
    return target;
};

const block = async (viewerId, idOrUsername) => {
    const target = await findTarget(viewerId, idOrUsername, 'block');
    const changed = await prisma.$transaction(async (tx) => {
        await tx.block.createMany({ data: [{ blockerId: viewerId, blockedId: target.id }], skipDuplicates: true });
        await removeFollow(tx, viewerId, target.id);
        await removeFollow(tx, target.id, viewerId);
        await tx.followRequest.deleteMany({
            where: { OR: [{ requesterId: viewerId, targetId: target.id }, { requesterId: target.id, targetId: viewerId }] },
        });
        // Notifications between them (either way) go; both badges may change.
        const between = {
            OR: [
                { recipientId: viewerId, actorId: target.id },
                { recipientId: target.id, actorId: viewerId },
            ],
        };
        const recipients = await notifications.recipientsOf(tx, between);
        await tx.notification.deleteMany({ where: between });
        return recipients;
    });
    notifications.syncCount(changed);
    return { blocked: true };
};

const unblock = async (viewerId, idOrUsername) => {
    const target = await findTarget(viewerId, idOrUsername, 'unblock');
    await prisma.block.deleteMany({ where: { blockerId: viewerId, blockedId: target.id } });
    return { blocked: false };
};

const mute = async (viewerId, idOrUsername) => {
    const target = await findTarget(viewerId, idOrUsername, 'mute');
    await prisma.mute.createMany({ data: [{ muterId: viewerId, mutedId: target.id }], skipDuplicates: true });
    return { muted: true };
};

const unmute = async (viewerId, idOrUsername) => {
    const target = await findTarget(viewerId, idOrUsername, 'unmute');
    await prisma.mute.deleteMany({ where: { muterId: viewerId, mutedId: target.id } });
    return { muted: false };
};

// The Settings pages "Blocked accounts" / "Muted accounts": newest first.
const listBlocked = async (viewerId, { cursor, limit }) => {
    const rows = await prisma.block.findMany({
        where: { blockerId: viewerId, blocked: { status: 'ACTIVE' }, ...afterCursor(cursor, 'blockedId') },
        orderBy: [{ createdAt: 'desc' }, { blockedId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, blockedId: true, blocked: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'blockedId');
    const rel = await relationsFor(viewerId, items.map((r) => r.blockedId));
    return { users: items.map((r) => ({ ...toCard(r.blocked, viewerId, rel), blockedAt: r.createdAt })), nextCursor };
};

const listMuted = async (viewerId, { cursor, limit }) => {
    const rows = await prisma.mute.findMany({
        where: { muterId: viewerId, muted: { status: 'ACTIVE' }, ...afterCursor(cursor, 'mutedId') },
        orderBy: [{ createdAt: 'desc' }, { mutedId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, mutedId: true, muted: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'mutedId');
    const rel = await relationsFor(viewerId, items.map((r) => r.mutedId));
    return { users: items.map((r) => ({ ...toCard(r.muted, viewerId, rel), mutedAt: r.createdAt })), nextCursor };
};

module.exports = { block, unblock, mute, unmute, listBlocked, listMuted };
