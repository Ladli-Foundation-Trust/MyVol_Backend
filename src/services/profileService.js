const crypto = require('crypto');
const prisma = require('../lib/prisma');
const env = require('../config/env');
const storage = require('../lib/storage');
const AppError = require('../utils/appError');
const audit = require('./auditService');
const { toAvatar } = require('../lib/images');
const { acceptAllRequests } = require('./followService');
const impact = require('./impactService');
const { findActiveUser, relationsFor, canView } = require('./socialGraph');

const DAY_MS = 24 * 60 * 60 * 1000;

const PROFILE_SELECT = {
    id: true,
    username: true,
    name: true,
    bio: true,
    avatarKey: true,
    isPrivate: true,
    followersCount: true,
    followingCount: true,
    dateOfBirth: true,
    usernameChangedAt: true,
    createdAt: true,
    profile: true,
};

// PATCH /users/me fields that live in the `profiles` table; the rest are on `users`.
const PROFILE_FIELDS = [
    'gender', 'country', 'state', 'city', 'qualification', 'fieldOfStudy',
    'skills', 'preferredAreas', 'availability', 'volunteeringTypes', 'showPersonalDetails',
];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

const formatDate = (d) => (d ? d.toISOString().slice(0, 10) : null);

// One shape for every profile view. `details` is null when the viewer can't see the
// account (private, not following). Gender, DOB and education are added only for the
// owner, or when the owner turned on showPersonalDetails.
const toProfile = (user, viewerId, relation, postsCount) => {
    const { followStatus, followsYou } = relation;
    const isMe = user.id === viewerId;
    const visible = canView(viewerId, user, relation);
    const p = user.profile ?? {};
    const showPersonal = isMe || Boolean(p.showPersonalDetails);

    return {
        id: user.id,
        username: user.username,
        name: user.name,
        bio: user.bio,
        avatarUrl: storage.urlFor(user.avatarKey),
        isPrivate: user.isPrivate,
        followersCount: user.followersCount,
        followingCount: user.followingCount,
        postsCount,
        createdAt: user.createdAt,
        isMe,
        followStatus: isMe ? null : followStatus,
        followsYou: isMe ? false : followsYou,
        canViewContent: visible,
        details: visible
            ? {
                  country: p.country ?? null,
                  state: p.state ?? null,
                  city: p.city ?? null,
                  skills: p.skills ?? [],
                  preferredAreas: p.preferredAreas ?? [],
                  availability: p.availability ?? [],
                  volunteeringTypes: p.volunteeringTypes ?? [],
                  ...(showPersonal && {
                      gender: p.gender ?? null,
                      dateOfBirth: formatDate(user.dateOfBirth),
                      qualification: p.qualification ?? null,
                      fieldOfStudy: p.fieldOfStudy ?? null,
                  }),
              }
            : null,
    };
};

const SELF = { followStatus: null, followsYou: false };

// The owner counts every post (incl. under review); others only approved ones.
const countPosts = (userId, isMe) => prisma.post.count({ where: { authorId: userId, ...(!isMe && { status: 'APPROVED' }) } });

// ---------- own profile ----------

const getMe = async (userId) => {
    const [user, pendingRequestsCount, postsCount, impactSummary] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT }),
        prisma.followRequest.count({ where: { targetId: userId, requester: { status: 'ACTIVE' } } }),
        countPosts(userId, true),
        impact.summaryFor(userId),
    ]);
    const nextChange = user.usernameChangedAt && new Date(user.usernameChangedAt.getTime() + env.USERNAME_CHANGE_COOLDOWN_DAYS * DAY_MS);

    return {
        ...toProfile(user, userId, SELF, postsCount),
        impact: impactSummary,
        showPersonalDetails: Boolean(user.profile?.showPersonalDetails),
        pendingRequestsCount,
        usernameChangeAvailableAt: nextChange && nextChange > new Date() ? nextChange : null,
    };
};

