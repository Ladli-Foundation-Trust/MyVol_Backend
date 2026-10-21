const prisma = require('../lib/prisma');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');

// Shared building blocks for anything that shows another user: profiles, follow
// lists, and later posts, comments and search. Block/mute (later phase) plug in here.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Columns needed to render a user anywhere.
const CARD_SELECT = { id: true, username: true, name: true, avatarKey: true, isPrivate: true };

// Routes take `:user` as either the id or the username. Usernames can't contain
// "-", so a UUID can never be mistaken for one. Deactivated, suspended and
// pending-deletion users don't exist as far as other people can tell.
const findActiveUser = async (idOrUsername, select = CARD_SELECT) => {
    const where = UUID.test(idOrUsername) ? { id: idOrUsername } : { username: idOrUsername.toLowerCase() };
    const user = await prisma.user.findFirst({ where: { ...where, status: 'ACTIVE' }, select });
    if (!user) throw new AppError('User not found', 404, undefined, 'USER_NOT_FOUND');
    return user;
};

// The viewer's relationship to each of `userIds`, in three queries whatever the count.
// Returns rel(id) → { followStatus: 'following' | 'requested' | 'none', followsYou }.
const relationsFor = async (viewerId, userIds) => {
    const ids = userIds.filter((id) => id !== viewerId);
    if (ids.length === 0) return () => ({ followStatus: 'none', followsYou: false });

    const [following, requested, followers] = await Promise.all([
        prisma.follow.findMany({ where: { followerId: viewerId, followingId: { in: ids } }, select: { followingId: true } }),
        prisma.followRequest.findMany({ where: { requesterId: viewerId, targetId: { in: ids } }, select: { targetId: true } }),
        prisma.follow.findMany({ where: { followingId: viewerId, followerId: { in: ids } }, select: { followerId: true } }),
    ]);
    const followingSet = new Set(following.map((f) => f.followingId));
    const requestedSet = new Set(requested.map((r) => r.targetId));
    const followerSet = new Set(followers.map((f) => f.followerId));

    return (id) => ({
        followStatus: followingSet.has(id) ? 'following' : requestedSet.has(id) ? 'requested' : 'none',
        followsYou: followerSet.has(id),
    });
};

// THE privacy rule: you see a profile's details, lists and (later) posts if it is
// yours, it is public, or you are an approved follower.
const canView = (viewerId, user, followStatus) => user.id === viewerId || !user.isPrivate || followStatus === 'following';

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

module.exports = { CARD_SELECT, findActiveUser, relationsFor, canView, toCard };
