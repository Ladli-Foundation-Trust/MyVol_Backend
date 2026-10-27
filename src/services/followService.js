const prisma = require('../lib/prisma');
const AppError = require('../utils/appError');
const { afterCursor, toPage } = require('../utils/cursor');
const notifications = require('./notificationService');
const { getSettings } = require('./settingsService');
const { CARD_SELECT, notBlockedWith, findActiveUser, relationsFor, canView, isBlockedBetween, toCard } = require('./socialGraph');

// ---------- follow policy (privateAccount + whoCanFollow) ----------

// New followers need approval when the account is private, or public with
// whoCanFollow = 'approve' (the app's "Approve requests"). 'none' pauses new followers.
const requiresApproval = ({ isPrivate, whoCanFollow }) => isPrivate || whoCanFollow === 'approve';

// ---------- the only code that writes follows (keeps the counters right) ----------

// createMany/deleteMany report how many rows really changed, so a double tap or two
// concurrent requests can't bump a counter twice.
const addFollow = async (tx, followerId, followingId) => {
    const { count } = await tx.follow.createMany({ data: [{ followerId, followingId }], skipDuplicates: true });
    if (count === 0) return;
    await tx.user.update({ where: { id: followerId }, data: { followingCount: { increment: 1 } }, select: { id: true } });
    await tx.user.update({ where: { id: followingId }, data: { followersCount: { increment: 1 } }, select: { id: true } });
};

const removeFollow = async (tx, followerId, followingId) => {
    const { count } = await tx.follow.deleteMany({ where: { followerId, followingId } });
    if (count === 0) return;
    await tx.user.update({ where: { id: followerId }, data: { followingCount: { decrement: 1 } }, select: { id: true } });
    await tx.user.update({ where: { id: followingId }, data: { followersCount: { decrement: 1 } }, select: { id: true } });
};

// Used when an account stops needing approval (private -> public, or whoCanFollow
// 'approve' -> 'everyone'/'none'): everyone waiting gets in.
const acceptAllRequests = async (tx, userId) => {
    const requests = await tx.followRequest.findMany({ where: { targetId: userId }, select: { requesterId: true } });
    for (const { requesterId } of requests) await addFollow(tx, requesterId, userId);
    await tx.followRequest.deleteMany({ where: { targetId: userId } });
    await notifications.allRequestsAccepted(tx, userId);
};

// Call in the transaction that changed isPrivate / whoCanFollow, with the policy before
// and after ({ isPrivate, whoCanFollow }).
const settlePendingRequests = async (tx, userId, before, after) => {
    if (requiresApproval(before) && !requiresApproval(after)) await acceptAllRequests(tx, userId);
};

// ---------- actions ----------

// Public account: follows at once. Private account (or whoCanFollow 'approve'): leaves
// a request. whoCanFollow 'none': refused, existing followers stay. Repeating the call
// is harmless and returns the current state.
const follow = async (viewerId, idOrUsername) => {
    const target = await findActiveUser(idOrUsername, { viewerId }); // 404 if they blocked you
    if (target.id === viewerId) throw new AppError("You can't follow yourself", 400, undefined, 'CANNOT_FOLLOW_SELF');
    if (await isBlockedBetween(viewerId, target.id)) {
        throw new AppError('Unblock this account to follow it', 403, undefined, 'USER_BLOCKED');
    }
    const { whoCanFollow } = await getSettings(target.id);

    const { followStatus, notificationId } = await prisma.$transaction(async (tx) => {
        const pair = { followerId_followingId: { followerId: viewerId, followingId: target.id } };
        if (await tx.follow.findUnique({ where: pair, select: { createdAt: true } })) return { followStatus: 'following' };
        if (whoCanFollow === 'none') {
            throw new AppError('This account is not accepting new followers', 403, undefined, 'FOLLOWS_PAUSED');
        }

        if (requiresApproval({ isPrivate: target.isPrivate, whoCanFollow })) {
            await tx.followRequest.createMany({ data: [{ requesterId: viewerId, targetId: target.id }], skipDuplicates: true });
            return { followStatus: 'requested', notificationId: await notifications.followRequested(tx, viewerId, target.id) };
        }
        await addFollow(tx, viewerId, target.id);
        return { followStatus: 'following', notificationId: await notifications.followed(tx, viewerId, target.id) };
    });
    notifications.deliver(notificationId);
    return { followStatus };
};