// One endpoint for the whole edit screen: send only the fields that changed.
// Going from private to public approves every pending follow request.
const updateMe = async (userId, data) => {
    const userData = pick(data, ['name', 'bio', 'isPrivate', 'dateOfBirth']);
    const profileData = pick(data, PROFILE_FIELDS);

    await prisma.$transaction(async (tx) => {
        const before = await tx.user.findUnique({ where: { id: userId }, select: { isPrivate: true } });
        if (Object.keys(userData).length) {
            await tx.user.update({ where: { id: userId }, data: userData, select: { id: true } });
        }
        if (Object.keys(profileData).length) {
            await tx.profile.upsert({ where: { userId }, create: { userId, ...profileData }, update: profileData });
        }
        if (before.isPrivate && userData.isPrivate === false) await acceptAllRequests(tx, userId);
    });

    return getMe(userId);
};

// Limited to once per USERNAME_CHANGE_COOLDOWN_DAYS, so a handle can't be flipped
// around to confuse followers or squat names.
const changeUsername = async (userId, { username }, ctx) => {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, usernameChangedAt: true } });
    if (username === user.username) {
        throw new AppError('This is already your username', 400, undefined, 'USERNAME_UNCHANGED');
    }
    const nextChange = user.usernameChangedAt && new Date(user.usernameChangedAt.getTime() + env.USERNAME_CHANGE_COOLDOWN_DAYS * DAY_MS);
    if (nextChange && nextChange > new Date()) {
        throw new AppError(
            `You can change your username again on ${nextChange.toDateString()}`,
            429,
            [{ field: 'username', message: `available again at ${nextChange.toISOString()}` }],
            'USERNAME_CHANGE_TOO_SOON',
        );
    }

    try {
        await prisma.user.update({ where: { id: userId }, data: { username, usernameChangedAt: new Date() }, select: { id: true } });
    } catch (err) {
        if (err.code === 'P2002') throw new AppError('This username is taken', 409, undefined, 'USERNAME_TAKEN');
        throw err;
    }
    audit.record(audit.EVENTS.USERNAME_CHANGED, { userId, ctx, metadata: { from: user.username, to: username } });
    return getMe(userId);
};

// The new file is written before the DB points at it, and the old one is deleted
// after, so a crash never leaves a profile pointing at a missing image.
const setAvatar = async (userId, file) => {
    const image = await toAvatar(file.buffer);
    const key = `avatars/${crypto.randomUUID()}.webp`;
    await storage.save(key, image);

    const { avatarKey: oldKey } = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    await prisma.user.update({ where: { id: userId }, data: { avatarKey: key }, select: { id: true } });
    if (oldKey) storage.remove(oldKey).catch((err) => console.error('[storage] could not delete', oldKey, err.message));

    return { avatarUrl: storage.urlFor(key) };
};

const removeAvatar = async (userId) => {
    const { avatarKey } = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } });
    if (!avatarKey) return;
    await prisma.user.update({ where: { id: userId }, data: { avatarKey: null }, select: { id: true } });
    storage.remove(avatarKey).catch((err) => console.error('[storage] could not delete', avatarKey, err.message));
};

// ---------- other people ----------

// Someone who blocked you is a 404 (findActiveUser). Someone you blocked shows with
// blockedByMe: true and no content, so the app can offer "Unblock".
const getProfile = async (viewerId, idOrUsername) => {
    const user = await findActiveUser(idOrUsername, { viewerId, select: PROFILE_SELECT });
    if (user.id === viewerId) return getMe(viewerId);
    const [rel, postsCount, muted, impactSummary] = await Promise.all([
        relationsFor(viewerId, [user.id]),
        countPosts(user.id, false),
        prisma.mute.count({ where: { muterId: viewerId, mutedId: user.id } }),
        impact.summaryFor(user.id),
    ]);
    const relation = rel(user.id);
    return {
        ...toProfile(user, viewerId, relation, relation.blockedByMe ? 0 : postsCount),
        // Public totals, like the follower counts (impactService); none across a block.
        impact: relation.blockedByMe ? null : impactSummary,
        blockedByMe: relation.blockedByMe,
        mutedByMe: muted > 0,
    };
};

module.exports = { getMe, updateMe, changeUsername, setAvatar, removeAvatar, getProfile };
