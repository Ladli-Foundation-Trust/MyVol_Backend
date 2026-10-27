const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');

// Shared building blocks for anything that shows another user: profiles, follow
// lists, posts, comments, notifications and search. Blocks plug in here, so every
// one of those follows the same rules.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns needed to render a user anywhere (activityVisibility: for canViewActivities).
const CARD_SELECT = { id: true, username: true, name: true, avatarKey: true, isPrivate: true, activityVisibility: true };

// Prisma `where` for a User relation: neither that user nor the viewer has blocked the
// other. Spread it next to `status: 'ACTIVE'` wherever other people are listed.
const notBlockedWith = (viewerId) => ({
    blocksMade: { none: { blockedId: viewerId } },
    blocksReceived: { none: { blockerId: viewerId } },
});

// Routes take `:user` as either the id or the username. Usernames can't contain
// "-", so a UUID can never be mistaken for one. Deactivated, suspended and
// pending-deletion users don't exist as far as other people can tell, and neither
// does anyone who blocked the viewer. (Someone the viewer blocked is still found,
// so they can see the profile and unblock.)
const findActiveUser = async (idOrUsername, { viewerId, select = CARD_SELECT } = {}) => {
    const where = UUID.test(idOrUsername) ? { id: idOrUsername } : { username: idOrUsername.toLowerCase() };
    const user = await prisma.user.findFirst({
        where: { ...where, status: 'ACTIVE', ...(viewerId && { blocksMade: { none: { blockedId: viewerId } } }) },
        select,
    });
    if (!user) throw new AppError('User not found', 404, undefined, 'USER_NOT_FOUND');
    return user;
};

// The viewer's relationship to each of `userIds`, in four queries whatever the count.
// Returns rel(id) → { followStatus: 'following' | 'requested' | 'none', followsYou,
// blockedByMe, blocksMe }.
const relationsFor = async (viewerId, userIds) => {
    const ids = [...new Set(userIds.filter((id) => id !== viewerId))];
    if (ids.length === 0) return () => ({ followStatus: 'none', followsYou: false, blockedByMe: false, blocksMe: false });

    const [following, requested, followers, blocks] = await Promise.all([
        prisma.follow.findMany({ where: { followerId: viewerId, followingId: { in: ids } }, select: { followingId: true } }),
        prisma.followRequest.findMany({ where: { requesterId: viewerId, targetId: { in: ids } }, select: { targetId: true } }),
        prisma.follow.findMany({ where: { followingId: viewerId, followerId: { in: ids } }, select: { followerId: true } }),
        prisma.block.findMany({
            where: { OR: [{ blockerId: viewerId, blockedId: { in: ids } }, { blockedId: viewerId, blockerId: { in: ids } }] },
            select: { blockerId: true, blockedId: true },
        }),
    ]);
    const followingSet = new Set(following.map((f) => f.followingId));
    const requestedSet = new Set(requested.map((r) => r.targetId));
    const followerSet = new Set(followers.map((f) => f.followerId));
    const blockedByMe = new Set(blocks.filter((b) => b.blockerId === viewerId).map((b) => b.blockedId));
    const blocksMe = new Set(blocks.filter((b) => b.blockedId === viewerId).map((b) => b.blockerId));

    return (id) => ({
        followStatus: followingSet.has(id) ? 'following' : requestedSet.has(id) ? 'requested' : 'none',
        followsYou: followerSet.has(id),
        blockedByMe: blockedByMe.has(id),
        blocksMe: blocksMe.has(id),
    });
};

// THE privacy rule: you see a profile's details, lists and posts if it is yours, or
// there is no block between you and it is public or you are an approved follower.
// `relation` is rel(user.id) from relationsFor.
const canView = (viewerId, user, relation) => {
    if (user.id === viewerId) return true;
    if (relation.blockedByMe || relation.blocksMe) return false;
    return !user.isPrivate || relation.followStatus === 'following';
};

// Posts ("activities") add the owner's whoCanViewActivities on top of canView:
// 'everyone', 'followers' (approved followers only, even on a public account) or
// 'onlyMe' (a private log). postService.visibleTo is the same rule as a Prisma `where`.
const canViewActivities = (viewerId, user, relation) => {
    if (user.id === viewerId) return true;
    if (!canView(viewerId, user, relation)) return false;
    if (user.activityVisibility === 'onlyMe') return false;
    return user.activityVisibility !== 'followers' || relation.followStatus === 'following';
};

const isBlockedBetween = async (a, b, db = prisma) =>
    (await db.block.count({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } })) > 0;

// A user as a row in a list (followers, requests, likes, search...).
const toCard = (user, viewerId, rel) => {
    const isMe = user.id === viewerId;
    const { followStatus, followsYou } = rel(user.id);
    return {
        id: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: storage.urlFor(user.avatarKey),
        isPrivate: user.isPrivate,
        isMe,
        followStatus: isMe ? null : followStatus,
        followsYou: isMe ? false : followsYou,
    };
};

module.exports = { CARD_SELECT, notBlockedWith, findActiveUser, relationsFor, canView, canViewActivities, isBlockedBetween, toCard };