// Unfollow, or cancel a pending request. Harmless if neither exists.
const unfollow = async (viewerId, idOrUsername) => {
    const target = await findActiveUser(idOrUsername);
    const changed = await prisma.$transaction(async (tx) => {
        await removeFollow(tx, viewerId, target.id);
        await tx.followRequest.deleteMany({ where: { requesterId: viewerId, targetId: target.id } });
        return notifications.followRemoved(tx, viewerId, target.id);
    });
    notifications.syncCount(changed);
    return { followStatus: 'none' };
};

// "Remove follower": mainly for private accounts to drop someone already approved.
const removeFollower = async (viewerId, idOrUsername) => {
    const follower = await findActiveUser(idOrUsername);
    await prisma.$transaction((tx) => removeFollow(tx, follower.id, viewerId));
};

const acceptRequest = async (viewerId, requesterId) => {
    const notificationId = await prisma.$transaction(async (tx) => {
        const { count } = await tx.followRequest.deleteMany({ where: { requesterId, targetId: viewerId } });
        if (count === 0) throw new AppError('Follow request not found', 404, undefined, 'REQUEST_NOT_FOUND');
        await addFollow(tx, requesterId, viewerId);
        return notifications.requestAccepted(tx, requesterId, viewerId);
    });
    notifications.deliver(notificationId);
    notifications.syncCount(viewerId); // their request notification is now read
};

const declineRequest = async (viewerId, requesterId) => {
    const changed = await prisma.$transaction(async (tx) => {
        const { count } = await tx.followRequest.deleteMany({ where: { requesterId, targetId: viewerId } });
        if (count === 0) throw new AppError('Follow request not found', 404, undefined, 'REQUEST_NOT_FOUND');
        return notifications.followRemoved(tx, requesterId, viewerId);
    });
    notifications.syncCount(changed);
};

// ---------- lists (newest first, cursor-paginated) ----------

// mode 'followers': people who follow `idOrUsername`; 'following': people they follow.
const listFollows = async (viewerId, idOrUsername, mode, { cursor, limit }) => {
    const user = await findActiveUser(idOrUsername, { viewerId });
    const rel = await relationsFor(viewerId, [user.id]);
    if (!canView(viewerId, user, rel(user.id))) {
        throw new AppError('This account is private', 403, undefined, 'PRIVATE_ACCOUNT');
    }

    const followers = mode === 'followers';
    const ownSide = followers ? 'followingId' : 'followerId'; // the column that is `user`
    const otherSide = followers ? 'followerId' : 'followingId'; // the people listed
    const otherUser = followers ? 'follower' : 'following';

    const rows = await prisma.follow.findMany({
        where: { [ownSide]: user.id, [otherUser]: { status: 'ACTIVE', ...notBlockedWith(viewerId) }, ...afterCursor(cursor, otherSide) },
        orderBy: [{ createdAt: 'desc' }, { [otherSide]: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, [otherSide]: true, [otherUser]: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, otherSide);

    const relOfListed = await relationsFor(viewerId, items.map((r) => r[otherSide]));
    return { users: items.map((r) => toCard(r[otherUser], viewerId, relOfListed)), nextCursor };
};

const listRequests = async (viewerId, { cursor, limit }) => {
    const rows = await prisma.followRequest.findMany({
        where: { targetId: viewerId, requester: { status: 'ACTIVE', ...notBlockedWith(viewerId) }, ...afterCursor(cursor, 'requesterId') },
        orderBy: [{ createdAt: 'desc' }, { requesterId: 'desc' }],
        take: limit + 1,
        select: { createdAt: true, requesterId: true, requester: { select: CARD_SELECT } },
    });
    const { items, nextCursor } = toPage(rows, limit, 'requesterId');

    const rel = await relationsFor(viewerId, items.map((r) => r.requesterId));
    return {
        requests: items.map((r) => ({ user: toCard(r.requester, viewerId, rel), requestedAt: r.createdAt })),
        nextCursor,
    };
};

module.exports = {
    requiresApproval,
    removeFollow,
    acceptAllRequests,
    settlePendingRequests,
    follow,
    unfollow,
    removeFollower,
    acceptRequest,
    declineRequest,
    listFollows,
    listRequests,
};
